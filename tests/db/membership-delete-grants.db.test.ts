import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";
import { ANY_ADMIN_PERMISSION, SUPERUSER_PERMISSIONS } from "@/lib/admin/permissions";

/**
 * DB-BACKED test for F-12: deleting a membership takes the member's grants in
 * that organization with it, so re-adding the member revives nothing.
 *
 * Before the fix both membership DELETE routes removed only the
 * `app_organization_memberships` row. `app_user_roles` and
 * `app_group_memberships` do not reference it and nothing cascades, so the
 * member's roles and group memberships in that org stayed behind. Adding the
 * user back (`POST .../members`, or an accepted invitation) revived all of
 * them, `superuser` included, with no conferral check and no audit row.
 *
 * This drives the REAL handlers against real Postgres: the `DELETE ... USING
 * ... RETURNING` statements, the REVOKE-2 row locks, the rollback of a REVOKE-1
 * refusal, and the real audit INSERTs. Only the admin guard is stubbed (so a
 * bearer credential's scopes can be injected) and the rate limiter. The rank
 * guard, target resolution and `getUserAccessContext` run for real.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_mdg_`
 * and self-clean. A second superuser (`keeper`, in another org) always
 * survives, so REVOKE-2 never depends on the rest of the database.
 */
const requireAdminMock = vi.fn();

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: () => requireAdminMock(),
  isAdminPermissionDenial: (result: unknown) =>
    typeof result === "object" && result !== null && "response" in result,
}));
vi.mock("@/lib/admin/rate-limit.server", () => ({
  DEFAULT_ADMIN_MUTATION_LIMIT: { capacity: 10, refillMs: 1000 },
  enforceRateLimit: () => undefined,
}));

const { db, pgPool } = await import("@/db/database");
const { SUPERADMIN_PERMISSION, userIsGlobalSuperuser } =
  await import("@/lib/admin/access-scope.server");
const { permissionKeysHeldInOrg } = await import("@/lib/admin/grantable-permissions.server");
const OrgMembers = await import("@/app/api/administrator/organizations/[id]/members/route");
const UserMemberships = await import("@/app/api/administrator/users/[id]/memberships/route");

const PREFIX = "__dbtest_mdg_";
/** Plain-text actor id: also the handle cleanup uses to find this file's audit rows. */
const ACTOR = `${PREFIX}actor`;
/** Custom permission keys conferred by the fixture roles. */
const PERM_DIRECT = `${PREFIX}direct.perm`;
const PERM_GROUP = `${PREFIX}group.perm`;
const PERM_ELSEWHERE = `${PREFIX}elsewhere.perm`;

async function cleanup(): Promise<void> {
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them (matches the D3 retention job).
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
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
  // Groups cascade their roles and memberships.
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_permissions").where("key", "like", `${PREFIX}%`).execute();
  if (userIds.length > 0) {
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function permissionId(key: string): Promise<string> {
  await db
    .insertInto("app_permissions")
    .values({ key, description: `DBTest ${key}` })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  const row = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", key)
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newOrg(key: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}`, name: `DBTest ${key}`, status: "active" })
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

async function newRole(organizationId: string, key: string, permissionKeys: string[]) {
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: organizationId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const permKey of permissionKeys) {
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: role.id, permission_id: await permissionId(permKey) })
      .execute();
  }
  return role.id;
}

async function newGroup(organizationId: string, key: string, roleId: string): Promise<string> {
  const group = await db
    .insertInto("app_groups")
    .values({ organization_id: organizationId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_group_roles")
    .values({ group_id: group.id, role_id: roleId, organization_id: organizationId })
    .execute();
  return group.id;
}

async function addMember(appUserId: string, organizationId: string): Promise<string> {
  const row = await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: appUserId, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Replaces what a fixture role confers. */
async function setRolePermissions(roleId: string, permissionKeys: string[]) {
  await db.deleteFrom("app_role_permissions").where("role_id", "=", roleId).execute();
  for (const permKey of permissionKeys) {
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: roleId, permission_id: await permissionId(permKey) })
      .execute();
  }
}

async function assignRole(appUserId: string, organizationId: string, roleId: string) {
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: appUserId, organization_id: organizationId, role_id: roleId })
    .execute();
}

async function joinGroup(appUserId: string, groupId: string) {
  await db
    .insertInto("app_group_memberships")
    .values({ group_id: groupId, app_user_id: appUserId })
    .execute();
}

/**
 * The world every case starts from. `member` belongs to org A and org B:
 *   - in A: a direct role conferring PERM_DIRECT + `superuser`, and a group
 *     whose role confers PERM_GROUP;
 *   - in B: a direct role and a group, both conferring PERM_ELSEWHERE, which
 *     leaving A must not touch.
 * `keeper` holds another `superuser` grant in B, so removing member's never
 * trips REVOKE-2.
 */
const w = {
  orgA: "",
  orgB: "",
  member: { id: "", ba: "" },
  keeper: { id: "", ba: "" },
  membershipA: "",
  roleA: "",
  groupA: "",
  groupRoleA: "",
  roleB: "",
  groupB: "",
};

async function seed(): Promise<void> {
  w.orgA = await newOrg("org_a");
  w.orgB = await newOrg("org_b");
  w.member = await newUser("member");
  w.keeper = await newUser("keeper");

  w.membershipA = await addMember(w.member.id, w.orgA);
  await addMember(w.member.id, w.orgB);
  await addMember(w.keeper.id, w.orgB);

  w.roleA = await newRole(w.orgA, "role_a", [PERM_DIRECT, SUPERADMIN_PERMISSION]);
  await assignRole(w.member.id, w.orgA, w.roleA);
  w.groupRoleA = await newRole(w.orgA, "group_role_a", [PERM_GROUP]);
  w.groupA = await newGroup(w.orgA, "group_a", w.groupRoleA);
  await joinGroup(w.member.id, w.groupA);

  w.roleB = await newRole(w.orgB, "role_b", [PERM_ELSEWHERE]);
  await assignRole(w.member.id, w.orgB, w.roleB);
  w.groupB = await newGroup(
    w.orgB,
    "group_b",
    await newRole(w.orgB, "group_role_b", [PERM_ELSEWHERE]),
  );
  await joinGroup(w.member.id, w.groupB);

  await assignRole(
    w.keeper.id,
    w.orgB,
    await newRole(w.orgB, "keeper_super", [SUPERADMIN_PERMISSION]),
  );
}

/** The admin guard's grant. A cookie session when `grantedScopes` is null. */
function grant(
  access: Partial<AuthStatusModule.UserAccessContext>,
  grantedScopes: string[] | null,
) {
  return {
    betterAuthUserId: ACTOR,
    access: {
      appUserId: null,
      primaryEmail: "actor@dbtest.local",
      status: "active",
      organizationId: null,
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [],
      orgBound: grantedScopes !== null,
      ...access,
    } satisfies AuthStatusModule.UserAccessContext,
    requestId: `${PREFIX}req`,
    callerKind: grantedScopes === null ? ("cookie" as const) : ("api_key" as const),
    credentialId: grantedScopes === null ? null : `${PREFIX}key`,
    grantedScopes,
  };
}
const SUPERADMIN_COOKIE = () =>
  grant({ permissions: ["admin.orgs.update", "admin.users.update", SUPERADMIN_PERMISSION] }, null);

function req(url: string, body: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    method: "DELETE",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const removeViaOrg = () =>
  OrgMembers.DELETE(
    req(`http://test.local/api/administrator/organizations/${w.orgA}/members`, {
      membershipIds: [w.membershipA],
    }),
    { params: Promise.resolve({ id: w.orgA }) },
  );
const removeViaUser = () =>
  UserMemberships.DELETE(
    req(`http://test.local/api/administrator/users/${w.member.id}/memberships`, {
      membershipIds: [w.membershipA],
    }),
    { params: Promise.resolve({ id: w.member.id }) },
  );
const readdViaOrg = () =>
  OrgMembers.POST(
    req(`http://test.local/api/administrator/organizations/${w.orgA}/members`, {
      appUserId: w.member.id,
    }),
    { params: Promise.resolve({ id: w.orgA }) },
  );
const readdViaUser = () =>
  UserMemberships.POST(
    req(`http://test.local/api/administrator/users/${w.member.id}/memberships`, {
      organizationId: w.orgA,
    }),
    { params: Promise.resolve({ id: w.member.id }) },
  );

/** The member's role and group rows in `organizationId`. */
async function grantsIn(organizationId: string) {
  const roles = await db
    .selectFrom("app_user_roles")
    .select("role_id")
    .where("app_user_id", "=", w.member.id)
    .where("organization_id", "=", organizationId)
    .execute();
  const groups = await db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_groups as g", "g.id", "gm.group_id")
    .select("gm.group_id as group_id")
    .where("gm.app_user_id", "=", w.member.id)
    .where("g.organization_id", "=", organizationId)
    .execute();
  return { roleIds: roles.map((r) => r.role_id), groupIds: groups.map((g) => g.group_id) };
}

async function membershipInA(): Promise<boolean> {
  const row = await db
    .selectFrom("app_organization_memberships")
    .select("id")
    .where("app_user_id", "=", w.member.id)
    .where("organization_id", "=", w.orgA)
    .executeTakeFirst();
  return row !== undefined;
}

interface AuditRow {
  event_type: string;
  outcome: string;
  reason: string | null;
  metadata: Record<string, unknown>;
}
async function auditRows(): Promise<AuditRow[]> {
  const rows = await db
    .selectFrom("app_audit_events")
    .select(["event_type", "outcome", "reason", "metadata"])
    .where("actor_better_auth_user_id", "=", ACTOR)
    .orderBy("created_at")
    .execute();
  return rows.map((r) => ({
    ...r,
    metadata:
      typeof r.metadata === "string"
        ? (JSON.parse(r.metadata) as Record<string, unknown>)
        : (r.metadata as Record<string, unknown>),
  }));
}

beforeEach(async () => {
  await cleanup();
  await seed();
  requireAdminMock.mockReset();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

const ROUTES = [
  { name: "DELETE /organizations/[id]/members", remove: removeViaOrg, readd: readdViaOrg },
  { name: "DELETE /users/[id]/memberships", remove: removeViaUser, readd: readdViaUser },
];

describe.each(ROUTES)("$name (DB-backed, F-12)", ({ remove, readd }) => {
  it("removes the member's roles and group memberships in that org, and only there", async () => {
    // Sanity: the member starts as a platform superuser through org A.
    expect(await userIsGlobalSuperuser(w.member.id)).toBe(true);

    requireAdminMock.mockResolvedValue(SUPERADMIN_COOKIE());
    const res = await remove();
    expect(res.status).toBe(200);

    expect(await membershipInA()).toBe(false);
    expect(await grantsIn(w.orgA)).toEqual({ roleIds: [], groupIds: [] });
    // Org B is untouched: its membership, direct role and group membership.
    expect(await grantsIn(w.orgB)).toEqual({ roleIds: [w.roleB], groupIds: [w.groupB] });
    expect(await permissionKeysHeldInOrg(w.member.id, w.orgB)).toContain(PERM_ELSEWHERE);
  });

  it("re-adding the member revives nothing, `superuser` included", async () => {
    requireAdminMock.mockResolvedValue(SUPERADMIN_COOKIE());
    expect((await remove()).status).toBe(200);
    expect((await readd()).status).toBe(201);

    expect(await membershipInA()).toBe(true);
    expect(await grantsIn(w.orgA)).toEqual({ roleIds: [], groupIds: [] });
    const held = await permissionKeysHeldInOrg(w.member.id, w.orgA);
    expect(held).not.toContain(PERM_DIRECT);
    expect(held).not.toContain(PERM_GROUP);
    expect(held).not.toContain(SUPERADMIN_PERMISSION);
    expect(await userIsGlobalSuperuser(w.member.id)).toBe(false);
  });

  it("audits each removed grant against the real audit table", async () => {
    requireAdminMock.mockResolvedValue(SUPERADMIN_COOKIE());
    expect((await remove()).status).toBe(200);

    const rows = await auditRows();
    const revoked = rows.filter((r) => r.event_type === "admin.user.role_revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.metadata).toMatchObject({
      roleId: w.roleA,
      roleKey: `${PREFIX}role_a`,
      organizationId: w.orgA,
      cause: "membership_removed",
    });
    const groupRows = rows.filter((r) => r.event_type === "admin.group.members_removed");
    expect(groupRows).toHaveLength(1);
    expect(groupRows[0]!.metadata).toMatchObject({
      groupId: w.groupA,
      key: `${PREFIX}group_a`,
      appUserIds: [w.member.id],
      cause: "membership_removed",
    });
    const membershipRow = rows.find((r) => r.event_type === "admin.user.membership_removed");
    expect(membershipRow?.metadata).toMatchObject({
      revokedRoleIds: [w.roleA],
      removedGroupIds: [w.groupA],
    });
  });

  it("a REVOKE-1 refusal rolls the grant deletes back: nothing is removed", async () => {
    // The member's role in A now confers `shell.view` and an admin key, and
    // the group an admin key: no superuser grant (a member holding one is
    // refused earlier, by the rank guard), and nothing but keys a scope can
    // name, besides the membership baseline.
    await setRolePermissions(w.roleA, ["shell.view", "admin.roles.update"]);
    await setRolePermissions(w.groupRoleA, ["admin.groups.update"]);
    // An org-bound bearer key owned by a superuser and scoped only to the two
    // route permissions. The rank guard exempts a superuser principal, so only
    // the conferral bound (P1-1) stops it: the admin keys are held by the
    // owner but outside the key's scopes. `shell.view` goes with the
    // membership and is not refused.
    requireAdminMock.mockResolvedValue(
      grant(
        {
          organizationId: w.orgA,
          permissions: [
            "admin.orgs.update",
            "admin.users.update",
            "admin.roles.update",
            "admin.groups.update",
            SUPERADMIN_PERMISSION,
          ],
        },
        ["admin.orgs.update", "admin.users.update"],
      ),
    );
    const res = await remove();
    expect(res.status).toBe(403);

    expect(await membershipInA()).toBe(true);
    expect(await grantsIn(w.orgA)).toEqual({ roleIds: [w.roleA], groupIds: [w.groupA] });

    const rows = await auditRows();
    const denied = rows.filter((r) => r.event_type === "admin.membership.revocation_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "denied", reason: "unheld_permissions" });
    expect([...(denied[0]!.metadata.unheldPermissions as string[])].sort()).toEqual([
      "admin.groups.update",
      "admin.roles.update",
    ]);
    expect(rows.filter((r) => r.outcome === "success")).toEqual([]);
  });

  it("an org admin's key scoped admin.* removes a member holding the seeded `admin` and `member` roles", async () => {
    // No bearer credential can carry a scope naming `shell.view`, and every
    // seeded role confers it. The membership implies it, so it goes with the
    // membership instead of being measured against the key's scopes.
    await setRolePermissions(w.roleA, [
      "shell.view",
      "admin.users.read",
      "admin.users.manage",
      "admin.audit.read",
    ]);
    await setRolePermissions(w.groupRoleA, ["shell.view"]);
    // An org admin (the seeded `admin.platform` role) and a key scoped
    // `admin.*`. The rank guard runs for real and passes: the member holds
    // nothing the owner lacks.
    requireAdminMock.mockResolvedValue(
      grant({ organizationId: w.orgA, permissions: ["shell.view", ...ANY_ADMIN_PERMISSION] }, [
        "admin.*",
      ]),
    );
    const res = await remove();
    expect(res.status).toBe(200);

    expect(await membershipInA()).toBe(false);
    expect(await grantsIn(w.orgA)).toEqual({ roleIds: [], groupIds: [] });
    expect(await grantsIn(w.orgB)).toEqual({ roleIds: [w.roleB], groupIds: [w.groupB] });
  });

  it("a superuser's key scoped admin.* takes custom app keys no scope can name", async () => {
    // PERM_DIRECT and PERM_GROUP are outside every credential's scopes, so
    // they are bounded by the owner's own authority, which for a superuser
    // covers them. The marker comes off first, as above.
    await setRolePermissions(w.roleA, ["shell.view", PERM_DIRECT]);
    requireAdminMock.mockResolvedValue(
      grant({ organizationId: w.orgA, permissions: [...SUPERUSER_PERMISSIONS] }, ["admin.*"]),
    );
    const res = await remove();
    expect(res.status).toBe(200);

    expect(await membershipInA()).toBe(false);
    expect(await grantsIn(w.orgA)).toEqual({ roleIds: [], groupIds: [] });
  });
});
