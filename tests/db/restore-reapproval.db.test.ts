import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for F-152: restore hands each membership back for
 * re-approval, and a decision an org made while the user was deleted stands.
 *
 * Restore used to put every membership back to the status the soft-delete
 * cascade snapshotted, so an `active` one came back `active` behind the
 * account-level `pending_approval` alone. Any tenant could lift that: another
 * org's accepted invitation, or its admin's approval of a shared user, made
 * the account `active`, and the restored memberships then counted in orgs that
 * had approved nothing. And no membership write cleared the snapshot, so a
 * suspension an org applied while the account was deleted was undone by the
 * restore. Now restore brings an `active` membership back `pending_approval`,
 * keeping its snapshot as the marker that sign-in re-evaluation must leave it
 * to an approver, and every write that sets a membership's status clears it.
 *
 * This drives the real soft-delete (Better Auth ban included), the real
 * restore route and bulk action, the real membership PATCH routes, the status
 * core, invitation consumption, MCP agent approval and sign-in re-evaluation
 * against Postgres. Only the admin guard (a superadmin cookie session) and the
 * rate limiter are stubbed. Driven by `pnpm test:db` (vitest.db.config.ts).
 * Fixtures use `__dbtest_f152_` and clean up after themselves.
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
const { SUPERADMIN_PERMISSION } = await import("@/lib/admin/access-scope.server");
const { userHasActiveMembership } = await import("@/lib/active-org.server");
const { performAdminStatusChange } = await import("@/lib/admin-status.server");
const { executeBulkUserAction } = await import("@/lib/admin/user-actions.server");
const { consumeInvitation, createInvitation, findValidInvitationByToken } =
  await import("@/lib/invitations.server");
const { activateMcpAgent } = await import("@/lib/mcp/agents.server");
const { reevaluatePendingActivation } = await import("@/lib/user-provisioning.server");
const Restore = await import("@/app/api/administrator/users/[id]/restore/route");
const OrgMembers = await import("@/app/api/administrator/organizations/[id]/members/route");
const UserMemberships = await import("@/app/api/administrator/users/[id]/memberships/route");

const PREFIX = "__dbtest_f152_";
const RUN = randomUUID().slice(0, 8);
/** Plain-text actor id: also the handle cleanup uses to find this file's audit rows. */
const ACTOR = `${PREFIX}actor`;
const EMAIL = `${PREFIX}member_${RUN}@dbtest.local`;
const ALL = { kind: "all" } as const;

/**
 * `orgA` runs an `auto_active` sign-up policy, so sign-in re-evaluation would
 * activate a pending sign-up membership there. The member belongs to A (a
 * membership a sign-up created) and to B.
 */
const w = {
  orgA: "",
  orgB: "",
  memberId: "",
  memberBa: "",
  membershipA: "",
  membershipB: "",
  /** An org admin of both A and B: the invitations' sender, who keeps the standing (F-149). */
  inviterId: "",
};

async function cleanup(): Promise<void> {
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them, and they must go before the users they reference.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where((eb) =>
        eb.or([
          eb("actor_better_auth_user_id", "like", `${PREFIX}%`),
          eb("email", "like", `${PREFIX}%`),
          ...(userIds.length > 0 ? [eb("app_user_id", "in", userIds)] : []),
        ]),
      )
      .execute();
  });
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  if (userIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await db
    .deleteFrom("app_role_permissions")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await pgPool.query(`delete from "session" where "userId" like $1`, [`${PREFIX}%`]);
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  // The orgs' sign-up policy rows cascade with them.
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(key: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${key}_${RUN}`, name: `F152 ${key}`, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function addMembership(organizationId: string, sourceProvider: string | null) {
  const row = await db
    .insertInto("app_organization_memberships")
    .values({
      organization_id: organizationId,
      app_user_id: w.memberId,
      status: "active",
      source_provider: sourceProvider,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The admin guard's grant: a superadmin at a browser (the rank guard exempts it). */
function superadminGuard() {
  return {
    betterAuthUserId: ACTOR,
    access: {
      appUserId: null,
      primaryEmail: "actor@dbtest.local",
      status: "active",
      organizationId: null,
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: [
        "admin.users.delete",
        "admin.users.update",
        "admin.orgs.manage",
        SUPERADMIN_PERMISSION,
      ],
      orgBound: false,
    } satisfies AuthStatusModule.UserAccessContext,
    requestId: `${PREFIX}req`,
    callerKind: "cookie" as const,
    credentialId: null,
    grantedScopes: null,
  };
}

/** The bulk actor: the same superadmin. */
const actor = () => ({
  betterAuthUserId: ACTOR,
  request: { headers: new Headers() },
  scope: ALL,
  access: { permissions: [SUPERADMIN_PERMISSION], organizationId: null },
  requestId: `${PREFIX}req`,
});

function req(url: string, method: string, body?: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

async function accountStatus(): Promise<string> {
  const row = await db
    .selectFrom("app_users")
    .select("status")
    .where("id", "=", w.memberId)
    .executeTakeFirstOrThrow();
  return row.status;
}

/** The bulk target as the batch reads it: the account's CURRENT status. */
async function target() {
  return {
    appUserId: w.memberId,
    betterAuthUserId: w.memberBa,
    primaryEmail: EMAIL,
    status: await accountStatus(),
  };
}

/** A membership's status and snapshot. */
async function membership(id: string) {
  return db
    .selectFrom("app_organization_memberships")
    .select(["status", "pre_deactivation_status"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function setMembership(id: string, status: string): Promise<void> {
  await db
    .updateTable("app_organization_memberships")
    .set({ status })
    .where("id", "=", id)
    .execute();
}

async function softDelete(): Promise<void> {
  await expect(executeBulkUserAction("soft_delete", await target(), actor(), {})).resolves.toEqual({
    ok: true,
    appUserId: w.memberId,
  });
  expect(await accountStatus()).toBe("deactivated");
}

async function restoreViaRoute(): Promise<void> {
  const res = await Restore.POST(
    req(`http://test.local/api/administrator/users/${w.memberId}/restore`, "POST"),
    { params: Promise.resolve({ id: w.memberId }) },
  );
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await accountStatus()).toBe("pending_approval");
}

async function restoreViaBulk(): Promise<void> {
  await expect(executeBulkUserAction("restore", await target(), actor())).resolves.toEqual({
    ok: true,
    appUserId: w.memberId,
  });
  expect(await accountStatus()).toBe("pending_approval");
}

/** Accepts an invitation from `organizationId` as the member, as either acceptance path does. */
async function acceptInvitationFrom(organizationId: string): Promise<void> {
  const { plaintextToken } = await createInvitation({
    organizationId,
    email: EMAIL,
    invitedByAppUserId: w.inviterId,
  });
  const invitation = await findValidInvitationByToken(plaintextToken);
  expect(invitation).not.toBeNull();
  await expect(
    consumeInvitation({
      invitation: invitation!,
      appUser: { id: w.memberId, primaryEmail: EMAIL, status: await accountStatus() },
      actorBetterAuthUserId: w.memberBa,
    }),
  ).resolves.toEqual({ consumed: true, roleGranted: false });
}

/** Sign-in re-evaluation, as `session.create.after` runs it for a pending account. */
const reevaluate = () =>
  reevaluatePendingActivation({
    betterAuthUserId: w.memberBa,
    email: EMAIL,
    emailVerified: true,
    provider: "email",
  });

beforeAll(async () => {
  await cleanup();
  w.orgA = await newOrg("org_a");
  w.orgB = await newOrg("org_b");
  await db
    .insertInto("app_organization_auth_settings")
    .values({
      organization_id: w.orgA,
      require_email_verification: true,
      signup_approval_mode: "auto_active",
    })
    .execute();
  w.memberBa = `${PREFIX}ba_member_${RUN}`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'F152 member', $2, true, now(), now())`,
    [w.memberBa, EMAIL],
  );
  const user = await db
    .insertInto("app_users")
    .values({ better_auth_user_id: w.memberBa, primary_email: EMAIL, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.memberId = user.id;

  const inviter = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}ba_inviter_${RUN}`,
      primary_email: `${PREFIX}inviter_${RUN}@dbtest.local`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  w.inviterId = inviter.id;
  const invitePerm = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", "admin.orgs.manage")
    .executeTakeFirstOrThrow();
  for (const [key, organizationId] of [
    ["admin_a", w.orgA],
    ["admin_b", w.orgB],
  ] as const) {
    const role = await db
      .insertInto("app_roles")
      .values({
        organization_id: organizationId,
        key: `${PREFIX}${key}_${RUN}`,
        name: `F152 ${key}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("app_role_permissions")
      .values({ role_id: role.id, permission_id: invitePerm.id })
      .execute();
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id: organizationId, app_user_id: w.inviterId, status: "active" })
      .execute();
    await db
      .insertInto("app_user_roles")
      .values({ app_user_id: w.inviterId, organization_id: organizationId, role_id: role.id })
      .execute();
  }
});

// Every case starts from an active, unbanned member of A (joined by sign-up)
// and B, with no soft-delete record and no invitation.
beforeEach(async () => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue(superadminGuard());
  await db
    .updateTable("app_users")
    .set({
      status: "active",
      status_reason: null,
      deactivated_at: null,
      deactivated_by: null,
      deactivated_reason: null,
    })
    .where("id", "=", w.memberId)
    .execute();
  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "=", w.memberId)
    .execute();
  w.membershipA = await addMembership(w.orgA, "email");
  w.membershipB = await addMembership(w.orgB, null);
  await pgPool.query(
    `update "user" set banned = false, "banReason" = null, "banExpires" = null where id = $1`,
    [w.memberBa],
  );
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("app_user_id", "=", w.memberId).execute();
  });
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("F-152: restore hands each membership back for re-approval", () => {
  it("the route brings an active membership back pending_approval and a suspended one back as it was", async () => {
    await setMembership(w.membershipB, "suspended");
    await softDelete();

    await restoreViaRoute();

    // Held back, with its snapshot as the marker that it was.
    expect(await membership(w.membershipA)).toEqual({
      status: "pending_approval",
      pre_deactivation_status: "active",
    });
    expect(await membership(w.membershipB)).toEqual({
      status: "suspended",
      pre_deactivation_status: null,
    });
  });

  it("the bulk action does the same", async () => {
    await softDelete();

    await restoreViaBulk();

    expect(await membership(w.membershipA)).toMatchObject({ status: "pending_approval" });
    expect(await membership(w.membershipB)).toMatchObject({ status: "pending_approval" });
  });

  it("another org's accepted invitation lifts the account but admits the user only there", async () => {
    // A single-org member of A, restored by A.
    await db.deleteFrom("app_organization_memberships").where("id", "=", w.membershipB).execute();
    await softDelete();
    await restoreViaRoute();

    await acceptInvitationFrom(w.orgB);

    expect(await accountStatus()).toBe("active");
    await expect(userHasActiveMembership(w.memberId, w.orgB)).resolves.toBe(true);
    // Before F-152 the restored A membership was `active` and counted now.
    await expect(userHasActiveMembership(w.memberId, w.orgA)).resolves.toBe(false);
    expect(await membership(w.membershipA)).toMatchObject({ status: "pending_approval" });
  });

  it("the org's own invitation is its approval, and clears the marker", async () => {
    await softDelete();
    await restoreViaRoute();

    await acceptInvitationFrom(w.orgA);

    expect(await membership(w.membershipA)).toEqual({
      status: "active",
      pre_deactivation_status: null,
    });
  });

  it("another org admin's approval of a shared user lifts the account but not the membership in A", async () => {
    await softDelete();
    await restoreViaRoute();

    await expect(
      performAdminStatusChange({
        actorBetterAuthUserId: ACTOR,
        scope: { kind: "org", organizationId: w.orgB },
        targetAppUserId: w.memberId,
        newStatus: "active",
        newMembershipStatus: "active",
        eventType: "admin.user.approved",
      }),
    ).resolves.toEqual({ ok: true, status: "active" });

    expect(await accountStatus()).toBe("active");
    expect(await membership(w.membershipB)).toEqual({
      status: "active",
      pre_deactivation_status: null,
    });
    expect(await membership(w.membershipA)).toEqual({
      status: "pending_approval",
      pre_deactivation_status: "active",
    });
  });

  it("sign-in re-evaluation leaves a held-back membership to an approver, even in an auto_active org", async () => {
    await softDelete();
    await restoreViaRoute();

    await reevaluate();

    expect(await accountStatus()).toBe("pending_approval");
    expect(await membership(w.membershipA)).toMatchObject({ status: "pending_approval" });

    // CONTROL: the marker is what holds it. Without it the same sign-in
    // re-decides the sign-up membership under A's policy and activates it.
    await db
      .updateTable("app_organization_memberships")
      .set({ pre_deactivation_status: null })
      .where("id", "=", w.membershipA)
      .execute();
    await reevaluate();
    expect(await accountStatus()).toBe("active");
    expect(await membership(w.membershipA)).toMatchObject({ status: "active" });
  });

  it("a second soft-delete and restore before anyone approves keep the membership held back", async () => {
    await softDelete();
    await restoreViaRoute();
    await softDelete();
    await restoreViaBulk();

    expect(await membership(w.membershipA)).toEqual({
      status: "pending_approval",
      pre_deactivation_status: "pending_approval",
    });
    await reevaluate();
    expect(await membership(w.membershipA)).toMatchObject({ status: "pending_approval" });
  });

  it("a block after restore clears the marker, so the next soft-delete and restore keep the block", async () => {
    await db.deleteFrom("app_organization_memberships").where("id", "=", w.membershipB).execute();
    await softDelete();
    await restoreViaRoute();

    await expect(
      performAdminStatusChange({
        actorBetterAuthUserId: ACTOR,
        scope: { kind: "org", organizationId: w.orgA },
        targetAppUserId: w.memberId,
        newStatus: "blocked",
        newMembershipStatus: "blocked",
        eventType: "admin.user.blocked",
      }),
    ).resolves.toEqual({ ok: true, status: "blocked" });
    expect(await membership(w.membershipA)).toEqual({
      status: "blocked",
      pre_deactivation_status: null,
    });

    // The cascade skips a `blocked` membership, so a snapshot left on it would
    // have survived, and restore would have read `pending_approval` back.
    await softDelete();
    await restoreViaRoute();
    expect(await membership(w.membershipA)).toEqual({
      status: "blocked",
      pre_deactivation_status: null,
    });
  });

  it("an MCP agent's approval clears the marker", async () => {
    await db.deleteFrom("app_organization_memberships").where("id", "=", w.membershipB).execute();
    await db
      .updateTable("app_organization_memberships")
      .set({ source_provider: "mcp" })
      .where("id", "=", w.membershipA)
      .execute();
    await softDelete();
    await restoreViaRoute();

    await expect(activateMcpAgent(w.memberId)).resolves.toBe(true);

    expect(await membership(w.membershipA)).toEqual({
      status: "active",
      pre_deactivation_status: null,
    });
  });
});

describe("F-152: a decision an org made while the user was deleted stands", () => {
  it("PATCH …/members and PATCH …/memberships clear the snapshot, so restore leaves their status", async () => {
    await softDelete();
    expect(await membership(w.membershipA)).toEqual({
      status: "blocked",
      pre_deactivation_status: "active",
    });

    const viaOrg = await OrgMembers.PATCH(
      req(`http://test.local/api/administrator/organizations/${w.orgB}/members`, "PATCH", {
        membershipIds: [w.membershipB],
        status: "suspended",
      }),
      { params: Promise.resolve({ id: w.orgB }) },
    );
    expect(viaOrg.status, await viaOrg.clone().text()).toBe(200);
    const viaUser = await UserMemberships.PATCH(
      req(`http://test.local/api/administrator/users/${w.memberId}/memberships`, "PATCH", {
        membershipIds: [w.membershipA],
        status: "blocked",
      }),
      { params: Promise.resolve({ id: w.memberId }) },
    );
    expect(viaUser.status, await viaUser.clone().text()).toBe(200);

    await restoreViaRoute();

    // Before F-152 both came back from their `active` snapshot.
    expect(await membership(w.membershipB)).toEqual({
      status: "suspended",
      pre_deactivation_status: null,
    });
    expect(await membership(w.membershipA)).toEqual({
      status: "blocked",
      pre_deactivation_status: null,
    });
  });
});
