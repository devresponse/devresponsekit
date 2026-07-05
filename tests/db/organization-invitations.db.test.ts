import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import {
  consumeInvitation,
  createInvitation,
  findValidInvitationByToken,
} from "@/lib/invitations.server";

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
  // Invitations cascade with their org, but clean explicitly in case a test
  // created one against a surviving org.
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
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

async function newUser(tag: string, status = "pending_approval"): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${tag}`,
      primary_email: EMAIL,
      status,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
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
    const userId = await newUser("consume-user");
    const created = await createInvitation({ organizationId: orgId, email: EMAIL });

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
