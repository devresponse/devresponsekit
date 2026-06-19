import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { getUserAccessContext } from "@/lib/auth-status";

/**
 * DB-BACKED test for the ADR-0002 effective-permission UNION (TEST-1).
 *
 * The integration tests Proxy-mock the DB, and that mock's own comment admits
 * only the LEFT builder's `.execute()` runs — so the
 * `app_group_memberships → app_group_roles` join never actually executes. This
 * suite runs getUserAccessContext against REAL Postgres, proving:
 *   - direct (app_user_roles) AND group-conferred (via app_group_memberships)
 *     permissions both resolve, and the UNION dedups them;
 *   - the ADR-0001 boundary holds — a group that belongs to ANOTHER org does
 *     NOT confer its roles when resolving against the active org.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_` and
 * self-clean. getUserAccessContext takes the bearer path here (boundOrg passed),
 * so no active_org cookie is read.
 */
const PREFIX = "__dbtest_authgrp_";

async function cleanup(): Promise<void> {
  // Child → parent, respecting FKs (group_roles / group_memberships cascade off
  // groups, but delete explicitly so order is obvious). Prefixed rows only.
  await db
    .deleteFrom("app_group_memberships")
    .where("group_id", "in", (eb) =>
      eb.selectFrom("app_groups").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_group_roles")
    .where("group_id", "in", (eb) =>
      eb.selectFrom("app_groups").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_user_roles")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "in", (eb) =>
      eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_permissions").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newPermission(key: string): Promise<string> {
  const row = await db
    .insertInto("app_permissions")
    .values({ key: `${PREFIX}${key}`, description: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newRole(orgId: string, key: string, permissionId: string): Promise<string> {
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: permissionId })
    .execute();
  return role.id;
}

async function newGroup(orgId: string, key: string, roleId: string): Promise<string> {
  const group = await db
    .insertInto("app_groups")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("app_group_roles").values({ group_id: group.id, role_id: roleId }).execute();
  return group.id;
}

async function newUser(handle: string): Promise<{ id: string; ba: string }> {
  const ba = `${PREFIX}${handle}`;
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: ba,
      primary_email: `${PREFIX}${handle}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, ba };
}

async function addMembership(appUserId: string, orgId: string): Promise<void> {
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: orgId, app_user_id: appUserId, status: "active" })
    .execute();
}

const KEY = {
  direct: `${PREFIX}p_direct`,
  group1: `${PREFIX}p_group1`,
  group2: `${PREFIX}p_group2`,
  orgB: `${PREFIX}p_orgb`,
};

const ids = {
  orgA: "",
  orgB: "",
  group1: "",
  group2: "",
  userDirect: { id: "", ba: "" },
  userGroup: { id: "", ba: "" },
  userBoth: { id: "", ba: "" },
  userMulti: { id: "", ba: "" },
  userBoundary: { id: "", ba: "" },
};

beforeAll(async () => {
  await cleanup();

  ids.orgA = await newOrg("org_a");
  ids.orgB = await newOrg("org_b");

  const permDirect = await newPermission("p_direct");
  const permGroup1 = await newPermission("p_group1");
  const permGroup2 = await newPermission("p_group2");
  const permOrgB = await newPermission("p_orgb");

  const roleDirect = await newRole(ids.orgA, "role_direct", permDirect);
  const roleGroup1 = await newRole(ids.orgA, "role_group1", permGroup1);
  const roleGroup2 = await newRole(ids.orgA, "role_group2", permGroup2);
  const roleOrgB = await newRole(ids.orgB, "role_orgb", permOrgB);

  ids.group1 = await newGroup(ids.orgA, "group1", roleGroup1);
  ids.group2 = await newGroup(ids.orgA, "group2", roleGroup2);
  const groupB = await newGroup(ids.orgB, "group_b", roleOrgB);

  // Direct role only.
  ids.userDirect = await newUser("u_direct");
  await addMembership(ids.userDirect.id, ids.orgA);
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: ids.userDirect.id, organization_id: ids.orgA, role_id: roleDirect })
    .execute();

  // Group-conferred role only (no direct assignment).
  ids.userGroup = await newUser("u_group");
  await addMembership(ids.userGroup.id, ids.orgA);
  await db
    .insertInto("app_group_memberships")
    .values({ group_id: ids.group1, app_user_id: ids.userGroup.id })
    .execute();

  // Direct AND group — the UNION must dedup/merge.
  ids.userBoth = await newUser("u_both");
  await addMembership(ids.userBoth.id, ids.orgA);
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: ids.userBoth.id, organization_id: ids.orgA, role_id: roleDirect })
    .execute();
  await db
    .insertInto("app_group_memberships")
    .values({ group_id: ids.group1, app_user_id: ids.userBoth.id })
    .execute();

  // Member of two groups conferring different roles.
  ids.userMulti = await newUser("u_multi");
  await addMembership(ids.userMulti.id, ids.orgA);
  await db
    .insertInto("app_group_memberships")
    .values([
      { group_id: ids.group1, app_user_id: ids.userMulti.id },
      { group_id: ids.group2, app_user_id: ids.userMulti.id },
    ])
    .execute();

  // Active in orgA, but ALSO a member of a group that belongs to orgB. The
  // orgB group must NOT confer its role when resolving against orgA.
  ids.userBoundary = await newUser("u_boundary");
  await addMembership(ids.userBoundary.id, ids.orgA);
  await db
    .insertInto("app_group_memberships")
    .values({ group_id: groupB, app_user_id: ids.userBoundary.id })
    .execute();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

const inOrgA = (ba: string) => getUserAccessContext(ba, { organizationId: ids.orgA });

describe("ADR-0002 effective-permission UNION (DB-backed)", () => {
  it("resolves a directly-assigned role", async () => {
    const ctx = await inOrgA(ids.userDirect.ba);
    expect(ctx.permissions).toContain(KEY.direct);
    expect(ctx.permissions).not.toContain(KEY.group1);
  });

  it("resolves a GROUP-conferred role (proves the group join hits Postgres)", async () => {
    const ctx = await inOrgA(ids.userGroup.ba);
    expect(ctx.permissions).toContain(KEY.group1);
    expect(ctx.permissions).not.toContain(KEY.direct);
  });

  it("unions direct + group-conferred permissions", async () => {
    const ctx = await inOrgA(ids.userBoth.ba);
    expect(ctx.permissions).toContain(KEY.direct);
    expect(ctx.permissions).toContain(KEY.group1);
  });

  it("merges permissions across multiple group memberships", async () => {
    const ctx = await inOrgA(ids.userMulti.ba);
    expect(ctx.permissions).toContain(KEY.group1);
    expect(ctx.permissions).toContain(KEY.group2);
  });

  it("does NOT confer a role from a group that belongs to another org (ADR-0001 boundary)", async () => {
    const ctx = await inOrgA(ids.userBoundary.ba);
    expect(ctx.permissions).not.toContain(KEY.orgB);
    // No orgA roles/groups either → no permissions leak through.
    expect(ctx.permissions).toEqual([]);
  });
});
