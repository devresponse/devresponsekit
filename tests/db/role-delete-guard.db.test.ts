import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { assertRoleNotInUse } from "@/lib/admin/roles.server";

/**
 * DB-BACKED test for DB-2 (role DELETE in-use guard).
 *
 * Runs assertRoleNotInUse against real Postgres to prove it counts BOTH
 * `app_user_roles` AND `app_group_roles`. The unit test mocks the DB; this
 * proves the actual SQL sees a group-conferred-but-unassigned role — the case
 * that previously slipped the guard and let a DELETE cascade-strip the
 * group_role row.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_` and
 * self-clean.
 */
const PREFIX = "__dbtest_roledel_";

async function cleanup(): Promise<void> {
  // app_group_roles / app_group_memberships cascade off groups; user_roles must
  // go before roles (no ON DELETE on its role_id). Child → parent.
  await db
    .deleteFrom("app_user_roles")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}org`, name: "DBTest RoleDel Org" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newRole(orgId: string, key: string): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("assertRoleNotInUse (DB-backed, DB-2)", () => {
  it("resolves for a role referenced by neither a user nor a group", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "unused");
    await expect(assertRoleNotInUse(roleId)).resolves.toBeUndefined();
  });

  it("throws role_in_use when only a GROUP confers the role (no direct user)", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "grouped");
    const group = await db
      .insertInto("app_groups")
      .values({ organization_id: orgId, key: `${PREFIX}grp`, name: "DBTest Group" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_group_roles")
      .values({ group_id: group.id, role_id: roleId, organization_id: orgId })
      .execute();

    await expect(assertRoleNotInUse(roleId)).rejects.toMatchObject({ code: "role_in_use" });
  });

  it("throws role_in_use when a user holds the role directly", async () => {
    const orgId = await newOrg();
    const roleId = await newRole(orgId, "direct");
    const user = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}ba`,
        primary_email: `${PREFIX}u@dbtest.local`,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_user_roles")
      .values({ app_user_id: user.id, organization_id: orgId, role_id: roleId })
      .execute();

    await expect(assertRoleNotInUse(roleId)).rejects.toMatchObject({ code: "role_in_use" });
  });
});
