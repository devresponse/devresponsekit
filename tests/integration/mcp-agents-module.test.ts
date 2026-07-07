import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Covers `agents.server.ts` with a proxied DB + mocked org-scope resolver:
 * the agent-membership join list, the single-agent lookup, and pending
 * service-account activation.
 */
const resolveOrgScope = vi.fn();

const dbState = vi.hoisted(() => ({
  execute: [] as unknown[],
  takeFirst: undefined as unknown,
}));
function chain(): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "execute") return () => Promise.resolve(dbState.execute);
      if (prop === "executeTakeFirst") return () => Promise.resolve(dbState.takeFirst);
      if (prop === "then") return undefined;
      return (...args: unknown[]) => {
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

import { activateMcpAgent, getMcpAgent, listMcpAgents } from "@/lib/mcp/agents.server";

const access = { permissions: [] } as never;

beforeEach(() => {
  dbState.execute = [];
  dbState.takeFirst = undefined;
  resolveOrgScope.mockReset().mockReturnValue({ kind: "all" });
});

describe("agents.server", () => {
  it("returns nothing when the caller has no org scope", async () => {
    resolveOrgScope.mockReturnValue(null);
    expect(await listMcpAgents(access)).toEqual([]);
    expect(await getMcpAgent(access, "id")).toBeUndefined();
  });

  it("lists agents for an org-scoped caller", async () => {
    resolveOrgScope.mockReturnValue({ kind: "org", organizationId: "org-1" });
    dbState.execute = [{ clientRowId: "c1", clientId: "drkc_x", name: "A", scopes: [] }];
    const rows = await listMcpAgents(access);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe("drkc_x");
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

  it("activates a pending service account (true when a row flipped)", async () => {
    dbState.takeFirst = { numUpdatedRows: 1 };
    expect(await activateMcpAgent("u1")).toBe(true);
    dbState.takeFirst = { numUpdatedRows: 0 };
    expect(await activateMcpAgent("u1")).toBe(false);
  });
});
