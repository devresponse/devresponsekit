import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";

/**
 * DB-BACKED test for F-154: one rule decides who may RECEIVE a grant, on every
 * path that writes one.
 *
 * The three admin grant routes applied three rules. `POST /users/[id]/app-roles`
 * checked no membership, so a superadmin could assign a role in an org the
 * user had never joined. `POST /users/[id]/groups` accepted a membership of
 * any status, and `POST /groups/[id]/members` only an active one, so the same
 * add succeeded from the user page and 404'd from the group page. All three
 * now ask `grantEligibleUserIds` (an ACTIVE membership in the role's or
 * group's org). Here the routes and the helper run against Postgres; only the
 * caller (a cookie session and its access context), the audit writer and the
 * rate limiter are stubbed. The invitation path is pinned in
 * organization-invitations.db.test.ts.
 *
 *   1. The helper admits an active membership in that org and nothing else:
 *      not pending, blocked or suspended, and not another org's.
 *   2. A superadmin cannot assign a role in an org the user never joined.
 *   3. An org admin who can open a pending, blocked or suspended member (reach
 *      is any status, review #210) gets the same 404 `user_not_found` from all
 *      three routes, and nothing is written.
 *   4. An active member is granted by all three.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f154_`
 * and clean up after themselves.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});
// The audit rows are not what this file tests; the grants are.
vi.mock("@/lib/audit.server", () => ({ auditEvent: vi.fn() }));
vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return { ...actual, enforceRateLimit: () => null };
});

const { db, pgPool } = await import("@/db/database");
const { grantEligibleUserIds, userIsGrantEligible } =
  await import("@/lib/admin/access-scope.server");
const appRolesRoute = await import("@/app/api/administrator/users/[id]/app-roles/route");
const userGroupsRoute = await import("@/app/api/administrator/users/[id]/groups/route");
const groupMembersRoute = await import("@/app/api/administrator/groups/[id]/members/route");

const PREFIX = "__dbtest_f154_";
const NON_ACTIVE = ["pending_approval", "blocked", "suspended"] as const;

const ids = {
  orgA: "",
  orgB: "",
  roleA: "",
  roleB: "",
  groupA: "",
  /** Active in org A only. */
  active: "",
  pending_approval: "",
  blocked: "",
  suspended: "",
};

const ADMIN_PERMISSIONS = ["admin.roles.assign", "admin.groups.assign", "admin.groups.read"];

function context(
  organizationId: string,
  permissions: string[],
): AuthStatusModule.UserAccessContext {
  return {
    appUserId: `${PREFIX}actor`,
    primaryEmail: `${PREFIX}actor@dbtest.local`,
    status: "active",
    organizationId,
    membershipStatus: "active",
    preferredLocale: "en",
    permissions,
  };
}

/** Acts as org A's delegated admin, or as a cookie superadmin (every org). */
function as(actor: "orgAdmin" | "superadmin"): void {
  sessionGetter.mockResolvedValue({ user: { id: `${PREFIX}ba_${actor}` } });
  accessGetter.mockResolvedValue(
    actor === "superadmin"
      ? context(ids.orgA, ["superuser", ...ADMIN_PERMISSIONS])
      : context(ids.orgA, ADMIN_PERMISSIONS),
  );
}

function request(method: string, path: string, body?: unknown): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function assignRole(userId: string, roleId: string, organizationId: string) {
  return appRolesRoute.POST(
    request("POST", `/api/administrator/users/${userId}/app-roles`, { roleId, organizationId }),
    params(userId),
  );
}

function addToGroupFromUserPage(userId: string) {
  return userGroupsRoute.POST(
    request("POST", `/api/administrator/users/${userId}/groups`, { groupId: ids.groupA }),
    params(userId),
  );
}

function addToGroupFromGroupPage(userId: string) {
  return groupMembersRoute.POST(
    request("POST", `/api/administrator/groups/${ids.groupA}/members`, { appUserIds: [userId] }),
    params(ids.groupA),
  );
}

async function grantsOf(userId: string) {
  const [roles, groups] = await Promise.all([
    db
      .selectFrom("app_user_roles")
      .select(["organization_id", "role_id"])
      .where("app_user_id", "=", userId)
      .execute(),
    db
      .selectFrom("app_group_memberships")
      .select("group_id")
      .where("app_user_id", "=", userId)
      .execute(),
  ]);
  return { roles, groups };
}

async function cleanup(): Promise<void> {
  const users = db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`);
  await db.deleteFrom("app_group_memberships").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_user_roles").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_organization_memberships").where("app_user_id", "in", users).execute();
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(tag: string): Promise<string> {
  return (
    await db
      .insertInto("app_organizations")
      .values({ slug: `${PREFIX}${tag}`, name: `F-154 ${tag}` })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

async function newMember(tag: string, organizationId: string, status: string): Promise<string> {
  const user = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${tag}`,
      primary_email: `${PREFIX}${tag}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: user.id, status })
    .execute();
  return user.id;
}

async function newRole(organizationId: string, tag: string): Promise<string> {
  return (
    await db
      .insertInto("app_roles")
      .values({ organization_id: organizationId, key: `${PREFIX}${tag}`, name: `F-154 ${tag}` })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

beforeAll(async () => {
  await cleanup();
  ids.orgA = await newOrg("org_a");
  ids.orgB = await newOrg("org_b");
  // Neither role nor the group confers a permission, so the AUTHZ-3 conferral
  // guard passes for org A's admin and the eligibility rule is what decides.
  ids.roleA = await newRole(ids.orgA, "role_a");
  ids.roleB = await newRole(ids.orgB, "role_b");
  ids.groupA = (
    await db
      .insertInto("app_groups")
      .values({ organization_id: ids.orgA, key: `${PREFIX}group_a`, name: "F-154 group" })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  ids.active = await newMember("active", ids.orgA, "active");
  for (const status of NON_ACTIVE) ids[status] = await newMember(status, ids.orgA, status);
});

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  await db.deleteFrom("app_group_memberships").where("group_id", "=", ids.groupA).execute();
  await db.deleteFrom("app_user_roles").where("role_id", "in", [ids.roleA, ids.roleB]).execute();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-154: one grant-eligibility rule (DB-backed)", () => {
  it("admits an ACTIVE membership in that org, and nothing else", async () => {
    const everyone = [ids.active, ...NON_ACTIVE.map((status) => ids[status])];
    expect(await grantEligibleUserIds(ids.orgA, everyone)).toEqual([ids.active]);
    expect(await grantEligibleUserIds(ids.orgB, everyone)).toEqual([]);
    expect(await grantEligibleUserIds(ids.orgA, [])).toEqual([]);
    expect(await userIsGrantEligible(ids.active, ids.orgA)).toBe(true);
    expect(await userIsGrantEligible(ids.active, ids.orgB)).toBe(false);
    for (const status of NON_ACTIVE) {
      expect(await userIsGrantEligible(ids[status], ids.orgA)).toBe(false);
    }
  });

  it("a superadmin cannot assign a role in an org the user never joined", async () => {
    as("superadmin");
    const refused = await assignRole(ids.active, ids.roleB, ids.orgB);
    expect(refused.status, await refused.clone().text()).toBe(404);
    expect(await refused.json()).toMatchObject({ error: "user_not_found" });
    expect((await grantsOf(ids.active)).roles).toEqual([]);

    // Control: the same superadmin assigns in the org the user belongs to.
    const assigned = await assignRole(ids.active, ids.roleA, ids.orgA);
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    expect((await grantsOf(ids.active)).roles).toEqual([
      { organization_id: ids.orgA, role_id: ids.roleA },
    ]);
  });

  it.each(NON_ACTIVE)(
    "every grant route refuses a %s member the same way, and writes nothing",
    async (status) => {
      as("orgAdmin");
      const userId = ids[status];
      // The admin reaches this member (reach is any status, review #210), so
      // the refusals below are the grant rule, not a hidden user.
      const reachable = await appRolesRoute.GET(
        request("GET", `/api/administrator/users/${userId}/app-roles`),
        params(userId),
      );
      expect(reachable.status).toBe(200);

      const answers = [
        await assignRole(userId, ids.roleA, ids.orgA),
        await addToGroupFromUserPage(userId),
        await addToGroupFromGroupPage(userId),
      ];
      for (const res of answers) {
        expect(res.status, await res.clone().text()).toBe(404);
        expect(await res.json()).toMatchObject({ error: "user_not_found" });
      }
      expect(await grantsOf(userId)).toEqual({ roles: [], groups: [] });
    },
  );

  it("every grant route admits an ACTIVE member", async () => {
    as("orgAdmin");
    const assigned = await assignRole(ids.active, ids.roleA, ids.orgA);
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    const fromUserPage = await addToGroupFromUserPage(ids.active);
    expect(fromUserPage.status, await fromUserPage.clone().text()).toBe(201);

    await db.deleteFrom("app_group_memberships").where("group_id", "=", ids.groupA).execute();
    const fromGroupPage = await addToGroupFromGroupPage(ids.active);
    expect(fromGroupPage.status, await fromGroupPage.clone().text()).toBe(200);
    expect(await fromGroupPage.json()).toMatchObject({ added: 1 });

    expect(await grantsOf(ids.active)).toEqual({
      roles: [{ organization_id: ids.orgA, role_id: ids.roleA }],
      groups: [{ group_id: ids.groupA }],
    });
  });
});
