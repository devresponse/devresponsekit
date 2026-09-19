import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GrantableModule from "@/lib/admin/grantable-permissions.server";

/**
 * IMP-1 — `permissionKeysHeldInAnyOrg`, the data source behind the widened
 * impersonation escalation guard.
 *
 * Two properties have to hold or the guard is unsound:
 *
 *   1. NO ORGANIZATION PREDICATE. The whole point is that it spans every
 *      tenant — an `organization_id = …` filter would silently restore the
 *      single-org check the fix replaced, and every behavioural test would
 *      still pass.
 *   2. AN ACTIVE-MEMBERSHIP JOIN on BOTH halves of the union. A role still
 *      attached in a tenant the user is suspended from grants them nothing
 *      there, so counting it would refuse impersonations that are actually
 *      fine — and, worse, it is exactly the kind of drift nobody notices.
 *
 * The builder is driven against a recording Kysely stub; the union's left side
 * is the one whose `.execute()` runs, so the recorder captures both builders
 * and the assertions look at the whole set.
 */

interface Recorded {
  table: string;
  joins: unknown[][];
  wheres: unknown[][];
  /** Every `on`/`onRef` argument list seen inside a join callback. */
  joinOns: unknown[][];
}

const recorded: Recorded[] = [];
const execute = vi.fn();

function chain(table: string): unknown {
  const q: Recorded = { table, joins: [], wheres: [], joinOns: [] };
  recorded.push(q);

  /** Recorder handed to a `(join) => join.onRef(...).on(...)` callback. */
  const joinBuilder: unknown = new Proxy(
    {},
    {
      get() {
        return (...args: unknown[]) => {
          q.joinOns.push(args);
          return joinBuilder;
        };
      },
    },
  );

  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "execute") return execute;
        if (prop === "innerJoin") {
          return (...args: unknown[]) => {
            q.joins.push(args);
            for (const a of args) {
              if (typeof a === "function") (a as (j: unknown) => unknown)(joinBuilder);
            }
            return builder;
          };
        }
        if (prop === "where") {
          return (...args: unknown[]) => {
            q.wheres.push(args);
            return builder;
          };
        }
        return () => builder;
      },
    },
  );
  return builder;
}

vi.mock("@/db/database", () => ({ db: { selectFrom: (table: string) => chain(table) } }));

let mod: typeof GrantableModule;

beforeEach(async () => {
  recorded.length = 0;
  execute.mockReset();
  mod = await import("@/lib/admin/grantable-permissions.server");
});
afterEach(() => vi.resetModules());

describe("permissionKeysHeldInAnyOrg", () => {
  it("returns the deduplicated union of direct and group-conferred keys", async () => {
    execute.mockResolvedValue([
      { key: "shell.view" },
      { key: "admin.roles.update" },
      { key: "shell.view" },
    ]);
    await expect(mod.permissionKeysHeldInAnyOrg("u-target")).resolves.toEqual([
      "shell.view",
      "admin.roles.update",
    ]);
  });

  it("filters ONLY on the user — no organization predicate on either half", async () => {
    execute.mockResolvedValue([]);
    await mod.permissionKeysHeldInAnyOrg("u-target");

    const direct = recorded.find((q) => q.table === "app_user_roles as ur");
    const group = recorded.find((q) => q.table === "app_group_memberships as gm");
    expect(direct?.wheres).toEqual([["ur.app_user_id", "=", "u-target"]]);
    expect(group?.wheres).toEqual([["gm.app_user_id", "=", "u-target"]]);

    // The guard that would silently undo the fix.
    const allWhereColumns = recorded.flatMap((q) => q.wheres.map((w) => String(w[0])));
    expect(allWhereColumns.some((c) => c.endsWith("organization_id"))).toBe(false);
  });

  it("requires an ACTIVE membership in the org conferring the role, on both halves", async () => {
    execute.mockResolvedValue([]);
    await mod.permissionKeysHeldInAnyOrg("u-target");

    const direct = recorded.find((q) => q.table === "app_user_roles as ur");
    const group = recorded.find((q) => q.table === "app_group_memberships as gm");
    for (const q of [direct, group]) {
      expect(q?.joins.some((j) => j[0] === "app_organization_memberships as m")).toBe(true);
      expect(q?.joinOns).toContainEqual(["m.status", "=", "active"]);
    }
    // The membership is matched to the org that carries the role, not just to
    // the user — otherwise ANY active membership would launder every role.
    expect(direct?.joinOns).toContainEqual(["m.organization_id", "=", "ur.organization_id"]);
    expect(group?.joinOns).toContainEqual(["m.organization_id", "=", "g.organization_id"]);
  });

  it("returns [] for a user who holds nothing anywhere", async () => {
    execute.mockResolvedValue([]);
    await expect(mod.permissionKeysHeldInAnyOrg("u-nobody")).resolves.toEqual([]);
  });
});
