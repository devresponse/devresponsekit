import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * DB-BACKED test for F-65: the /app/account overview of an IMPERSONATED session
 * lists only the organizations the impersonator can reach.
 *
 * `getAccountOverview` read every membership and every directly assigned role
 * of the user with no organization filter. During an impersonation the user is
 * the borrowed identity, so an org-A admin impersonating a member of A who also
 * belongs to org C saw C's name, the membership status there and the names of
 * the roles held there. The IMP-1 confinement keeps the session itself out of
 * C; the overview did not apply it.
 *
 * Runs the REAL query and the REAL reach helper (`listImpersonationReachableOrgIds`,
 * whose superuser probe reads Postgres) against live Postgres, via `pnpm test:db`
 * (vitest.db.config.ts). Only the Better Auth ban probe is stubbed. Fixtures use
 * the `__dbtest_f65_` prefix and self-clean.
 */
const PREFIX = "__dbtest_f65_";

// The reach asks Better Auth whether the impersonator is banned; nobody is
// here, and it keeps the Better Auth instance out of this suite.
vi.mock("@/lib/api-auth/ban-status.server", () => ({ isBetterAuthUserBanned: async () => false }));

const { db, pgPool } = await import("@/db/database");
const { getAccountOverview } = await import("@/app/[locale]/(secure)/app/account/_data.server");
const { listImpersonationReachableOrgIds } = await import("@/lib/impersonation-reach.server");

async function cleanup(): Promise<void> {
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
  }
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  if (userIds.length > 0) {
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(key: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}`, name: `DBTest F65 ${key}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newUser(key: string): Promise<{ id: string; ba: string }> {
  const ba = `${PREFIX}ba_${key}`;
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: ba,
      primary_email: `${PREFIX}${key}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, ba };
}

async function addMember(appUserId: string, organizationId: string, status = "active") {
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: appUserId, status })
    .execute();
}

async function grantRole(appUserId: string, organizationId: string, key: string, name: string) {
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: organizationId, key: `${PREFIX}${key}`, name })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: appUserId, organization_id: organizationId, role_id: role.id })
    .execute();
}

let orgA: string;
let orgC: string;
let target: { id: string; ba: string };
let admin: { id: string; ba: string };

beforeAll(async () => {
  await cleanup();
  orgA = await newOrg("a");
  orgC = await newOrg("c");
  // The target belongs to both tenants and holds a role in each. The admin
  // belongs to A only, so C is outside the admin's reach.
  target = await newUser("target");
  admin = await newUser("admin");
  await addMember(target.id, orgA);
  await addMember(target.id, orgC, "suspended");
  await addMember(admin.id, orgA);
  await grantRole(target.id, orgA, "role_a", "DBTest F65 Reviewer");
  await grantRole(target.id, orgC, "role_c", "DBTest F65 Acme-M&A-Review");
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("getAccountOverview — organizations shown (F-65)", () => {
  it("under impersonation, shows nothing from a tenant the impersonator cannot reach", async () => {
    const reach = await listImpersonationReachableOrgIds(admin.ba);
    expect(reach).toEqual([orgA]);

    const overview = await getAccountOverview(target.id, reach);

    expect(overview?.memberships.map((m) => m.organizationId)).toEqual([orgA]);
    expect(overview?.roles).toEqual(["DBTest F65 Reviewer"]);
    // Not the org's name, not the membership status there, not the role name.
    expect(JSON.stringify(overview)).not.toMatch(/DBTest F65 c|suspended|Acme-M&A-Review/);
  });

  it("shows every membership and role otherwise (null: an ordinary or superadmin session)", async () => {
    const overview = await getAccountOverview(target.id, null);

    expect(overview?.memberships.map((m) => [m.organizationId, m.status])).toEqual(
      expect.arrayContaining([
        [orgA, "active"],
        [orgC, "suspended"],
      ]),
    );
    expect(overview?.memberships).toHaveLength(2);
    expect(overview?.roles).toEqual(["DBTest F65 Acme-M&A-Review", "DBTest F65 Reviewer"]);
  });

  it("shows no organization at all for an empty reach, and still the identity", async () => {
    const overview = await getAccountOverview(target.id, []);

    expect(overview?.primaryEmail).toBe(`${PREFIX}target@dbtest.local`);
    expect(overview?.memberships).toEqual([]);
    expect(overview?.roles).toEqual([]);
  });
});
