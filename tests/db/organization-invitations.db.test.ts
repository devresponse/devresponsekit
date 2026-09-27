import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { permissionKeysHeldInOrg } from "@/lib/admin/grantable-permissions.server";
import {
  consumeInvitation,
  createInvitation,
  findValidInvitationByToken,
} from "@/lib/invitations.server";
import { provisionUserFromAuth } from "@/lib/user-provisioning.server";

/**
 * DB-BACKED integration tests for migration 0008
 * (`app_organization_invitations` + the `invite_only` approval mode).
 *
 * Proves what the mocked unit tests can't:
 *   1. The partial unique index allows ONE pending invitation per
 *      (org, email) and frees the slot once the row leaves `pending`.
 *   2. The status CHECK holds, and the extended approval-mode CHECK now
 *      accepts `invite_only` while still rejecting unknown values.
 *   3. Lifecycle FKs: invitations cascade away with their org; a deleted
 *      role degrades the invitation to `role_id = NULL` (SET NULL).
 *   4. The real token round-trip: create → find by plaintext (hash lookup)
 *      → consume against a real user (membership activated, user
 *      activated, guarded single-use flip) → replay refused; and an
 *      expired row is invisible to `findValidInvitationByToken`.
 *   5. The consume-time AUTHZ-3 re-check (review #6): the invited role is
 *      granted only when the INVITER currently holds every permission it
 *      confers (`permissionKeysHeldInOrg` runs its real UNION query here).
 *   6. The acceptance-time re-check of the INVITER's standing (F-149), with
 *      the real Better Auth ban probe: a banned superadmin's invitation
 *      admits nobody and confers no `superuser` role, on the explicit accept
 *      AND on a sign-up carrying it, and it stays void once the ban is lifted;
 *      a deactivated or removed inviter's invitation admits nobody either.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts), excluded from `pnpm test`.
 * All fixtures use a `__dbtest_inv_` prefix and self-clean (audit rows via
 * the sanctioned retention GUC).
 */
const PREFIX = "__dbtest_inv_";
const EMAIL = `${PREFIX}ada@dbtest.local`;

async function cleanup(): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("email", "like", `${PREFIX}%`).execute();
  });
  const users = await db
    .selectFrom("app_users")
    .select(["id"])
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  if (userIds.length > 0) {
    await db.deleteFrom("app_user_roles").where("app_user_id", "in", userIds).execute();
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  // Invitations cascade with their org, but clean explicitly in case a test
  // created one against a surviving org.
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  // Role ↔ permission links are plain FKs (no cascade): unlink before the
  // roles/permissions go.
  const roles = await db
    .selectFrom("app_roles")
    .select(["id"])
    .where("key", "like", `${PREFIX}%`)
    .execute();
  const roleIds = roles.map((r) => r.id);
  if (roleIds.length > 0) {
    await db.deleteFrom("app_role_permissions").where("role_id", "in", roleIds).execute();
  }
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
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

async function newUser(tag: string, status = "pending_approval", email = EMAIL): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${tag}`,
      primary_email: email,
      status,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** An org role carrying one freshly minted `${PREFIX}` permission key. */
async function newRoleWithPermission(orgId: string, tag: string): Promise<string> {
  const perm = await db
    .insertInto("app_permissions")
    .values({ key: `${PREFIX}perm.${tag}`, description: "DBTest permission" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${tag}`, name: `DBTest ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: perm.id })
    .execute();
  return role.id;
}

/** An org role carrying one permission of the real catalog (`admin.orgs.update`, `superuser`). */
async function newCatalogRole(orgId: string, tag: string, permissionKey: string): Promise<string> {
  const perm = await db
    .selectFrom("app_permissions")
    .select("id")
    .where("key", "=", permissionKey)
    .executeTakeFirstOrThrow();
  const role = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${tag}`, name: `DBTest ${tag}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("app_role_permissions")
    .values({ role_id: role.id, permission_id: perm.id })
    .execute();
  return role.id;
}

/**
 * An inviter with the standing the create route demands (F-149): an active
 * account with a Better Auth user (so the real ban probe has a row to read)
 * and an active membership in `orgId` holding `roleId`.
 */
async function newInviter(orgId: string, tag: string, roleId: string): Promise<string> {
  const email = `${PREFIX}${tag}@dbtest.local`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, now(), now())`,
    [`${PREFIX}${tag}`, `DBTest ${tag}`, email],
  );
  const inviterId = await newUser(tag, "active", email);
  await db
    .insertInto("app_organization_memberships")
    .values({ organization_id: orgId, app_user_id: inviterId, status: "active" })
    .execute();
  await db
    .insertInto("app_user_roles")
    .values({ app_user_id: inviterId, organization_id: orgId, role_id: roleId })
    .execute();
  return inviterId;
}

async function setBan(tag: string, banned: boolean): Promise<void> {
  await pgPool.query(`update "user" set banned = $2 where id = $1`, [`${PREFIX}${tag}`, banned]);
}

async function membershipOf(appUserId: string, orgId: string) {
  return db
    .selectFrom("app_organization_memberships")
    .select("status")
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", orgId)
    .executeTakeFirst();
}

async function rolesOf(appUserId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_user_roles")
    .select("role_id")
    .where("app_user_id", "=", appUserId)
    .execute();
  return rows.map((r) => r.role_id);
}

async function invitationRow(id: string) {
  return db
    .selectFrom("app_organization_invitations")
    .select(["status", "revoked_by", "revoked_at", "accepted_at"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("app_organization_invitations (DB-backed, 0008)", () => {
  it("allows one PENDING invitation per (org, email) and frees the slot after revoke", async () => {
    const orgId = await newOrg("uniq");
    await createInvitation({ organizationId: orgId, email: EMAIL });
    await expect(createInvitation({ organizationId: orgId, email: EMAIL })).rejects.toThrow(
      /duplicate key/i,
    );

    await db
      .updateTable("app_organization_invitations")
      .set({ status: "revoked" })
      .where("organization_id", "=", orgId)
      .execute();
    // The partial index only covers pending rows — a fresh invite is legal.
    await expect(createInvitation({ organizationId: orgId, email: EMAIL })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("enforces the status CHECK and the extended approval-mode CHECK (invite_only)", async () => {
    const orgId = await newOrg("check");
    await expect(
      db
        .insertInto("app_organization_invitations")
        .values({
          organization_id: orgId,
          email: EMAIL,
          token_hash: `${PREFIX}hash-a`,
          status: "nonsense",
          expires_at: new Date(Date.now() + 1000 * 60),
        })
        .execute(),
    ).rejects.toThrow(/check constraint/i);

    // 0008 extends the 0007 mode CHECK: invite_only is now storable...
    await db
      .insertInto("app_organization_auth_settings")
      .values({
        organization_id: orgId,
        require_email_verification: true,
        signup_approval_mode: "invite_only",
      })
      .execute();
    // ...while unknown modes still fail.
    await expect(
      db
        .updateTable("app_organization_auth_settings")
        .set({ signup_approval_mode: "nonsense" })
        .where("organization_id", "=", orgId)
        .execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("cascades with the org and degrades to NULL when the role is deleted", async () => {
    const orgId = await newOrg("fk");
    const role = await db
      .insertInto("app_roles")
      .values({ organization_id: orgId, key: `${PREFIX}r`, name: "DBTest Role" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const { id: invitationId } = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      roleId: role.id,
    });

    await db.deleteFrom("app_roles").where("id", "=", role.id).execute();
    const afterRoleDelete = await db
      .selectFrom("app_organization_invitations")
      .select(["role_id"])
      .where("id", "=", invitationId)
      .executeTakeFirstOrThrow();
    expect(afterRoleDelete.role_id).toBeNull();

    await db.deleteFrom("app_organizations").where("id", "=", orgId).execute();
    const afterOrgDelete = await db
      .selectFrom("app_organization_invitations")
      .select(["id"])
      .where("id", "=", invitationId)
      .executeTakeFirst();
    expect(afterOrgDelete).toBeUndefined();
  });

  it("round-trips the token, consumes once, and refuses replays", async () => {
    const orgId = await newOrg("consume");
    const inviterId = await newInviter(
      orgId,
      "consume-inviter",
      await newCatalogRole(orgId, "consume-admin", "admin.orgs.update"),
    );
    const userId = await newUser("consume-user");
    const created = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      invitedByAppUserId: inviterId,
    });

    expect(await findValidInvitationByToken("not-the-token")).toBeNull();
    const found = await findValidInvitationByToken(created.plaintextToken);
    expect(found).toMatchObject({ id: created.id, organizationId: orgId, email: EMAIL });

    const result = await consumeInvitation({
      invitation: found!,
      appUser: { id: userId, primaryEmail: EMAIL, status: "pending_approval" },
      actorBetterAuthUserId: `${PREFIX}consume-user`,
      provider: "email",
    });
    expect(result).toEqual({ consumed: true, roleGranted: false });

    const membership = await db
      .selectFrom("app_organization_memberships")
      .select(["status"])
      .where("app_user_id", "=", userId)
      .where("organization_id", "=", orgId)
      .executeTakeFirstOrThrow();
    expect(membership.status).toBe("active");
    const user = await db
      .selectFrom("app_users")
      .select(["status"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(user.status).toBe("active");

    // Consumed tokens are dead: invisible to lookup and replay-refused.
    expect(await findValidInvitationByToken(created.plaintextToken)).toBeNull();
    const replay = await consumeInvitation({
      invitation: found!,
      appUser: { id: userId, primaryEmail: EMAIL, status: "active" },
      actorBetterAuthUserId: `${PREFIX}consume-user`,
    });
    expect(replay).toEqual({ consumed: false, reason: "already_consumed" });
  });

  it("grants the invited role only when the INVITER currently holds its permissions (AUTHZ-3, review #6)", async () => {
    const orgId = await newOrg("confer");
    const roleId = await newRoleWithPermission(orgId, "confer-role");
    // An org admin: the standing to invite (F-149), and nothing the role carries.
    const inviterId = await newInviter(
      orgId,
      "confer-inviter",
      await newCatalogRole(orgId, "confer-admin", "admin.orgs.update"),
    );
    const inviteeId = await newUser("confer-invitee");

    // 1. The inviter holds only the invite permission in the org → the role is
    // withheld; the membership is still created; the audit row says why.
    const first = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      roleId,
      invitedByAppUserId: inviterId,
    });
    const found = await findValidInvitationByToken(first.plaintextToken);
    expect(found).toMatchObject({ roleId, invitedByAppUserId: inviterId });
    expect(await permissionKeysHeldInOrg(inviterId, orgId)).toEqual(["admin.orgs.update"]);

    const denied = await consumeInvitation({
      invitation: found!,
      appUser: { id: inviteeId, primaryEmail: EMAIL, status: "pending_approval" },
      actorBetterAuthUserId: `${PREFIX}confer-invitee`,
    });
    expect(denied).toEqual({ consumed: true, roleGranted: false });
    expect(
      await db
        .selectFrom("app_user_roles")
        .select("role_id")
        .where("app_user_id", "=", inviteeId)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await db
          .selectFrom("app_organization_memberships")
          .select("status")
          .where("app_user_id", "=", inviteeId)
          .where("organization_id", "=", orgId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("active");
    const audit = await db
      .selectFrom("app_audit_events")
      .select("metadata")
      .where("event_type", "=", "auth.account.invitation_accepted")
      .where("email", "=", EMAIL)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ roleGranted: false, roleDenied: roleId });

    // 2. Give the inviter the role directly → they now hold its permission
    // → a fresh invitation grants it on accept.
    await db
      .insertInto("app_user_roles")
      .values({ app_user_id: inviterId, organization_id: orgId, role_id: roleId })
      .execute();
    expect((await permissionKeysHeldInOrg(inviterId, orgId)).sort()).toEqual(
      [`${PREFIX}perm.confer-role`, "admin.orgs.update"].sort(),
    );

    const second = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      roleId,
      invitedByAppUserId: inviterId,
    });
    const granted = await consumeInvitation({
      invitation: (await findValidInvitationByToken(second.plaintextToken))!,
      appUser: { id: inviteeId, primaryEmail: EMAIL, status: "active" },
      actorBetterAuthUserId: `${PREFIX}confer-invitee`,
    });
    expect(granted).toEqual({ consumed: true, roleGranted: true });
    expect(
      await db
        .selectFrom("app_user_roles")
        .select("role_id")
        .where("app_user_id", "=", inviteeId)
        .where("organization_id", "=", orgId)
        .execute(),
    ).toEqual([{ role_id: roleId }]);

    // 3. A suspended inviter membership holds nothing in that org.
    await db
      .updateTable("app_organization_memberships")
      .set({ status: "suspended" })
      .where("app_user_id", "=", inviterId)
      .where("organization_id", "=", orgId)
      .execute();
    expect(await permissionKeysHeldInOrg(inviterId, orgId)).toEqual([]);
  });

  it("F-149: a BANNED superadmin's invitation admits nobody, confers no `superuser`, and stays void after the ban is lifted", async () => {
    const orgId = await newOrg("banned");
    const superuserRole = await newCatalogRole(orgId, "banned-su", "superuser");
    const inviterId = await newInviter(orgId, "banned-inviter", superuserRole);
    const inviteeId = await newUser("banned-invitee");
    const created = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      roleId: superuserRole,
      invitedByAppUserId: inviterId,
    });
    const found = await findValidInvitationByToken(created.plaintextToken);
    expect(found).not.toBeNull();

    // The documented lockout: a Better Auth ban. It leaves the superadmin's
    // memberships and role rows exactly as they were.
    await setBan("banned-inviter", true);
    const refused = await consumeInvitation({
      invitation: found!,
      appUser: { id: inviteeId, primaryEmail: EMAIL, status: "pending_approval" },
      actorBetterAuthUserId: `${PREFIX}banned-invitee`,
    });
    expect(refused).toEqual({ consumed: false, reason: "inviter_lacks_standing" });

    expect(await membershipOf(inviteeId, orgId)).toBeUndefined();
    expect(await rolesOf(inviteeId)).toEqual([]);
    const invitee = await db
      .selectFrom("app_users")
      .select("status")
      .where("id", "=", inviteeId)
      .executeTakeFirstOrThrow();
    expect(invitee.status).toBe("pending_approval");

    // Voided by the system, not merely refused…
    const row = await invitationRow(created.id);
    expect(row).toMatchObject({ status: "revoked", revoked_by: null, accepted_at: null });
    expect(row.revoked_at).not.toBeNull();
    const audit = await db
      .selectFrom("app_audit_events")
      .select(["outcome", "reason", "organization_id", "app_user_id", "metadata"])
      .where("event_type", "=", "invitation.access.denied")
      .where("email", "=", EMAIL)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        outcome: "denied",
        reason: "inviter_lacks_standing",
        organization_id: orgId,
        app_user_id: inviteeId,
        metadata: expect.objectContaining({
          invitationId: created.id,
          invitedByAppUserId: inviterId,
          roleId: superuserRole,
        }),
      }),
    ]);

    // …so lifting the ban does not bring it back.
    await setBan("banned-inviter", false);
    expect(await findValidInvitationByToken(created.plaintextToken)).toBeNull();

    // Control: the same, unbanned superadmin's fresh invitation does confer
    // the role, so the refusal above was the ban and nothing else.
    const fresh = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      roleId: superuserRole,
      invitedByAppUserId: inviterId,
    });
    const granted = await consumeInvitation({
      invitation: (await findValidInvitationByToken(fresh.plaintextToken))!,
      appUser: { id: inviteeId, primaryEmail: EMAIL, status: "pending_approval" },
      actorBetterAuthUserId: `${PREFIX}banned-invitee`,
    });
    expect(granted).toEqual({ consumed: true, roleGranted: true });
    expect(await rolesOf(inviteeId)).toEqual([superuserRole]);
  });

  it("F-149: a sign-up carrying a banned superadmin's invitation is neither placed nor activated in the inviting org", async () => {
    const orgId = await newOrg("banned-signup");
    const superuserRole = await newCatalogRole(orgId, "banned-signup-su", "superuser");
    const inviterId = await newInviter(orgId, "banned-signup-inviter", superuserRole);
    const created = await createInvitation({
      organizationId: orgId,
      email: EMAIL,
      roleId: superuserRole,
      invitedByAppUserId: inviterId,
    });
    await setBan("banned-signup-inviter", true);

    // Provisioning activates an invited sign-up BEFORE it consumes the
    // invitation, so this is the path the consume-time gate alone missed.
    const result = await provisionUserFromAuth({
      betterAuthUserId: `${PREFIX}banned-signup-invitee`,
      email: EMAIL,
      emailVerified: true,
      provider: "email",
      invitationToken: created.plaintextToken,
    });

    expect(result.organizationId).not.toBe(orgId);
    const invitee = await db
      .selectFrom("app_users")
      .select("id")
      .where("better_auth_user_id", "=", `${PREFIX}banned-signup-invitee`)
      .executeTakeFirstOrThrow();
    expect(await membershipOf(invitee.id, orgId)).toBeUndefined();
    expect(await rolesOf(invitee.id)).toEqual([]);
    expect(await invitationRow(created.id)).toMatchObject({ status: "revoked", revoked_by: null });
  });

  it("F-149: a deactivated or removed org admin's invitation admits nobody", async () => {
    const orgId = await newOrg("lapsed");
    const inviterId = await newInviter(
      orgId,
      "lapsed-inviter",
      await newCatalogRole(orgId, "lapsed-admin", "admin.orgs.update"),
    );
    const inviteeId = await newUser("lapsed-invitee");
    const lapses: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      [
        "deactivated (the soft-delete's account status)",
        () =>
          db
            .updateTable("app_users")
            .set({ status: "deactivated" })
            .where("id", "=", inviterId)
            .execute(),
        () =>
          db
            .updateTable("app_users")
            .set({ status: "active" })
            .where("id", "=", inviterId)
            .execute(),
      ],
      [
        "removed from the org",
        () =>
          db
            .deleteFrom("app_organization_memberships")
            .where("app_user_id", "=", inviterId)
            .where("organization_id", "=", orgId)
            .execute(),
        () => Promise.resolve(),
      ],
    ];

    for (const [label, lapse, undo] of lapses) {
      const created = await createInvitation({
        organizationId: orgId,
        email: EMAIL,
        invitedByAppUserId: inviterId,
      });
      await lapse();
      const result = await consumeInvitation({
        invitation: (await findValidInvitationByToken(created.plaintextToken))!,
        appUser: { id: inviteeId, primaryEmail: EMAIL, status: "pending_approval" },
        actorBetterAuthUserId: `${PREFIX}lapsed-invitee`,
      });
      expect(result, label).toEqual({ consumed: false, reason: "inviter_lacks_standing" });
      expect(await membershipOf(inviteeId, orgId), label).toBeUndefined();
      expect((await invitationRow(created.id)).status, label).toBe("revoked");
      await undo();
    }
  });

  it("treats a pending row past expires_at as expired at read time", async () => {
    const orgId = await newOrg("expiry");
    const created = await createInvitation({ organizationId: orgId, email: EMAIL });
    await db
      .updateTable("app_organization_invitations")
      .set({ expires_at: sql`now() - interval '1 minute'` })
      .where("id", "=", created.id)
      .execute();
    expect(await findValidInvitationByToken(created.plaintextToken)).toBeNull();
  });
});
