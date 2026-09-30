import "server-only";
import { sql } from "kysely";
import type { SupportedLocale } from "@/config/i18n-config";
import { db } from "@/db/database";
import { userIsGlobalSuperuser, userIsGrantEligible } from "@/lib/admin/access-scope.server";
import {
  permissionKeysForRoles,
  permissionKeysHeldInOrg,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import { SUPERADMIN_PERMISSION } from "@/lib/admin/permissions";
import { hashSecret, randomBase62 } from "@/lib/api-auth/api-key";
import { isBetterAuthUserBanned } from "@/lib/api-auth/ban-status.server";
import { auditEvent } from "@/lib/audit.server";
import type { SendAppEmailResult } from "@/lib/email/send.server";
import { getServerEnv } from "@/lib/env";
import { INVITATION_TTL_MS } from "@/lib/token-ttls";
import { ACTIVE_ORGANIZATION_STATUS } from "@/lib/validation/organizations";

/**
 * Organization invitations.
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
 *     observes `consumed: false`. It is also all-or-nothing: the flip and
 *     everything it admits commit in one transaction (F-95).
 *   - Consumption NEVER elevates a blocked/suspended/deactivated user —
 *     explicit administrator denials always win (same invariant as
 *     `reevaluatePendingActivation`).
 *   - The invitation is the INVITER's approval, deferred until someone
 *     accepts it, so both acceptance paths re-check that the inviter still
 *     has the standing the create route demanded (F-149,
 *     {@link enforceInviterStanding}), and so does a resend. One who lost it
 *     is refused, and the invitation is voided so it cannot come back with
 *     them.
 *   - The optional role is a DEFERRED conferral (AUTHZ-3, review #6): the
 *     create route refuses a role the inviter cannot confer, and
 *     `consumeInvitation` re-checks the role against the inviter's CURRENT
 *     authority before granting it. A role that fails the re-check (an
 *     inviter who still has standing but has lost a permission the role
 *     carries) is skipped — the membership is still created — and recorded
 *     as `roleDenied` on the audit event.
 *   - The role also follows the one grant rule every grant path shares
 *     (F-154, `userIsGrantEligible`): only an ACTIVE member of the inviting
 *     org receives it. An acceptance over a blocked or suspended membership,
 *     which stays as it is, withholds the role and records `roleWithheld`.
 *   - These helpers do not scope: admin routes MUST `canAccessOrg`-guard the
 *     target organization before calling in (ADR-0001).
 */

const TOKEN_LENGTH = 32;
/**
 * Invitations expire 7 days after (re)issue. Defined in `token-ttls.ts`, which
 * the outbox drain reads too, so the two cannot drift (F-103).
 */
export { INVITATION_TTL_MS };

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationRow {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  roleId: string | null;
  /** The inviting admin (`invited_by`); null once that account is deleted. */
  invitedByAppUserId: string | null;
  status: string;
  expiresAt: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The accept link an invitation email carries. Built on BETTER_AUTH_URL —
 * the same origin the verification-email links already use — and anchored
 * to the `locale` the email is written in (F-102), so the invitee lands on the
 * invite page in the language of the email that sent them. Its language
 * switcher keeps the `?token=` (F-35), so an invitee who switches language
 * keeps the invitation.
 */
export function buildInvitationAcceptUrl(plaintextToken: string, locale: SupportedLocale): string {
  const base = getServerEnv().BETTER_AUTH_URL.replace(/\/$/, "");
  return `${base}/${locale}/invite?token=${encodeURIComponent(plaintextToken)}`;
}

/**
 * Sends the `organization_invitation` email (outbox-first, specs.md §35) for
 * a freshly created or resent invitation — shared by the create and resend
 * routes. Resolves the inviter's display name (falling back to their email,
 * then a generic label so the template never renders blank) and renders the
 * one-time accept link from the plaintext token.
 *
 * ADR-0001 / review #220: the mail is attributed to the INVITING organization
 * via `organizationId`. Without it `sendAppEmail` fell through to
 * `relatedBetterAuthUserId`-based resolution — and an invitation has no
 * related Better Auth user (the invitee has no account yet) — so every
 * invitation landed as an org-less, SUPERADMIN-only outbox row: the org admin
 * who sent it could not see whether it was delivered, in their own Email
 * workspace, for their own org. The inviting org is not a guess, it is the
 * subject of the invitation, so passing it explicitly is both correct and
 * safe: the outbox list route filters on exactly this column
 * (`o.organization_id = <caller's org>`), so the row becomes visible to that
 * org and to no other. What those admins see is the REDACTED rendering —
 * `sendAppEmail` replaces the `?token=` value before the row is written
 * (review #21, `outbox-secrets.ts`) — so attribution buys delivery visibility
 * without handing anyone a usable accept link.
 *
 * F-104: returns `sendAppEmail`'s outcome. The accept link exists only in this
 * email, so the routes report a provider rejection (`failed`) to the admin and
 * on the audit row instead of answering "sent" regardless.
 *
 * F-102: `locale` is the language the routes resolve with `adminMailLocale`
 * (the invitee's own when the address has an account in the inviting org, else
 * the inviting admin's). It is stated to `sendAppEmail` AND anchors the link, so the email
 * and the page it opens are in one language. Every invitation used to go out
 * in English with an `/en/` link, whoever it was for.
 */
export async function sendInvitationEmail(input: {
  to: string;
  organizationId: string;
  organizationName: string;
  inviterAppUserId: string | null;
  plaintextToken: string;
  locale: SupportedLocale;
}): Promise<SendAppEmailResult> {
  const inviter = input.inviterAppUserId
    ? await db
        .selectFrom("app_users")
        .select(["display_name", "primary_email"])
        .where("id", "=", input.inviterAppUserId)
        .executeTakeFirst()
    : undefined;
  const { sendAppEmail } = await import("@/lib/email/send.server");
  return sendAppEmail({
    to: input.to,
    templateKey: "organization_invitation",
    organizationId: input.organizationId,
    locale: input.locale,
    variables: {
      inviterName: inviter?.display_name || inviter?.primary_email || "An administrator",
      organizationName: input.organizationName,
      acceptUrl: buildInvitationAcceptUrl(input.plaintextToken, input.locale),
    },
  });
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
 * Resolves a presented token to its LIVE invitation: `pending`, not past
 * `expires_at`, and into an organization that is ACTIVE. Returns null for
 * unknown/consumed/revoked/expired tokens — callers show one generic "invalid
 * or expired" answer for all of these so nothing about organizations or
 * invitees leaks to token guessers.
 *
 * F-09 — an invitation into a suspended, archived or pending organization is
 * not live either. Before this, accepting one created an active membership in
 * a tenant the operator had shut down. The row stays `pending`, so once the
 * org is reactivated an unexpired link works again. Every consumer inherits
 * the rule from here: the explicit accept route, sign-up provisioning, the
 * `/invite` and `/sign-up` pages, and the verification waiver in the
 * `user.create.before` hook (a dead invitation is no proof of a mailbox).
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
      "i.invited_by",
      "i.status",
      "i.expires_at",
    ])
    .where("i.token_hash", "=", tokenHash)
    .where("i.status", "=", "pending")
    .where("i.expires_at", ">", sql<Date>`now()`)
    .where("o.status", "=", ACTIVE_ORGANIZATION_STATUS)
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
    invitedByAppUserId: row.invited_by,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

/**
 * The permission the create route (`POST …/organizations/:id/invitations`)
 * requires of the inviter, and so the one an invitation still needs its
 * inviter to hold when it is accepted (F-149). `admin.orgs.manage` since F-69,
 * which moved the org's people and bindings off `admin.orgs.update`.
 */
const INVITE_PERMISSION = "admin.orgs.manage";

/**
 * Whether the inviter still has the standing the create route required when
 * they sent the invitation (F-149): an `active` account that is not Better
 * Auth-banned, and that still holds {@link INVITE_PERMISSION} in the inviting
 * org, or is a global superuser.
 *
 * The create route admitted the inviter through `requireAdminPermission` (an
 * active account with an active membership, holding the permission or the
 * superuser marker) and `loadScopedOrg` (the org within their reach). This is
 * that check again, measured from the rows because nobody is at a browser:
 *   - `app_users.status` must be `active`. A soft-delete, block or suspension
 *     sets something else;
 *   - a Better Auth ban writes neither that status nor the memberships, so it
 *     is read separately, through the predicate the bearer paths use
 *     (`isBetterAuthUserBanned`, which honours a lapsed temporary ban). This
 *     is the case that let a banned superadmin's invitation confer
 *     `superuser`;
 *   - reach and permission: a global superuser (`userIsGlobalSuperuser`: a
 *     grant through an active membership in an active org) reaches every
 *     org, and anyone else needs the permission, or the marker, held through
 *     an ACTIVE membership in the inviting org (`permissionKeysHeldInOrg`), as
 *     an org admin acting in that org would. So an admin demoted or removed
 *     since the invite has none.
 *
 * No inviter on record (`invited_by` is NULL once their account is deleted)
 * has no standing either: fail closed.
 */
export async function inviterHasStanding(
  invitation: Pick<InvitationRow, "invitedByAppUserId" | "organizationId">,
): Promise<boolean> {
  const inviterId = invitation.invitedByAppUserId;
  if (!inviterId) return false;
  const inviter = await db
    .selectFrom("app_users")
    .select(["better_auth_user_id", "status"])
    .where("id", "=", inviterId)
    .executeTakeFirst();
  if (!inviter || inviter.status !== "active") return false;
  if (await isBetterAuthUserBanned(inviter.better_auth_user_id)) return false;
  if (await userIsGlobalSuperuser(inviterId)) return true;
  const held = await permissionKeysHeldInOrg(inviterId, invitation.organizationId);
  return held.includes(INVITE_PERMISSION) || held.includes(SUPERADMIN_PERMISSION);
}

/**
 * The acceptance-time gate on the inviter's standing (F-149), shared by both
 * acceptance paths: `consumeInvitation` (the explicit accept endpoint, and
 * sign-up provisioning's consume) and provisioning's placement decision,
 * which activates an invited sign-up BEFORE it consumes the invitation. The
 * resend route asks it too, before it mails a fresh link that acceptance
 * would refuse. Returns true when the invitation may be honoured.
 *
 * Otherwise the invitation is VOIDED, flipped `pending` → `revoked` with no
 * `revoked_by` (the system revoked it), and the refusal is audited as
 * `invitation.access.denied` / `inviter_lacks_standing` naming the inviter.
 * Voiding rather than leaving the row `pending` matters for a ban. An
 * attacker holding a superadmin's session invites their own mailbox with the
 * `superuser` role, the operators ban the superadmin and, once the account is
 * secured, lift the ban; a merely refused invitation would work again from
 * that moment. The explicit accept endpoint answers a voided invitation with
 * the generic 404 `invitation_invalid` it gives every revoked one, and a
 * sign-up that carried it proceeds as an uninvited one.
 *
 * The audit row is written only by the request that voided the row, so a
 * refused invitation leaves exactly one.
 */
export async function enforceInviterStanding(input: {
  invitation: Pick<
    InvitationRow,
    "id" | "organizationId" | "email" | "roleId" | "invitedByAppUserId"
  >;
  actorBetterAuthUserId: string | null;
  appUserId?: string | null;
  provider?: string;
  request?: { headers: Headers };
}): Promise<boolean> {
  const { invitation } = input;
  if (await inviterHasStanding(invitation)) return true;

  const voided = await db
    .updateTable("app_organization_invitations")
    .set({ status: "revoked", revoked_at: sql`now()`, revoked_by: null, updated_at: sql`now()` })
    .where("id", "=", invitation.id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (voided.numUpdatedRows > 0n) {
    await auditEvent({
      eventType: "invitation.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: input.actorBetterAuthUserId,
      appUserId: input.appUserId ?? null,
      organizationId: invitation.organizationId,
      provider: input.provider ?? null,
      email: invitation.email,
      reason: "inviter_lacks_standing",
      request: input.request,
      metadata: {
        invitationId: invitation.id,
        invitedByAppUserId: invitation.invitedByAppUserId,
        roleId: invitation.roleId,
      },
    });
  }
  return false;
}

/**
 * Whether the inviter may (still) confer `roleId` in `organizationId` — the
 * consume-time half of the AUTHZ-3 guard (review #6). `consumeInvitation`
 * asks only once {@link enforceInviterStanding} has passed, so a banned,
 * blocked or deleted inviter never reaches the superuser fast-path below
 * (F-149). Fails closed:
 *   - no inviter on record (account deleted since the invite) → false;
 *   - a GLOBAL superuser inviter → true (mirrors the routes' `isSuperadmin`
 *     fast-path; a superuser holds the full catalog by definition);
 *   - otherwise every permission the role carries must be in the inviter's
 *     CURRENT held set for that org (active membership required).
 */
export async function inviterMayConferRole(input: {
  invitedByAppUserId: string | null;
  roleId: string;
  organizationId: string;
}): Promise<boolean> {
  if (!input.invitedByAppUserId) return false;
  if (await userIsGlobalSuperuser(input.invitedByAppUserId)) return true;
  const conferred = await permissionKeysForRoles([input.roleId]);
  if (conferred.length === 0) return true;
  const held = await permissionKeysHeldInOrg(input.invitedByAppUserId, input.organizationId);
  return unheldPermissionKeys(held, conferred).length === 0;
}

export type ConsumeInvitationResult =
  | { consumed: true; roleGranted: boolean }
  | {
      consumed: false;
      reason:
        "already_consumed" | "email_mismatch" | "user_not_eligible" | "inviter_lacks_standing";
    };

/**
 * Consumes an invitation for `appUser`: marks it accepted (guarded),
 * creates/activates the membership in the inviting org, grants the optional
 * role when that membership is then active (F-154; otherwise `roleWithheld`),
 * and activates a still-pending user account. Shared by BOTH
 * acceptance paths — sign-up provisioning (the token rode the sign-up body)
 * and the explicit authenticated accept endpoint.
 *
 * Deliberately method-agnostic: an invitation is a targeted, admin-issued
 * grant for one specific address and OVERRIDES the org's
 * `allowed_auth_methods` gate on unsolicited sign-ups (decideInitialStatus
 * ranks it the same way, so the sign-up and accept paths agree).
 *
 * F-95: the flip, the membership, the account activation and the role grant
 * commit in ONE transaction, so a failure part-way (a dropped connection, a
 * statement timeout) leaves the invitation `pending` and nothing else written,
 * and the invitee can simply accept again. These used to be separate
 * statements, so a failure after the flip left an accepted invitation with no
 * membership (or no role), and the used token could not be retried. The
 * refusals before it (the inviter's standing, which voids) and the audit rows
 * after it stay on the pool: a denial must outlive any rollback (DB-4), and
 * the success row is written only once the acceptance has committed.
 */
export async function consumeInvitation(input: {
  invitation: InvitationRow;
  appUser: { id: string; primaryEmail: string; status: string };
  actorBetterAuthUserId: string | null;
  provider?: string;
  /**
   * The accepting request, when there is one (the explicit accept endpoint;
   * sign-up provisioning has none). Stamps the audit row with the request's
   * IP, user agent and correlation id, and lets `auditEvent` attribute an
   * acceptance made from an impersonated session to the human (F-07).
   */
  request?: { headers: Headers };
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

  // F-149: nothing below may happen on the word of an inviter who has since
  // lost the standing to invite: banned (which leaves their memberships
  // active, so a banned superadmin still passed the role re-check and conferred
  // `superuser`), soft-deleted, blocked, removed or deleted. Asked after the
  // email match, so only the invitee can void their own invitation.
  if (
    !(await enforceInviterStanding({
      invitation,
      actorBetterAuthUserId: input.actorBetterAuthUserId,
      appUserId: appUser.id,
      provider: input.provider,
      request: input.request,
    }))
  ) {
    return { consumed: false, reason: "inviter_lacks_standing" };
  }

  // Optional role — re-validated against the INVITER's current authority
  // (AUTHZ-3, review #6): the grant happens now, on the invitee's request, so
  // the create route's guard must be re-asserted here or a since-demoted
  // inviter's stale invitation — or a row that predates the guard — would
  // still confer. It reads only the inviter's rows, so it is asked before the
  // transaction below opens rather than on a second pooled connection while
  // that transaction holds the invitation's row lock (F-95).
  const inviterMayConfer =
    invitation.roleId !== null &&
    (await inviterMayConferRole({
      invitedByAppUserId: invitation.invitedByAppUserId,
      roleId: invitation.roleId,
      organizationId: invitation.organizationId,
    }));

  // F-95: everything the acceptance writes commits together (see the doc
  // above). Null when the flip found nothing to consume.
  const accepted = await db.transaction().execute(async (trx) => {
    // Lock order. This transaction shares rows with administrator transactions
    // that take them in a fixed order, and must take them in the same order,
    // or each side can hold a row the other waits on and Postgres aborts one
    // of them (40P01, a 500):
    //   - the admin status change (`performAdminStatusChange`) locks the rows
    //     of every superuser grant, their orgs among them, then the account,
    //     then its memberships; soft-delete and restore write the account,
    //     then its memberships;
    //   - the role DELETE (`assertRoleNotInUse`) locks the role, then clears
    //     it from this invitation (ON DELETE SET NULL).
    // So the inviting org and the role come first, under the KEY SHARE lock
    // the membership and grant inserts' foreign-key checks take on them
    // anyway, then the account while it is pending (the only state this
    // writes it in), and only then the invitation and the membership. Left to
    // the flip, the first lock on the account would be the KEY SHARE of its
    // foreign-key check on `accepted_app_user_id`, which an If-Match claim
    // does not wait for: the claim's FOR UPDATE would then wait on this while
    // the activation below waited on the claim.
    await trx
      .selectFrom("app_organizations")
      .select("id")
      .where("id", "=", invitation.organizationId)
      .forKeyShare()
      .execute();
    // The role is re-validated against the inviting org at consume time: it
    // may have been deleted or re-scoped since the invite.
    const role =
      invitation.roleId === null
        ? undefined
        : await trx
            .selectFrom("app_roles")
            .select(["id"])
            .where("id", "=", invitation.roleId)
            .where("organization_id", "=", invitation.organizationId)
            .forKeyShare()
            .executeTakeFirst();
    await trx
      .selectFrom("app_users")
      .select("id")
      .where("id", "=", appUser.id)
      .where("status", "=", "pending_approval")
      .forNoKeyUpdate()
      .execute(); // for its lock only

    // F-09: the flip re-asserts that the inviting org is still ACTIVE. The
    // caller looked the invitation up a moment ago, but an operator suspending
    // the tenant in between must not lose to it. A refusal here reads as
    // `already_consumed` — the invitation is no longer consumable — which
    // every caller already answers with the generic `invitation_invalid`.
    const flipped = await trx
      .updateTable("app_organization_invitations")
      .set({
        status: "accepted",
        accepted_at: sql`now()`,
        accepted_app_user_id: appUser.id,
        updated_at: sql`now()`,
      })
      .where("id", "=", invitation.id)
      .where("status", "=", "pending")
      .where("organization_id", "in", (eb) =>
        eb
          .selectFrom("app_organizations")
          .select("id")
          .where("status", "=", ACTIVE_ORGANIZATION_STATUS),
      )
      .executeTakeFirst();
    if (flipped.numUpdatedRows === 0n) {
      return null;
    }

    // Membership: create active, or activate a pending one. Blocked/suspended
    // memberships are explicit denials and stay put (the user keeps whatever
    // access they had; the invitation is still recorded as accepted so the
    // state is visible to admins).
    const findMembership = () =>
      trx
        .selectFrom("app_organization_memberships")
        .select(["id", "status"])
        .where("app_user_id", "=", appUser.id)
        .where("organization_id", "=", invitation.organizationId);
    let membership = await findMembership().executeTakeFirst();
    if (!membership) {
      // F-95: a sign-up, another acceptance or an administrator can create
      // this row between the read and the insert. The insert then waits for
      // that transaction and does nothing, and the re-read picks the row up
      // (activating it below when pending) instead of failing with 23505
      // after the flip.
      const inserted = await trx
        .insertInto("app_organization_memberships")
        .values({
          organization_id: invitation.organizationId,
          app_user_id: appUser.id,
          status: "active",
          source_provider: input.provider ?? "invitation",
        })
        .onConflict((oc) => oc.columns(["organization_id", "app_user_id"]).doNothing())
        .returning(["id"])
        .executeTakeFirst();
      if (!inserted) {
        membership = await findMembership().executeTakeFirstOrThrow();
      }
    }
    if (membership?.status === "pending_approval") {
      // The inviting org's approval, so it also clears the snapshot a restore
      // leaves on a membership it held back for re-approval (F-152).
      await trx
        .updateTable("app_organization_memberships")
        .set({ status: "active", pre_deactivation_status: null, updated_at: sql`now()` })
        .where("id", "=", membership.id)
        .where("status", "=", "pending_approval")
        .execute();
    }

    // User-level activation: only ever pending → active. The lift is
    // account-wide, but it admits the user only where a membership is active:
    // a restored user's memberships come back `pending_approval`, so another
    // org's invitation no longer revives them in orgs that have not approved
    // (F-152).
    await trx
      .updateTable("app_users")
      .set({ status: "active", updated_at: sql`now()` })
      .where("id", "=", appUser.id)
      .where("status", "=", "pending_approval")
      .execute();

    // Optional role grant: the role read above, granted only when the inviter
    // may confer it (before the transaction).
    let roleGranted = false;
    let roleDenied = false;
    let roleWithheld = false;
    if (
      invitation.roleId &&
      // Through the transaction: the membership it reads was written above.
      !(await userIsGrantEligible(appUser.id, invitation.organizationId, trx))
    ) {
      // F-154: the grant rule every grant path shares, an ACTIVE membership in
      // the inviting org. A blocked or suspended membership stays put above,
      // and the role used to be written anyway, conferring nothing until the
      // block was lifted and then conferring it with nobody deciding to. The
      // acceptance is still recorded; the role waits for a fresh grant.
      roleWithheld = true;
    } else if (role && inviterMayConfer) {
      await trx
        .insertInto("app_user_roles")
        .values({
          app_user_id: appUser.id,
          organization_id: invitation.organizationId,
          role_id: role.id,
        })
        .onConflict((oc) => oc.columns(["app_user_id", "organization_id", "role_id"]).doNothing())
        .execute();
      roleGranted = true;
    } else if (role) {
      roleDenied = true;
    }
    return { roleGranted, roleDenied, roleWithheld };
  });
  if (!accepted) {
    return { consumed: false, reason: "already_consumed" };
  }
  const { roleGranted, roleDenied, roleWithheld } = accepted;

  await auditEvent({
    eventType: "auth.account.invitation_accepted",
    outcome: "success",
    actorBetterAuthUserId: input.actorBetterAuthUserId,
    appUserId: appUser.id,
    organizationId: invitation.organizationId,
    provider: input.provider ?? null,
    email: invitation.email,
    request: input.request,
    metadata: {
      invitationId: invitation.id,
      roleGranted,
      ...(roleDenied ? { roleDenied: invitation.roleId } : {}),
      ...(roleWithheld ? { roleWithheld: invitation.roleId } : {}),
      ...(invitation.roleId && !roleGranted && !roleDenied && !roleWithheld
        ? { roleMissing: invitation.roleId }
        : {}),
    },
  });

  return { consumed: true, roleGranted };
}

/**
 * Revokes a pending invitation. Returns false when there was none to revoke.
 * An email for it still queued in the outbox is not delivered afterwards: the
 * drain checks the link against this table first (F-100).
 */
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
 * link dies immediately, an email carrying it that is still queued is not
 * delivered (F-100), and no duplicate pending row is created. Works on
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
