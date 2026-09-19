import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GrantableModule from "@/lib/admin/grantable-permissions.server";

/**
 * IMP-2 — `permissionKeysByActiveOrg`, the data source behind the PER-TENANT
 * rank bound on `POST /api/administrator/users/[id]/impersonate`.
 *
 * The bound it feeds is "for every org both parties are active members of, the
 * target holds nothing there the actor does not also hold there". Three
 * properties have to hold or that bound is unsound:
 *
 *   1. AN ORG WITH NO ROLES MAPS TO AN EMPTY SET, not to a missing key. The
 *      comparison reads a missing key as "not a shared tenant, so not my
 *      business" — the confinement handles those. An active membership with no
 *      roles is the OPPOSITE case and is exactly the attacker's position: the
 *      impersonator is an ordinary member of the tenant where the target is an
 *      admin. Dropping it re-opens the pivot with every test still green.
 *   2. THE SEED IS THE MEMBERSHIP TABLE, filtered to `status = 'active'` — a
 *      suspended member acts in no tenant, so they must not appear.
 *   3. PERMISSION ROWS OUTSIDE THE SEED ARE DROPPED. A role left attached in a
 *      tenant the user was removed from grants nothing there and must not
 *      create an entry (which would read as a shared tenant that is not one).
 *
 * The builders are driven against a recording Kysely stub keyed by table, so
 * the two statements can answer differently; the union's LEFT side is the one
 * whose `.execute()` runs.
 */

interface Recorded {
  table: string;
  wheres: unknown[][];
}

const recorded: Recorded[] = [];
/** Rows each `selectFrom(table)…execute()` resolves with. */
let rowsByTable: Record<string, Record<string, unknown>[]> = {};

function chain(table: string): unknown {
  const q: Recorded = { table, wheres: [] };
  recorded.push(q);
  const builder: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "execute") return async () => rowsByTable[table] ?? [];
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

const MEMBERSHIPS = "app_organization_memberships";
const DIRECT = "app_user_roles as ur";

let mod: typeof GrantableModule;

beforeEach(async () => {
  recorded.length = 0;
  rowsByTable = {};
  mod = await import("@/lib/admin/grantable-permissions.server");
});
afterEach(() => vi.resetModules());

describe("permissionKeysByActiveOrg", () => {
  it("keys the map by ACTIVE membership and an org with no roles maps to an EMPTY set", async () => {
    // The attacker's exact shape: an active member of org-b holding nothing
    // there. `o-b -> {}` and "o-b absent" must not be confused — the first is a
    // shared tenant where the target may hold nothing, the second is a tenant
    // the confinement already makes unreachable.
    rowsByTable[MEMBERSHIPS] = [{ organization_id: "o-a" }, { organization_id: "o-b" }];
    rowsByTable[DIRECT] = [{ organization_id: "o-a", key: "admin.roles.update" }];

    const byOrg = await mod.permissionKeysByActiveOrg("u-actor");

    expect([...byOrg.keys()].sort()).toEqual(["o-a", "o-b"]);
    expect(byOrg.get("o-a")).toEqual(new Set(["admin.roles.update"]));
    expect(byOrg.get("o-b")).toEqual(new Set());
    expect(byOrg.has("o-c")).toBe(false);
  });

  it("seeds ONLY from the user's ACTIVE memberships", async () => {
    rowsByTable[MEMBERSHIPS] = [{ organization_id: "o-a" }];
    await mod.permissionKeysByActiveOrg("u-actor");

    const seed = recorded.find((q) => q.table === MEMBERSHIPS);
    expect(seed?.wheres).toEqual([
      ["app_user_id", "=", "u-actor"],
      ["status", "=", "active"],
    ]);
  });

  it("drops permission rows whose org is not an active membership", async () => {
    // A role still attached in a tenant the user was removed from. It grants
    // nothing there, and inventing an entry for it would make an unshared
    // tenant look shared.
    rowsByTable[MEMBERSHIPS] = [{ organization_id: "o-a" }];
    rowsByTable[DIRECT] = [
      { organization_id: "o-a", key: "shell.view" },
      { organization_id: "o-gone", key: "superuser" },
    ];

    const byOrg = await mod.permissionKeysByActiveOrg("u-actor");

    expect([...byOrg.keys()]).toEqual(["o-a"]);
    expect(byOrg.get("o-a")).toEqual(new Set(["shell.view"]));
  });

  it("deduplicates keys conferred by both a direct role and a group", async () => {
    rowsByTable[MEMBERSHIPS] = [{ organization_id: "o-a" }];
    rowsByTable[DIRECT] = [
      { organization_id: "o-a", key: "shell.view" },
      { organization_id: "o-a", key: "shell.view" },
      { organization_id: "o-a", key: "admin.users.read" },
    ];

    const byOrg = await mod.permissionKeysByActiveOrg("u-actor");

    expect(byOrg.get("o-a")).toEqual(new Set(["shell.view", "admin.users.read"]));
  });

  it("returns an empty map and runs NO permission query for a member of nothing", async () => {
    rowsByTable[MEMBERSHIPS] = [];

    const byOrg = await mod.permissionKeysByActiveOrg("u-nobody");

    expect(byOrg.size).toBe(0);
    // Not just an optimization: an unfiltered permission query here would be
    // the only statement in the pair, and its rows would have nowhere safe to
    // land. (It also keeps an empty `in ()` out of the SQL.)
    expect(recorded.map((q) => q.table)).toEqual([MEMBERSHIPS]);
  });

  it("filters the permission halves on the USER only — the seed is what bounds the org", async () => {
    rowsByTable[MEMBERSHIPS] = [{ organization_id: "o-a" }];
    await mod.permissionKeysByActiveOrg("u-actor");

    const direct = recorded.find((q) => q.table === DIRECT);
    const group = recorded.find((q) => q.table === "app_group_memberships as gm");
    expect(direct?.wheres).toEqual([["ur.app_user_id", "=", "u-actor"]]);
    expect(group?.wheres).toEqual([["gm.app_user_id", "=", "u-actor"]]);
    // An `organization_id = …` predicate here would collapse the map to one
    // tenant and turn the per-tenant bound back into the single-org check the
    // whole finding is about.
    const permissionWhereColumns = [direct, group]
      .flatMap((q) => q?.wheres ?? [])
      .map((w) => String(w[0]));
    expect(permissionWhereColumns.some((c) => c.endsWith("organization_id"))).toBe(false);
  });
});
