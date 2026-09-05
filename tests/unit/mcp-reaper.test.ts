import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit contract for the stale-registration reaper (review #13, #51) with the
 * DB proxied: the TTL-0 kill switch, and the "cascade only what we flipped"
 * ordering — the user UPDATE runs first and the membership/client UPDATEs run
 * only for the ids it returned (that is what makes the Approve race safe).
 * The SQL itself is verified live in `tests/db/mcp-registration-reaper.db.test.ts`.
 */
const state = vi.hoisted(() => ({
  flipped: [] as Array<{ id: string }>,
  tables: [] as string[],
  wheres: [] as unknown[][],
  transactions: 0,
}));

function chain(table: string): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (prop === "execute") {
        // The users UPDATE carries `.returning("id")` and yields the flipped ids;
        // the cascades yield nothing of interest.
        return () => Promise.resolve(table === "app_users" ? state.flipped : []);
      }
      return (...args: unknown[]) => {
        if (prop === "where") state.wheres.push([table, ...args]);
        for (const a of args) {
          if (typeof a === "function") {
            const eb: unknown = new Proxy(() => ({}), { get: () => () => eb, apply: () => eb });
            try {
              (a as (b: unknown) => unknown)(eb);
            } catch {
              /* expression-builder stub */
            }
          }
        }
        return chain(table);
      };
    },
    apply() {
      return chain(table);
    },
  });
}

vi.mock("@/db/database", () => ({
  db: {
    transaction: () => ({
      execute: (fn: (trx: unknown) => Promise<unknown>) => {
        state.transactions += 1;
        return fn({
          updateTable: (table: string) => {
            state.tables.push(table);
            return chain(table);
          },
        });
      },
    }),
  },
}));

import {
  expireStalePendingMcpRegistrations,
  MCP_EXPIRED_REGISTRATION_REASON,
} from "@/lib/mcp/reaper.server";

beforeEach(() => {
  state.flipped = [];
  state.tables = [];
  state.wheres = [];
  state.transactions = 0;
});

describe("expireStalePendingMcpRegistrations", () => {
  it("a TTL of 0 (or less) disables the sweep without opening a transaction", async () => {
    expect(await expireStalePendingMcpRegistrations(0)).toEqual({ expired: 0, ttlDays: 0 });
    expect(await expireStalePendingMcpRegistrations(-3)).toEqual({ expired: 0, ttlDays: -3 });
    expect(state.transactions).toBe(0);
  });

  it("flips users FIRST and skips the cascades when nothing flipped", async () => {
    state.flipped = [];
    expect(await expireStalePendingMcpRegistrations(7)).toEqual({ expired: 0, ttlDays: 7 });
    expect(state.transactions).toBe(1);
    expect(state.tables).toEqual(["app_users"]);
  });

  it("cascades to memberships and clients ONLY for the users it flipped, in one transaction", async () => {
    state.flipped = [{ id: "u1" }, { id: "u2" }];
    expect(await expireStalePendingMcpRegistrations(7)).toEqual({ expired: 2, ttlDays: 7 });
    expect(state.transactions).toBe(1);
    expect(state.tables).toEqual([
      "app_users",
      "app_organization_memberships",
      "app_oauth_clients",
    ]);
    // Both cascades are keyed on exactly the flipped ids.
    const inClauses = state.wheres.filter(([, col, op]) => col === "app_user_id" && op === "in");
    expect(inClauses.map(([table, , , ids]) => [table, ids])).toEqual([
      ["app_organization_memberships", ["u1", "u2"]],
      ["app_oauth_clients", ["u1", "u2"]],
    ]);
    // The user flip is guarded by the pending predicate (the Approve race).
    expect(state.wheres).toContainEqual(["app_users", "status", "=", "pending_approval"]);
  });

  it("exports the machine-readable reason stamped on expired accounts", () => {
    expect(MCP_EXPIRED_REGISTRATION_REASON).toBe("mcp_registration_expired");
  });
});
