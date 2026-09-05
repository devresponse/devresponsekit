import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers `agents.server.ts` with a proxied DB + mocked org-scope resolver:
 * the paged agent list (review #13: envelope, pending count, status filter
 * parsing), the single-agent lookup, and pending service-account
 * activation. The SQL itself is verified against a live database in
 * `tests/db/mcp-agents-list.db.test.ts`; this file pins the module contract.
 */
const resolveOrgScope = vi.fn();

const dbState = vi.hoisted(() => ({
  execute: [] as unknown[],
  takeFirst: undefined as unknown,
  calls: [] as string[],
}));
function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") return () => Promise.resolve(dbState.execute);
      if (prop === "executeTakeFirst") return () => Promise.resolve(dbState.takeFirst);
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
        dbState.calls.push(String(prop));
        for (const a of args) {
          if (typeof a === "function") {
            const jb: unknown = new Proxy(() => ({}), { get: () => () => jb, apply: () => jb });
            try {
              (a as (b: unknown) => unknown)(jb);
            } catch {
              /* join-builder stub */
            }
          }
        }
        return chain();
      };
    },
    apply() {
      return chain();
    },
  });
}

vi.mock("@/db/database", () => ({ db: chain() }));
vi.mock("@/lib/admin/access-scope.server", () => ({
  resolveOrgScope: (...a: unknown[]) => resolveOrgScope(...a),
}));

import {
  activateMcpAgent,
  getMcpAgent,
  listMcpAgents,
  mcpAgentStatusFilter,
  parseMcpAgentListQuery,
} from "@/lib/mcp/agents.server";

const access = { permissions: [] } as never;
const q = (qs = "") => parseMcpAgentListQuery(new URLSearchParams(qs));

beforeEach(() => {
  dbState.execute = [];
  dbState.takeFirst = undefined;
  dbState.calls = [];
  resolveOrgScope.mockReset().mockReturnValue({ kind: "all" });
});

describe("parseMcpAgentListQuery (review #13)", () => {
  it("defaults to page 1 / 25 rows / newest first, no filter", () => {
    const query = q();
    expect(query).toMatchObject({ page: 1, pageSize: 25 });
    expect(query.sort).toEqual([{ field: "created_at", direction: "desc" }]);
    expect(mcpAgentStatusFilter(query)).toBeNull();
  });

  it("accepts page/pageSize/sort/filter[status] and caps the page size at 200", () => {
    const query = q("page=3&pageSize=999&sort=name.asc&filter[status]=pending");
    expect(query).toMatchObject({ page: 3, pageSize: 200 });
    expect(query.sort).toEqual([{ field: "name", direction: "asc" }]);
    expect(mcpAgentStatusFilter(query)).toBe("pending");
  });

  it("drops an unknown status value / sort field / filter key (never 400s, never leaks into SQL)", () => {
    const query = q("filter[status]=DROP%20TABLE&sort=email.desc&filter[email]=x");
    // The parser keeps the raw allow-listed key; the VALUE is validated here,
    // so an unrecognised status never becomes a predicate (→ "All").
    expect(mcpAgentStatusFilter(query)).toBeNull();
    expect(query.sort).toEqual([{ field: "created_at", direction: "desc" }]);
    expect(Object.keys(query.filters)).toEqual(["status"]);
  });
});

describe("agents.server", () => {
  it("returns an empty envelope when the caller has no org scope", async () => {
    resolveOrgScope.mockReturnValue(null);
    expect(await listMcpAgents(access, q("page=2"))).toEqual({
      items: [],
      page: 2,
      pageSize: 25,
      total: 0,
      sort: [{ field: "created_at", direction: "desc" }],
      pendingCount: 0,
    });
    expect(await getMcpAgent(access, "id")).toBeUndefined();
    expect(dbState.calls).toEqual([]); // nothing queried
  });

  it("lists a page for an org-scoped caller: window total stripped, scope-wide pending count", async () => {
    resolveOrgScope.mockReturnValue({ kind: "org", organizationId: "org-1" });
    dbState.execute = [
      {
        clientRowId: "c1",
        clientId: "drkc_x",
        name: "A",
        scopes: [],
        status: "pending",
        __total: "42",
      },
      {
        clientRowId: "c2",
        clientId: "drkc_y",
        name: "B",
        scopes: [],
        status: "active",
        __total: "42",
      },
    ];
    dbState.takeFirst = { count: "7" };
    const result = await listMcpAgents(access, q("page=2&pageSize=2"));
    expect(result.items.map((i) => i.clientId)).toEqual(["drkc_x", "drkc_y"]);
    expect(result.items[0]).not.toHaveProperty("__total");
    expect(result).toMatchObject({ page: 2, pageSize: 2, total: 42, pendingCount: 7 });
    // Org admins are confined by a WHERE on the org; paging applies limit/offset.
    expect(dbState.calls).toEqual(expect.arrayContaining(["where", "limit", "offset", "orderBy"]));
  });

  it("applies a status filter as an extra WHERE (and still reports the unfiltered pending count)", async () => {
    dbState.execute = [];
    dbState.takeFirst = { count: "3" };
    const unfilteredWheres = async () => {
      dbState.calls = [];
      await listMcpAgents(access, q());
      return dbState.calls.filter((c) => c === "where").length;
    };
    const filteredWheres = async () => {
      dbState.calls = [];
      await listMcpAgents(access, q("filter[status]=revoked"));
      return dbState.calls.filter((c) => c === "where").length;
    };
    expect(await filteredWheres()).toBe((await unfilteredWheres()) + 1);
    const result = await listMcpAgents(access, q("filter[status]=revoked"));
    expect(result.total).toBe(0);
    expect(result.pendingCount).toBe(3);
  });

  it("resolves a single agent by client row id", async () => {
    dbState.takeFirst = {
      clientRowId: "c1",
      appUserId: "u1",
      organizationId: "o1",
      clientStatus: "active",
    };
    const agent = await getMcpAgent(access, "c1");
    expect(agent?.appUserId).toBe("u1");
  });

  it("activates a pending service account (true when a row flipped) and cascades to the membership", async () => {
    dbState.takeFirst = { numUpdatedRows: 1 };
    expect(await activateMcpAgent("u1")).toBe(true);
    expect(dbState.calls.filter((c) => c === "updateTable")).toHaveLength(2);
  });

  it("does NOT touch the membership when the user row did not flip (lost to Approve/reaper race)", async () => {
    dbState.takeFirst = { numUpdatedRows: 0 };
    expect(await activateMcpAgent("u1")).toBe(false);
    expect(dbState.calls.filter((c) => c === "updateTable")).toHaveLength(1);
  });
});
