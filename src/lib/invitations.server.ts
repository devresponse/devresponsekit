import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { hashSecret, randomBase62 } from "@/lib/api-auth/api-key";
import { auditEvent } from "@/lib/audit.server";
import { getServerEnv } from "@/lib/env";

/**
 * Organization invitations (migration 0008).
 *
 * An administrator invites an email address into an organization; the
 * invitee receives a single-use accept link. Accepting creates/activates the
 * membership in the INVITING organization — the invitation is the approval —
 * and optionally grants an app role.
 *
 * Threat / contract:
 *   - The plaintext token (32 base62 chars, ~190-bit CSPRNG) exists only in
 *     the invitation email; ONLY its SHA-256 hex is stored, unique-indexed.
 *     Never store or log the plaintext.
 *   - Callers MUST enforce the email-match rule: an invitation may only be
 *     consumed by/for an account whose email equals `invitation.email`
 *     (case-insensitive). `consumeInvitation` re-asserts it.
 *   - Consumption is race-safe: the status flip is a guarded
 *     `UPDATE … WHERE status = 'pending'`; the loser of a double-accept
 *     observes `consumed: false`.
 *   - Consumption NEVER elevates a blocked/suspended/deactivated user —
 *     explicit administrator denials always win (same invariant as
 *     `reevaluatePendingActivation`).
 *   - These helpers do not scope: admin routes MUST `canAccessOrg`-guard the
 *     target organization before calling in (ADR-0001).
 */

const TOKEN_LENGTH = 32;
/** Invitations expire 7 days after (re)issue. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationRow {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  roleId: string | null;
  status: string;
  expiresAt: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The accept link an invitation email carries. Built on BETTER_AUTH_URL —
 * the same origin the verification-email links already use — and anchored
 * to the default locale: the invitee's locale is unknown until they have an
 * account, and the invite page itself is fully localized once they land.
 */
export function buildInvitationAcceptUrl(plaintextToken: string): string {
  const base = getServerEnv().BETTER_AUTH_URL.replace(/\/$/, "");
  return `${base}/en/invite?token=${encodeURIComponent(plaintextToken)}`;
}

/**
 * Creates a pending invitation and returns the PLAINTEXT token exactly once
 * (the caller renders it into the accept URL and discards it). Throws the
 * underlying unique-violation when a pending invitation for (org, email)
 * already exists — callers map it to their conflict envelope.
 */
export async function createInvitation(input: {
  organizationId: string;
  email: string;
  roleId?: string | null;
  invitedByAppUserId?: string | null;
}): Promise<{ id: string; plaintextToken: string; expiresAt: Date }> {
  const plaintextToken = randomBase62(TOKEN_LENGTH);
  const tokenHash = await hashSecret(plaintextToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const inserted = await db
    .insertInto("app_organization_invitations")
    .values({
      organization_id: input.organizationId,
      email: normalizeEmail(input.email),
      role_id: input.roleId ?? null,
      token_hash: tokenHash,
      status: "pending",
      invited_by: input.invitedByAppUserId ?? null,
      expires_at: expiresAt,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: inserted.id, plaintextToken, expiresAt };
}

/**
 * Resolves a presented token to its LIVE invitation: `pending` and not past
 * `expires_at`. Returns null for unknown/consumed/revoked/expired tokens —
 * callers show one generic "invalid or expired" answer for all of these so
 * nothing about organizations or invitees leaks to token guessers.
 */
export async function findValidInvitationByToken(
  plaintextToken: string,
): Promise<InvitationRow | null> {
  const tokenHash = await hashSecret(plaintextToken);
  const row = await db
    .selectFrom("app_organization_invitations as i")
    .innerJoin("app_organizations as o", "o.id", "i.organization_id")
    .select([
      "i.id",
      "i.organization_id",
      "o.name as organization_name",
      "i.email",
      "i.role_id",
      "i.status",
      "i.expires_at",
    ])
    .where("i.token_hash", "=", tokenHash)
    .where("i.status", "=", "pending")
    .where("i.expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    roleId: row.role_id,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export type ConsumeInvitationResult =
  | { consumed: true; roleGranted: boolean }
  | { consumed: false; reason: "already_consumed" | "email_mismatch" | "user_not_eligible" };

/**
 * Consumes an invitation for `appUser`: marks it accepted (guarded),
 * creates/activates the membership in the inviting org, grants the optional
 * role, and activates a still-pending user account. Shared by BOTH
 * acceptance paths — sign-up provisioning (the token rode the sign-up body)
 * and the explicit authenticated accept endpoint.
 */
export async function consumeInvitation(input: {
  invitation: InvitationRow;
  appUser: { id: string; primaryEmail: string; status: string };
  actorBetterAuthUserId: string | null;
  provider?: string;
}): Promise<ConsumeInvitationResult> {
  const { invitation, appUser } = input;

  if (normalizeEmail(appUser.primaryEmail) !== normalizeEmail(invitation.email)) {
    return { consumed: false, reason: "email_mismatch" };
  }
  // Explicit admin denials always win: a blocked/suspended/deactivated user
  // cannot ride an invitation back in. The row stays pending so the inviting
  // admin can still see (and revoke) it.
  if (appUser.status !== "active" && appUser.status !== "pending_approval") {
    return { consumed: false, reason: "user_not_eligible" };
  }

  const flipped = await db
    .updateTable("app_organization_invitations")
    .set({
      status: "accepted",
      accepted_at: sql`now()`,
      accepted_app_user_id: appUser.id,
      updated_at: sql`now()`,
    })
    .where("id", "=", invitation.id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (flipped.numUpdatedRows === 0n) {
    return { consumed: false, reason: "already_consumed" };
  }

  // Membership: create active, or activate a pending one. Blocked/suspended
  // memberships are explicit denials and stay put (the user keeps whatever
  // access they had; the invitation is still recorded as accepted so the
  // state is visible to admins).
  const membership = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "status"])
    .where("app_user_id", "=", appUser.id)
    .where("organization_id", "=", invitation.organizationId)
    .executeTakeFirst();
  if (!membership) {
    await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: invitation.organizationId,
        app_user_id: appUser.id,
        status: "active",
        source_provider: input.provider ?? "invitation",
      })
      .execute();
  } else if (membership.status === "pending_approval") {
    await db
      .updateTable("app_organization_memberships")
      .set({ status: "active", updated_at: sql`now()` })
      .where("id", "=", membership.id)
      .where("status", "=", "pending_approval")
      .execute();
  }

  // User-level activation: only ever pending → active.
  await db
    .updateTable("app_users")
    .set({ status: "active", updated_at: sql`now()` })
    .where("id", "=", appUser.id)
    .where("status", "=", "pending_approval")
    .execute();

  // Optional role grant — re-validated against the inviting org at consume
  // time (the role may have been deleted or re-scoped since the invite).
  let roleGranted = false;
  if (invitation.roleId) {
    const role = await db
      .selectFrom("app_roles")
      .select(["id"])
      .where("id", "=", invitation.roleId)
      .where("organization_id", "=", invitation.organizationId)
      .executeTakeFirst();
    if (role) {
      await db
        .insertInto("app_user_roles")
        .values({
          app_user_id: appUser.id,
          organization_id: invitation.organizationId,
          role_id: role.id,
        })
        .onConflict((oc) => oc.columns(["app_user_id", "organization_id", "role_id"]).doNothing())
        .execute();
      roleGranted = true;
    }
  }

  await auditEvent({
    eventType: "auth.account.invitation_accepted",
    outcome: "success",
    actorBetterAuthUserId: input.actorBetterAuthUserId,
    appUserId: appUser.id,
    organizationId: invitation.organizationId,
    provider: input.provider ?? null,
    email: invitation.email,
    metadata: {
      invitationId: invitation.id,
      roleGranted,
      ...(invitation.roleId && !roleGranted ? { roleMissing: invitation.roleId } : {}),
    },
  });

  return { consumed: true, roleGranted };
}

/** Revokes a pending invitation. Returns false when there was none to revoke. */
export async function revokeInvitation(input: {
  invitationId: string;
  organizationId: string;
  revokedByBetterAuthUserId: string;
}): Promise<boolean> {
  const result = await db
    .updateTable("app_organization_invitations")
    .set({
      status: "revoked",
      revoked_at: sql`now()`,
      revoked_by: input.revokedByBetterAuthUserId,
      updated_at: sql`now()`,
    })
    .where("id", "=", input.invitationId)
    .where("organization_id", "=", input.organizationId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/**
 * Rotates a pending invitation's token + expiry in place (resend): the old
 * link dies immediately and no duplicate pending row is created. Works on
 * any still-`pending` row — including one past `expires_at`, which a resend
 * deliberately revives with a fresh 7-day window. Returns the new plaintext
 * exactly once, or null when the invitation was accepted/revoked meanwhile.
 */
export async function regenerateInvitationToken(input: {
  invitationId: string;
  organizationId: string;
}): Promise<{ plaintextToken: string; expiresAt: Date } | null> {
  const plaintextToken = randomBase62(TOKEN_LENGTH);
  const tokenHash = await hashSecret(plaintextToken);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const result = await db
    .updateTable("app_organization_invitations")
    .set({ token_hash: tokenHash, expires_at: expiresAt, updated_at: sql`now()` })
    .where("id", "=", input.invitationId)
    .where("organization_id", "=", input.organizationId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (result.numUpdatedRows === 0n) {
    return null;
  }
  return { plaintextToken, expiresAt };
}
