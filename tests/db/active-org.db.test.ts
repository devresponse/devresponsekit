import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { listUserActiveOrganizations, userHasActiveMembership } from "@/lib/active-org.server";

/**
 * DB-BACKED tests for the tenant-switch authority (review #27).
 *
 * `userHasActiveMembership` is what stands between a forged `active_org`
 * cookie and a tenant the caller cannot enter; every consumer suite mocks it,
 * so its `status = 'active'` predicate was never executed against real rows.
 * These run the real query against live Postgres (driven by `pnpm test:db`,
 * see vitest.db.config.ts) and pin the four refusals that make the switch
 * sound: pending, blocked, soft-deleted (the admin DELETE cascade snapshots
 * the prior status and sets `blocked`), and a membership in ANOTHER org.
 *
 * Fixtures use the `__dbtest_` prefix and are created/torn down here, so the
 * suite leaves no residue and does not depend on a seed.
 */
const PREFIX = "__dbtest_activeorg_";

async function cleanup(): Promise<void> {
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "in", (eb) =>
      eb.selectFrom("app_users").select("id").where("better_auth_user_id", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(key: string, name: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}`, name })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newUser(key: string, status = "active"): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_${key}`,
      primary_email: `${PREFIX}${key}@dbtest.local`,
      status,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addMembership(
  appUserId: string,
  organizationId: string,
  status: string,
  preDeactivationStatus: string | null = null,
): Promise<void> {
  await db
    .insertInto("app_organization_memberships")
    .values({
      organization_id: organizationId,
      app_user_id: appUserId,
      status,
      pre_deactivation_status: preDeactivationStatus,
    })
    .execute();
}

const ids = {
  orgA: "",
  orgB: "", // the user is ACTIVE here → the only switchable org for `user`
  orgC: "", // name sorts first; the user is active here too (ordering check)
  orgOther: "", // someone else's org — `user` has NO row here
  user: "",
  userSoftDeleted: "",
  userNoOrgs: "",
  stranger: "",
};

beforeAll(async () => {
  await cleanup();

  ids.orgA = await newOrg("org_a", "Zeta Org A");
  ids.orgB = await newOrg("org_b", "Beta Org B");
  ids.orgC = await newOrg("org_c", "Alpha Org C");
  ids.orgOther = await newOrg("org_other", "Other Org");

  ids.user = await newUser("user");
  ids.userSoftDeleted = await newUser("softdeleted", "deactivated");
  ids.userNoOrgs = await newUser("noorgs");
  ids.stranger = await newUser("stranger");

  // `user`: pending in A, active in B and C — never a row in `orgOther`.
  await addMembership(ids.user, ids.orgA, "pending_approval");
  await addMembership(ids.user, ids.orgB, "active");
  await addMembership(ids.user, ids.orgC, "active");
  // `stranger` is the active member of `orgOther` (proves the org exists and
  // that another user's membership there grants `user` nothing).
  await addMembership(ids.stranger, ids.orgOther, "active");
  // Soft-deleted user: exactly what DELETE /api/administrator/users/[id]
  // leaves behind — membership `blocked` with the prior status snapshotted.
  await addMembership(ids.userSoftDeleted, ids.orgB, "blocked", "active");
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("userHasActiveMembership (live SQL)", () => {
  it("is true for an ACTIVE membership in the org", async () => {
    await expect(userHasActiveMembership(ids.user, ids.orgB)).resolves.toBe(true);
  });

  it("is false for a PENDING membership in the same org", async () => {
    await expect(userHasActiveMembership(ids.user, ids.orgA)).resolves.toBe(false);
  });

  it("is false once the membership is BLOCKED (status flip on the same row)", async () => {
    await db
      .updateTable("app_organization_memberships")
      .set({ status: "blocked", updated_at: sql`now()` })
      .where("app_user_id", "=", ids.user)
      .where("organization_id", "=", ids.orgC)
      .execute();
    try {
      await expect(userHasActiveMembership(ids.user, ids.orgC)).resolves.toBe(false);
    } finally {
      await db
        .updateTable("app_organization_memberships")
        .set({ status: "active", updated_at: sql`now()` })
        .where("app_user_id", "=", ids.user)
        .where("organization_id", "=", ids.orgC)
        .execute();
    }
    // Restored: the flip was the only thing refusing it.
    await expect(userHasActiveMembership(ids.user, ids.orgC)).resolves.toBe(true);
  });

  it("is false for a SOFT-DELETED user's membership (blocked + pre_deactivation_status snapshot)", async () => {
    // The snapshot says it WAS active; the authority must read `status`, not
    // the snapshot, or a deactivated user could still switch into the org.
    await expect(userHasActiveMembership(ids.userSoftDeleted, ids.orgB)).resolves.toBe(false);
  });

  it("is false for an org the user has NO membership in, even though another user is active there", async () => {
    await expect(userHasActiveMembership(ids.user, ids.orgOther)).resolves.toBe(false);
    await expect(userHasActiveMembership(ids.stranger, ids.orgOther)).resolves.toBe(true);
  });

  it("is false for a user with no memberships at all and for an unknown org id", async () => {
    await expect(userHasActiveMembership(ids.userNoOrgs, ids.orgB)).resolves.toBe(false);
    await expect(
      userHasActiveMembership(ids.user, "00000000-0000-4000-8000-000000000000"),
    ).resolves.toBe(false);
  });
});

describe("listUserActiveOrganizations (live SQL)", () => {
  it("returns ONLY the orgs the user is ACTIVE in, ordered by name", async () => {
    const orgs = await listUserActiveOrganizations(ids.user);
    expect(orgs.map((o) => o.id)).toEqual([ids.orgC, ids.orgB]);
    expect(orgs.map((o) => o.name)).toEqual(["Alpha Org C", "Beta Org B"]);
    expect(orgs.map((o) => o.slug)).toEqual([`${PREFIX}org_c`, `${PREFIX}org_b`]);
    // Neither the pending org nor a foreign org leaks into the switcher.
    expect(orgs.map((o) => o.id)).not.toContain(ids.orgA);
    expect(orgs.map((o) => o.id)).not.toContain(ids.orgOther);
  });

  it("is empty for a soft-deleted user and for a user with no memberships", async () => {
    await expect(listUserActiveOrganizations(ids.userSoftDeleted)).resolves.toEqual([]);
    await expect(listUserActiveOrganizations(ids.userNoOrgs)).resolves.toEqual([]);
  });
});
