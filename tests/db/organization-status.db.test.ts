import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import {
  listActiveOrganizationIdsForBetterAuthUser,
  listUserActiveOrganizations,
  userHasActiveMembership,
} from "@/lib/active-org.server";
import {
  SUPERADMIN_PERMISSION,
  activeGlobalSuperuserGrants,
  betterAuthUserIsGlobalSuperuser,
  userHoldsSuperuserGrant,
  userIsGlobalSuperuser,
} from "@/lib/admin/access-scope.server";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import {
  consumeInvitation,
  createInvitation,
  findValidInvitationByToken,
} from "@/lib/invitations.server";

/**
 * DB-BACKED tests for F-09: organization status is a MEMBERSHIP GATE.
 *
 * Before F-09 `app_organizations.status` was never read by any access path.
 * A superadmin could suspend a tenant and its members kept the secure shell,
 * its org admins kept administering it, API keys bound to it kept
 * authenticating, its pending invitations could still be accepted, and a
 * `superuser` grant held there still made someone a platform superadmin.
 *
 * These run the real queries against live Postgres (driven by `pnpm test:db`,
 * see vitest.db.config.ts) on real rows, for the three paths the finding
 * names — the COOKIE session path, the bound-org KEY/JWT path, and the
 * INVITATION path — plus the superuser predicates and the switcher helpers.
 * Each suspension is undone in a `finally`, and reactivating the org is shown
 * to restore exactly what was there (suspension is reversible by design).
 *
 * Fixtures use the `__dbtest_orgstatus_` prefix and self-clean. The shared
 * `superuser` permission row is global and deliberately left in place.
 */
const PREFIX = "__dbtest_orgstatus_";

// The cookie path reads `active_org` through `next/headers`; this is the
// browser's (unsigned, user-controlled) cookie.
const cookie = vi.hoisted(() => ({ activeOrg: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "active_org" && cookie.activeOrg ? { value: cookie.activeOrg } : undefined,
  }),
}));

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
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  if (userIds.length > 0) {
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(key: string, status: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}`, name: `DBTest ${key}`, status })
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

/** `created_at` is set explicitly so "earliest membership" is deterministic. */
async function addMembership(appUserId: string, organizationId: string, createdAt: string) {
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: organizationId, app_user_id: appUserId, status: "active" })
    .execute();
  await db
    .updateTable("app_organization_memberships")
    .set({ created_at: sql`${createdAt}::timestamptz` })
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .execute();
}

async function setOrgStatus(organizationId: string, status: string): Promise<void> {
  await db
    .updateTable("app_organizations")
    .set({ status, updated_at: sql`now()` })
    .where("id", "=", organizationId)
    .execute();
}

/** Runs `body` with `organizationId` temporarily ACTIVE, restoring it after. */
async function whileActive(organizationId: string, body: () => Promise<void>): Promise<void> {
  await setOrgStatus(organizationId, "active");
  try {
    await body();
  } finally {
    await setOrgStatus(organizationId, "suspended");
  }
}

const ids = {
  suspended: "", // the tenant a superadmin suspended
  active: "", // an ordinary active tenant
  member: { id: "", ba: "" }, // active member of BOTH (the suspended one is earliest)
  onlySuspended: { id: "", ba: "" }, // active member of the suspended tenant only
  dormantSuper: { id: "", ba: "" }, // `superuser` grant held ONLY in the suspended tenant
};

beforeAll(async () => {
  await cleanup();

  ids.suspended = await newOrg("suspended", "suspended");
  ids.active = await newOrg("active", "active");

  ids.member = await newUser("member");
  ids.onlySuspended = await newUser("only_suspended");
  ids.dormantSuper = await newUser("dormant_super");

  await addMembership(ids.member.id, ids.suspended, "2020-01-01T00:00:00Z");
  await addMembership(ids.member.id, ids.active, "2021-01-01T00:00:00Z");
  await addMembership(ids.onlySuspended.id, ids.suspended, "2020-01-01T00:00:00Z");
  await addMembership(ids.dormantSuper.id, ids.suspended, "2020-01-01T00:00:00Z");
  await addMembership(ids.dormantSuper.id, ids.active, "2021-01-01T00:00:00Z");

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
    .values({ organization_id: ids.suspended, key: `${PREFIX}super`, name: "DBTest Super" })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: superPerm.id })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: ids.dormantSuper.id, organization_id: ids.suspended, role_id: role.id })
    .execute();
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-09 cookie path — getUserAccessContext (session)", () => {
  it("a cookie naming the SUSPENDED org falls back to the member's ACTIVE org", async () => {
    cookie.activeOrg = ids.suspended;
    const ctx = await getUserAccessContext(ids.member.ba);
    expect(ctx.organizationId).toBe(ids.active);
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).toBe("allow");
  });

  it("with no cookie, an EARLIER membership in the suspended org is skipped", async () => {
    cookie.activeOrg = null;
    const ctx = await getUserAccessContext(ids.member.ba);
    expect(ctx.organizationId).toBe(ids.active);
  });

  it("a member of ONLY the suspended org resolves to nothing and is refused", async () => {
    cookie.activeOrg = ids.suspended;
    const ctx = await getUserAccessContext(ids.onlySuspended.ba);
    expect(ctx.organizationId).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
  });

  it("reactivating the org restores the member exactly as before", async () => {
    cookie.activeOrg = ids.suspended;
    await whileActive(ids.suspended, async () => {
      const ctx = await getUserAccessContext(ids.onlySuspended.ba);
      expect(ctx.organizationId).toBe(ids.suspended);
      expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).toBe("allow");
    });
  });
});

describe("F-09 key/JWT path — getUserAccessContext with a bound org", () => {
  it("a credential BOUND to the suspended org resolves no membership (the guard then denies)", async () => {
    cookie.activeOrg = ids.active; // must be ignored on the bearer path
    const ctx = await getUserAccessContext(ids.member.ba, { organizationId: ids.suspended });
    expect(ctx.orgBound).toBe(true);
    expect(ctx.organizationId).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
  });

  it("the same principal's credential bound to the ACTIVE org keeps working", async () => {
    const ctx = await getUserAccessContext(ids.member.ba, { organizationId: ids.active });
    expect(ctx.organizationId).toBe(ids.active);
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).toBe("allow");
  });

  it("an ORG-LESS credential skips the suspended org exactly as a deleted membership would be", async () => {
    const ctx = await getUserAccessContext(ids.member.ba, { organizationId: null });
    expect(ctx.organizationId).toBe(ids.active);
  });

  it("the bound credential works again once the org is reactivated", async () => {
    await whileActive(ids.suspended, async () => {
      const ctx = await getUserAccessContext(ids.member.ba, { organizationId: ids.suspended });
      expect(ctx.organizationId).toBe(ids.suspended);
    });
  });
});

describe("F-09 superuser — authority follows org status, rank does not", () => {
  it("a grant held ONLY in a suspended org makes nobody a platform superadmin", async () => {
    await expect(userIsGlobalSuperuser(ids.dormantSuper.id)).resolves.toBe(false);
    await expect(betterAuthUserIsGlobalSuperuser(ids.dormantSuper.ba)).resolves.toBe(false);
    const ctx = await getUserAccessContext(ids.dormantSuper.ba, { organizationId: ids.active });
    expect(ctx.permissions).not.toContain(SUPERADMIN_PERMISSION);
    const grants = await activeGlobalSuperuserGrants();
    expect(grants.some((g) => g.appUserId === ids.dormantSuper.id)).toBe(false);
  });

  it("…but still RANKS as one (the rank guard must not dip while the grant sleeps)", async () => {
    await expect(userHoldsSuperuserGrant(ids.dormantSuper.id)).resolves.toBe(true);
    await expect(userHoldsSuperuserGrant(ids.member.id)).resolves.toBe(false);
  });

  it("reactivating the org wakes the grant everywhere", async () => {
    await whileActive(ids.suspended, async () => {
      await expect(userIsGlobalSuperuser(ids.dormantSuper.id)).resolves.toBe(true);
      await expect(betterAuthUserIsGlobalSuperuser(ids.dormantSuper.ba)).resolves.toBe(true);
      const grants = await activeGlobalSuperuserGrants();
      expect(grants.some((g) => g.appUserId === ids.dormantSuper.id)).toBe(true);
    });
  });
});

describe("F-09 switcher / impersonation-reach helpers", () => {
  it("never offer, accept or count a suspended org", async () => {
    const listed = await listUserActiveOrganizations(ids.member.id);
    expect(listed.map((o) => o.id)).toEqual([ids.active]);
    await expect(userHasActiveMembership(ids.member.id, ids.suspended)).resolves.toBe(false);
    await expect(userHasActiveMembership(ids.member.id, ids.active)).resolves.toBe(true);
    await expect(listActiveOrganizationIdsForBetterAuthUser(ids.member.ba)).resolves.toEqual([
      ids.active,
    ]);
  });
});

describe("F-09 invitation path", () => {
  it("an invitation into the suspended org is not live; one into the active org is", async () => {
    const intoSuspended = await createInvitation({
      organizationId: ids.suspended,
      email: `${PREFIX}invitee_s@dbtest.local`,
    });
    const intoActive = await createInvitation({
      organizationId: ids.active,
      email: `${PREFIX}invitee_a@dbtest.local`,
    });

    await expect(findValidInvitationByToken(intoSuspended.plaintextToken)).resolves.toBeNull();
    await expect(findValidInvitationByToken(intoActive.plaintextToken)).resolves.toMatchObject({
      organizationId: ids.active,
    });

    // Suspension did not destroy it: reactivate and the same link is live.
    await whileActive(ids.suspended, async () => {
      await expect(findValidInvitationByToken(intoSuspended.plaintextToken)).resolves.toMatchObject(
        { organizationId: ids.suspended },
      );
    });
  });

  it("a suspension that lands between lookup and accept wins: nothing is consumed or created", async () => {
    const invitee = await newUser("invitee_race");
    const created = await createInvitation({
      organizationId: ids.suspended,
      email: `${PREFIX}invitee_race@dbtest.local`,
    });

    // Looked up while the org was still active…
    await setOrgStatus(ids.suspended, "active");
    const invitation = await findValidInvitationByToken(created.plaintextToken).finally(() =>
      setOrgStatus(ids.suspended, "suspended"),
    );
    expect(invitation).not.toBeNull();

    // …and accepted after it was suspended again: the accept must lose.
    const result = await consumeInvitation({
      invitation: invitation!,
      appUser: {
        id: invitee.id,
        primaryEmail: `${PREFIX}invitee_race@dbtest.local`,
        status: "active",
      },
      actorBetterAuthUserId: invitee.ba,
    });
    expect(result).toEqual({ consumed: false, reason: "already_consumed" });

    const row = await db
      .selectFrom("app_organization_invitations")
      .select("status")
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("pending");
    const membership = await db
      .selectFrom("app_organization_memberships")
      .select("id")
      .where("app_user_id", "=", invitee.id)
      .where("organization_id", "=", ids.suspended)
      .executeTakeFirst();
    expect(membership).toBeUndefined();
  });
});
