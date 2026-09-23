import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";

/**
 * REVOKE-2 (review #444) — compiles `activeGlobalSuperuserGrants` through a
 * REAL Kysely query compiler (dummy driver, nothing executes) and pins the
 * `FOR UPDATE OF` relation list.
 *
 * Why a whole file for one clause: the row lock is the ONLY thing that keeps
 * two concurrent revocations aimed at two different superadmins from each
 * concluding that the other survives, and its correctness turns entirely on
 * WHICH relations it names. Under READ COMMITTED a blocked
 * `SELECT … FOR UPDATE` re-evaluates its predicate (EvalPlanQual) only for rows
 * of a LOCKED relation that the committing transaction actually updated or
 * deleted; Postgres explicitly does not show it that transaction's effects on
 * other tables. Of the guarded paths only the role-assignment revoke writes
 * `app_user_roles` — the membership routes and the account-lifecycle cascades
 * write `app_organization_memberships`, and the permission strip writes
 * `app_role_permissions`. With `for update of "app_user_roles"` alone the second
 * caller blocks, acquires the lock on an UNMODIFIED assignment tuple, skips the
 * recheck, and still evaluates the joins against its own pre-commit snapshot —
 * in which the other superadmin's membership is still `active`. The lock looks
 * present, the guarantee is absent, and no mocked-builder test can see the
 * difference because none of them compile.
 *
 * `app_permissions` is deliberately NOT locked: it is a static catalog.
 */
const captured: string[] = [];

vi.mock("@/db/database", () => {
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === "query") captured.push(event.query.sql);
    },
  });
  return { db, pgPool: { query: async () => ({ rows: [] }), end: async () => {} } };
});

let mod: typeof AccessScopeModule;

beforeEach(async () => {
  captured.length = 0;
  mod = await import("@/lib/admin/access-scope.server");
});
afterEach(() => vi.resetModules());

describe("activeGlobalSuperuserGrants — compiled SQL", () => {
  it("locks every MUTABLE relation the grant join depends on", async () => {
    await mod.activeGlobalSuperuserGrants();

    expect(captured).toHaveLength(1);
    const sql = captured[0]!;
    // `app_organizations` joined the list with F-09: the grant join now reads
    // the ORGANIZATION's status, and `PATCH /organizations/[id]` is a guarded
    // path that writes it.
    expect(sql).toContain(
      'for update of "app_user_roles", "app_organization_memberships", "app_organizations", "app_role_permissions"',
    );
    // The assignment table alone is exactly the shape that does NOT deliver the
    // guarantee — pin that it is not what we emit.
    expect(sql).not.toMatch(/for update of "app_user_roles"\s*$/);
    // The catalog is not locked.
    expect(sql.slice(sql.indexOf("for update"))).not.toContain("app_permissions");
  });

  it("still joins through an ACTIVE membership — the row that makes an assignment count", async () => {
    await mod.activeGlobalSuperuserGrants();
    const sql = captured[0]!;
    expect(sql).toContain('inner join "app_organization_memberships"');
    expect(sql).toContain('"app_organization_memberships"."status" =');
    expect(sql).toContain('inner join "app_role_permissions"');
    expect(sql).toContain('inner join "app_permissions"');
  });

  it("F-09: counts only grants held in an ACTIVE organization — the same set userIsGlobalSuperuser reports", async () => {
    await mod.activeGlobalSuperuserGrants();
    const sql = captured[0]!;
    expect(sql).toContain(
      'inner join "app_organizations" on "app_organizations"."id" = "app_organization_memberships"."organization_id" and "app_organizations"."status" = $',
    );
  });
});

/**
 * F-09 — superuser AUTHORITY follows the organization's status; superuser RANK
 * does not. Compiled through the real query compiler so the predicate is seen
 * where it matters (the join condition), not on a mocked builder.
 */
describe("superuser predicates — organization status (F-09)", () => {
  const ORG_ACTIVE_JOIN =
    'inner join "app_organizations" as "o" on "o"."id" = "m"."organization_id" and "o"."status" = $';

  it("userIsGlobalSuperuser requires the grant's organization to be ACTIVE", async () => {
    await mod.userIsGlobalSuperuser("u-1");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(ORG_ACTIVE_JOIN);
  });

  it("betterAuthUserIsGlobalSuperuser (the impersonation-reach probe) requires it too", async () => {
    await mod.betterAuthUserIsGlobalSuperuser("ba-1");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(ORG_ACTIVE_JOIN);
  });

  it("userHoldsSuperuserGrant (the RANK twin) deliberately does NOT read the org's status", async () => {
    await mod.userHoldsSuperuserGrant("u-1");
    expect(captured).toHaveLength(1);
    const sql = captured[0]!;
    // Same membership join as its authority twin…
    expect(sql).toContain('inner join "app_organization_memberships" as "m"');
    expect(sql).toContain('"m"."status" = $');
    // …and no organization join at all: a grant asleep in a suspended tenant
    // still outranks a delegated admin.
    expect(sql).not.toContain('"app_organizations"');
  });
});
