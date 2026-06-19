import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import {
  SUPERADMIN_PERMISSION,
  canAccessUser,
  requiresSuperadminForSharedTarget,
  resolveOrgScope,
  userHasMembershipInOrg,
  userHasMembershipOutsideOrg,
  userIsGlobalSuperuser,
} from "@/lib/admin/access-scope.server";

/**
 * DB-BACKED integration tests (review F1).
 *
 * Unlike tests/integration/* (which Proxy-mock the DB and only assert
 * control-flow), these run the access-scope SQL against a REAL Postgres and
 * verify the tenant-isolation invariants that ADR-0001 hangs on — the queries,
 * not the mock. They are excluded from the default `pnpm test` run and driven
 * by `pnpm test:db` (vitest.db.config.ts) against the CI postgres service /
 * a local dev DB with migrations applied.
 *
 * All fixtures use a `__dbtest_` prefix and are created/torn down here, so the
 * suite is self-contained and leaves no residue (no dependency on a seed).
 */
const PREFIX = "__dbtest_";

async function cleanup(): Promise<void> {
  // Child → parent, respecting FKs. The shared `superuser` permission row is
  // global and intentionally left in place.
  await db
    .deleteFrom("app_user_roles")
    .where("app_user_id", "in", (eb) =>
      eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "in", (eb) =>
      eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(slug: string, name: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug, name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newUser(name: string): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_${name}`,
      primary_email: `${PREFIX}${name}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addMembership(appUserId: string, organizationId: string): Promise<void> {
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: appUserId, status: "active" })
    .execute();
}

const ids = {
  orgA: "",
  orgB: "",
  userSolo: "", // member of orgA only
  userShared: "", // member of orgA AND orgB (cross-tenant)
  userOrgB: "", // member of orgB only
  userSuper: "", // member of orgA, holds the superuser marker via a role
};

beforeAll(async () => {
  await cleanup();

  ids.orgA = await newOrg(`${PREFIX}org_a`, "DBTest Org A");
  ids.orgB = await newOrg(`${PREFIX}org_b`, "DBTest Org B");

  ids.userSolo = await newUser("solo");
  ids.userShared = await newUser("shared");
  ids.userOrgB = await newUser("orgb");
  ids.userSuper = await newUser("super");

  await addMembership(ids.userSolo, ids.orgA);
  await addMembership(ids.userShared, ids.orgA);
  await addMembership(ids.userShared, ids.orgB);
  await addMembership(ids.userOrgB, ids.orgB);
  await addMembership(ids.userSuper, ids.orgA);

  // Give userSuper the superuser marker via an orgA role.
  await db
    .insertInto("app_permissions")
    .values({ key: SUPERADMIN_PERMISSION, description: "superuser marker" })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  const superPerm = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", SUPERADMIN_PERMISSION)
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: ids.orgA, key: `${PREFIX}super`, name: "DBTest Super" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: superPerm.id })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: ids.userSuper, organization_id: ids.orgA, role_id: role.id })
    .execute();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

const orgAAdmin = () => ({
  permissions: ["admin.users.read", "admin.users.manage"],
  organizationId: ids.orgA,
});
const superadmin = () => ({ permissions: [SUPERADMIN_PERMISSION], organizationId: null });

describe("access-scope (DB-backed)", () => {
  it("resolveOrgScope: org admin is confined to their org; superadmin sees all", () => {
    expect(resolveOrgScope(orgAAdmin())).toEqual({ kind: "org", organizationId: ids.orgA });
    expect(resolveOrgScope(superadmin())).toEqual({ kind: "all" });
  });

  it("userHasMembershipInOrg reflects the real membership rows", async () => {
    expect(await userHasMembershipInOrg(ids.userSolo, ids.orgA)).toBe(true);
    expect(await userHasMembershipInOrg(ids.userSolo, ids.orgB)).toBe(false);
  });

  it("canAccessUser enforces tenant isolation for an org admin", async () => {
    expect(await canAccessUser(orgAAdmin(), ids.userSolo)).toBe(true);
    // The cross-tenant invariant: an orgA admin cannot reach an orgB-only user.
    expect(await canAccessUser(orgAAdmin(), ids.userOrgB)).toBe(false);
  });

  it("canAccessUser lets a superadmin reach a user in any org", async () => {
    expect(await canAccessUser(superadmin(), ids.userOrgB)).toBe(true);
  });

  it("userHasMembershipOutsideOrg detects cross-tenant sharing", async () => {
    expect(await userHasMembershipOutsideOrg(ids.userSolo, ids.orgA)).toBe(false);
    expect(await userHasMembershipOutsideOrg(ids.userShared, ids.orgA)).toBe(true);
  });

  it("requiresSuperadminForSharedTarget gates account-global actions (AUTHZ-2)", async () => {
    const scope = { kind: "org" as const, organizationId: ids.orgA };
    expect(await requiresSuperadminForSharedTarget(scope, ids.userShared)).toBe(true);
    expect(await requiresSuperadminForSharedTarget(scope, ids.userSolo)).toBe(false);
    expect(await requiresSuperadminForSharedTarget({ kind: "all" }, ids.userShared)).toBe(false);
  });

  it("userIsGlobalSuperuser is true only for a user holding the marker via an active membership", async () => {
    expect(await userIsGlobalSuperuser(ids.userSuper)).toBe(true);
    expect(await userIsGlobalSuperuser(ids.userSolo)).toBe(false);
  });
});
