import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import {
  decideInitialStatus,
  findEmailDomainOrganization,
  getAuthPolicyForOrg,
  isAuthMethod,
  type AuthMethod,
  type SignupDecisionReason,
  type SignupStatusDecision,
} from "@/lib/auth-policy.server";
import {
  consumeInvitation,
  enforceInviterStanding,
  findValidInvitationByToken,
  type InvitationRow,
} from "@/lib/invitations.server";
import { requireDefaultOrganization } from "@/lib/default-organization.server";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";
import {
  resolveProviderOrganization,
  type ProviderOrganizationInput,
} from "@/lib/provider-organization-resolver";

export interface ProvisionUserInput {
  betterAuthUserId: string;
  email: string;
  emailVerified: boolean;
  /**
   * True when `emailVerified` was stamped by a waived-verification sign-up
   * policy rather than a mailbox proof (the Better Auth user field
   * `emailVerificationWaived`, review 2026-09-04 #2). Read off the user row
   * by the hooks; a waived flag never satisfies domain auto-approval.
   */
  emailVerificationWaived?: boolean;
  provider: ProviderOrganizationInput["provider"];
  displayName?: string | null;
  preferredLocale?: string;
  isSeed?: boolean;
  /**
   * Single-use invitation secret that rode the sign-up request body.
   * When it resolves to a live invitation whose email matches, the sign-up
   * lands in the INVITING organization as an active member and the
   * invitation is consumed.
   */
  invitationToken?: string;
  /**
   * Organization-scoped sign-up hint from `/sign-in/<org>` / `?org=<slug>`
   * (the identifier rides the sign-up body, like `invitationToken`). When it
   * resolves to an existing ACTIVE org, the sign-up is TARGETED at that org —
   * but the initial status is still decided by that org's signup policy, so a
   * hint can never self-activate anyone. A live invitation overrides it.
   */
  organizationHint?: string;
}

export interface ProvisionUserResult {
  appUserId: string;
  organizationId: string;
  status: string;
  membershipStatus: string;
  linkedExisting: boolean;
}

/**
 * Provisions or updates an application user record after a successful
 * Better Auth authentication event.
 *
 * Responsibilities:
 *   1. Create or update `app_users`.
 *   2. Resolve the target organization: a live email-matching invitation
 *      overrides everything; otherwise the organization-scoped hint,
 *      then the admin-curated email-domain mapping (email/password
 *      sign-ups and verified GitHub addresses, F-52), then THE default org —
 *      the one flagged `is_default`, whatever its slug (F-40). It never
 *      creates an organization (F-52): with no default org the call throws
 *      `NoDefaultOrganizationError` before writing anything.
 *   3. Create an organization membership when missing, in the same
 *      transaction as step 1, so neither row exists without the other
 *      (F-95).
 *   4. Initial statuses follow the organization's runtime-configurable
 *      signup policy (`app_organization_auth_settings`):
 *      `admin_approval` parks new accounts in `pending_approval` (the
 *      fail-closed default = the pre-policy behavior); a valid invitation,
 *      `auto_active`, and verified auto-approve-domain matches activate
 *      immediately; `invite_only` parks uninvited sign-ups. Existing rows
 *      ALWAYS keep their status — the only upgrade paths are the explicit
 *      `reevaluatePendingActivation` below and invitation consumption.
 *   5. Stores preferred locale when provided.
 *   6. Audit-logs provisioning and account-linking outcomes.
 *
 * Threat / contract:
 *   - This function MUST NOT grant secure access from arbitrary OAuth
 *     profile data, nor create an organization from it (F-52). Activation
 *     happens only via (a) trusted seeds, (b) the org's admin-configured
 *     policy — the domain-based rule additionally requires the address to
 *     be VERIFIED — or (c) a live invitation whose email equals the
 *     authenticating email and whose inviter still has the standing to
 *     invite (F-149).
 *   - Email-based account linking is enforced by Better Auth's
 *     `accountLinking` configuration; this function only links
 *     application records, never auth credentials.
 */
export async function provisionUserFromAuth(
  input: ProvisionUserInput,
): Promise<ProvisionUserResult> {
  // Review #38: `profile` / `account` were accepted here and forwarded to the
  // resolver, but no call site ever supplied them — the provider-tenant
  // branches they fed were unreachable. The fields are gone with the branches.
  const resolution = resolveProviderOrganization({
    provider: input.provider,
    email: input.email,
    emailVerified: input.emailVerified,
  });

  // 0. Resolve an invitation riding the sign-up. Only honored when
  // the token is LIVE and its email equals the authenticating email — a
  // forwarded link can never move the seat to another mailbox. Any failure
  // degrades to the uninvited path (fail closed), never blocks the sign-up.
  //
  // F-149: and only while its inviter still has the standing to invite. This
  // path activates the account and its membership (steps 1-4) BEFORE it
  // consumes the invitation, so the gate inside `consumeInvitation` comes too
  // late to stop the admission: it has to be asked here, first. An invitation
  // that fails it is voided, and the sign-up carries on as an uninvited one.
  let invitation: InvitationRow | null = null;
  if (input.invitationToken && !input.isSeed) {
    try {
      const candidate = await findValidInvitationByToken(input.invitationToken);
      if (
        candidate &&
        candidate.email === input.email.trim().toLowerCase() &&
        (await enforceInviterStanding({
          invitation: candidate,
          actorBetterAuthUserId: input.betterAuthUserId,
          provider: input.provider,
        }))
      ) {
        invitation = candidate;
      }
    } catch (error) {
      const { logServerError } = await import("@/lib/observability/logger.server");
      logServerError("invitation lookup failed during provisioning; continuing uninvited", {
        err: error,
        betterAuthUserId: input.betterAuthUserId,
      });
    }
  }

  // 1. Find the target organization. An invitation overrides every other
  // resolution — the sign-up lands in the INVITING org (that is the
  // invitation's whole point). Otherwise: the organization-scoped hint, then
  // the admin-curated email-domain mapping (`app_provider_organizations` with
  // provider = 'email'), then the default org (`is_default`, F-40).
  let organizationId: string | undefined;
  let membershipOrgKey: string | null = resolution.providerOrganizationKey;
  let emailDomainRouted = false;

  if (invitation) {
    organizationId = invitation.organizationId;
    // No provider-org linkage for an invited placement.
    membershipOrgKey = null;
  }

  // Organization-scoped sign-up (`/sign-in/<org>`, `?org=`): the visitor chose
  // this org explicitly, so target it — ranked below an invitation (which is
  // email-bound proof) but above the email-domain mapping. Only an EXISTING
  // active org counts; an unknown hint degrades to normal resolution and never
  // spawns an org. Placement, not activation — `decideInitialStatus` on this
  // org's policy still governs the initial status below.
  let organizationHintApplied = false;
  if (!organizationId && input.organizationHint && !input.isSeed) {
    const hinted = await resolveOrganizationByIdentifier(input.organizationHint);
    if (hinted) {
      organizationId = hinted.id;
      membershipOrgKey = null;
      organizationHintApplied = true;
    }
  }

  // The mapping places an email/password sign-up, or a GitHub sign-in whose
  // address GitHub verified (`routesByEmailDomain`, F-52). A verified GitHub
  // sign-in used to skip it: its domain was looked up as an org SLUG, and an
  // unknown one created an active org.
  if (!organizationId && resolution.routesByEmailDomain) {
    const mapped = await findEmailDomainOrganization(input.email);
    if (mapped) {
      organizationId = mapped.organizationId;
      membershipOrgKey = mapped.providerOrganizationKey;
      emailDomainRouted = true;
    }
  }

  if (!organizationId) {
    // F-40: THE default org is the one flagged `is_default`, whatever its slug.
    // This used to look up the slug `default`, so after a superadmin renamed
    // the default org the lookup missed and a fallback created a new, active
    // "Default Organization" with no admins, roles or policy row, and every
    // later unmapped sign-up joined it under the platform policy. With no
    // default org at all this throws before anything is written: an account
    // with nowhere to land stays unprovisioned (and so without access) and the
    // error names the fix, rather than a tenant nobody administers appearing.
    // F-52: this is also where a GitHub sign-in no binding claims now lands,
    // instead of in an org it created from its email domain.
    organizationId = (await requireDefaultOrganization()).id;
  }

  // 2. Decide initial statuses from the org's signup policy. Seeds
  // are trusted fixtures and bypass policy; everything else resolves the
  // effective policy (org row → platform default → fail-closed strict).
  let decision: { status: SignupStatusDecision["status"]; reason: SignupDecisionReason | "seed" };
  let policySource: string;
  if (input.isSeed) {
    decision = { status: "active", reason: "seed" };
    policySource = "seed";
  } else {
    const policy = await getAuthPolicyForOrg(organizationId);
    decision = decideInitialStatus(policy, {
      provider: input.provider,
      email: input.email,
      emailVerified: input.emailVerified,
      emailVerificationWaived: input.emailVerificationWaived === true,
      hasValidInvitation: invitation !== null,
    });
    policySource = policy.source;
  }

  // 3-4. Find or create the app_user record (existing rows preserve status),
  // then its membership in the target org, in ONE transaction (F-95). They
  // were separate statements on the pool, so a failure between them (a
  // dropped connection, a statement timeout, the org deleted under the
  // insert) committed the account without its membership. Every later
  // sign-in then took the session hook's `existing` early return and never
  // wrote it, and only a superadmin could repair the user, since org admins
  // cannot see a user with no membership. Now both rows exist or neither
  // does, and the next sign-in provisions from scratch.
  //
  // Both inserts are `ON CONFLICT DO NOTHING` on their unique keys, followed
  // by a re-read: a concurrent duplicate (two sign-ins provisioning one new
  // identity at once, such as a double-submitted OAuth callback) waits for
  // the other transaction and converges on the rows it wrote, instead of
  // failing the sign-in with 23505.
  const { appUserId, status, linkedExisting, membershipStatus } = await db
    .transaction()
    .execute(async (trx) => {
      const findUser = () =>
        trx
          .selectFrom("app_users")
          .select(["id", "status"])
          .where("better_auth_user_id", "=", input.betterAuthUserId);
      let user = await findUser().executeTakeFirst();
      let linked = user !== undefined;
      if (!user) {
        user = await trx
          .insertInto("app_users")
          .values({
            better_auth_user_id: input.betterAuthUserId,
            primary_email: input.email,
            display_name: input.displayName ?? null,
            status: decision.status,
            preferred_locale: input.preferredLocale ?? "en",
          })
          .onConflict((oc) => oc.column("better_auth_user_id").doNothing())
          .returning(["id", "status"])
          .executeTakeFirst();
        if (!user) {
          // A concurrent provisioning of the same identity won the insert.
          user = await findUser().executeTakeFirstOrThrow();
          linked = true;
        }
      }

      if (linked) {
        // Only overwrite profile fields the provider actually supplied —
        // re-provisioning must never clear an existing display name or
        // reset a user's saved locale preference.
        await trx
          .updateTable("app_users")
          .set({
            primary_email: input.email,
            ...(input.displayName ? { display_name: input.displayName } : {}),
            ...(input.preferredLocale ? { preferred_locale: input.preferredLocale } : {}),
            updated_at: sql`now()`,
          })
          .where("id", "=", user.id)
          .execute();
      }

      const findMembership = () =>
        trx
          .selectFrom("app_organization_memberships")
          .select(["status"])
          .where("app_user_id", "=", user.id)
          .where("organization_id", "=", organizationId);
      let membership = await findMembership().executeTakeFirst();
      if (!membership) {
        membership =
          (await trx
            .insertInto("app_organization_memberships")
            .values({
              organization_id: organizationId,
              app_user_id: user.id,
              status: decision.status,
              source_provider: resolution.provider,
              provider_organization_key: membershipOrgKey,
            })
            .onConflict((oc) => oc.columns(["organization_id", "app_user_id"]).doNothing())
            .returning(["status"])
            .executeTakeFirst()) ?? (await findMembership().executeTakeFirstOrThrow());
      }

      return {
        appUserId: user.id,
        status: user.status,
        linkedExisting: linked,
        membershipStatus: membership.status,
      };
    });

  // 4b. Consume the invitation now that the user + membership exist: flips
  // it to accepted (race-guarded), grants the optional role, and emits
  // `auth.account.invitation_accepted`. Best-effort by design — the seat is
  // already correctly placed by the decision above, and a revoke racing the
  // sign-up (the only realistic loser here) is still fully remediable by
  // the admin acting on the user directly.
  //
  // F-95: deliberately AFTER the placement commits, in the consume's own
  // transaction. A failure there rolls back only the consume: the account
  // stays placed and the invitation stays `pending`, so the invitee can still
  // accept it from `/invite` and receive the role. Inside the placement's
  // transaction the same failure would roll the placement back too, and the
  // session hook would then provision the account as an uninvited sign-up.
  if (invitation) {
    try {
      await consumeInvitation({
        invitation,
        appUser: { id: appUserId, primaryEmail: input.email, status },
        actorBetterAuthUserId: input.betterAuthUserId,
        provider: input.provider,
      });
    } catch (error) {
      const { logServerError } = await import("@/lib/observability/logger.server");
      logServerError("invitation consume failed during provisioning", {
        err: error,
        betterAuthUserId: input.betterAuthUserId,
      });
    }
  }

  // 5. Audit the provisioning outcome.
  await auditEvent({
    eventType: linkedExisting
      ? "auth.account.linked"
      : decision.status === "active"
        ? "auth.account.auto_activated"
        : "auth.account.pending_approval",
    outcome: "success",
    actorBetterAuthUserId: input.betterAuthUserId,
    appUserId,
    organizationId,
    provider: resolution.provider,
    email: input.email,
    metadata: {
      confidence: resolution.confidence,
      providerOrganizationKey: membershipOrgKey,
      ...(emailDomainRouted ? { emailDomainRouted: true } : {}),
      ...(organizationHintApplied ? { organizationHintApplied: true } : {}),
      // A policy-waived verification is recorded so the approval queue and
      // audit reviewers can tell "verified" from "waived" (review #2).
      ...(input.emailVerificationWaived === true ? { emailVerificationWaived: true } : {}),
      ...(linkedExisting ? {} : { decisionReason: decision.reason, policySource }),
    },
  });

  return {
    appUserId,
    organizationId,
    status,
    membershipStatus,
    linkedExisting,
  };
}

/**
 * Re-evaluates a still-pending account against the CURRENT signup policy at
 * sign-in time. This is the ONLY path that upgrades an existing row;
 * `provisionUserFromAuth` never elevates.
 *
 * Activation triggers, per pending membership's organization:
 *   - the org now runs `signup_approval_mode = 'auto_active'` (a brand-new
 *     signup would be active anyway, so keeping the old row pending protects
 *     nothing and only confuses the approval queue), or
 *   - the user's email is now GENUINELY verified and matches an auto-approve
 *     domain — this is how a verify-then-approve-by-domain org activates its
 *     email/password users the moment they click the verification link. A
 *     verification the sign-up policy WAIVED (`emailVerificationWaived`)
 *     never qualifies, so tightening an org's policy after a waived sign-up
 *     cannot auto-activate the unproven address (review 2026-09-04 #2).
 *
 * Guards:
 *   - Runs only for `app_users.status = 'pending_approval'`; blocked /
 *     suspended / deactivated are explicit admin denials and are NEVER
 *     touched. The UPDATEs re-assert the pending status in their WHERE
 *     clauses, so a concurrent admin action wins.
 *   - Only a membership a SIGN-UP created is re-decided: one whose
 *     `source_provider` is an auth method, which is what provisioning stamps
 *     (F-480). The policy re-decides what the policy decided. A membership an
 *     administrator placed pending carries none (the confined create in
 *     `user-create.server.ts`, `POST /users/{id}/memberships`,
 *     `POST /organizations/{id}/members`), and pending there is that admin's
 *     decision, which only an approval lifts. This used to fall back to the
 *     sign-in's provider for such a row, so a user a confined creator made
 *     pending in an `auto_active` org activated itself at its first sign-in,
 *     with nobody approving it.
 *   - Likewise a membership a restore brought back pending: it keeps its
 *     `pre_deactivation_status` snapshot until someone decides it, and waits
 *     for an approver (F-152, `restoreSnapshottedMemberships`).
 *   - A user-level activation requires at least one membership to activate.
 */
export async function reevaluatePendingActivation(input: {
  betterAuthUserId: string;
  email: string;
  emailVerified: boolean;
  /** See {@link ProvisionUserInput.emailVerificationWaived}. */
  emailVerificationWaived?: boolean;
  provider: AuthMethod;
}): Promise<void> {
  const user = await db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("better_auth_user_id", "=", input.betterAuthUserId)
    .executeTakeFirst();
  if (!user || user.status !== "pending_approval") {
    return;
  }

  const memberships = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "organization_id", "source_provider"])
    .where("app_user_id", "=", user.id)
    .where("status", "=", "pending_approval")
    // F-152: a membership restore held back for re-approval keeps its
    // snapshot until someone decides it. Pending there is the restoring
    // admin's decision, not the policy's (see the F-480 guard above).
    .where("pre_deactivation_status", "is", null)
    .execute();
  if (memberships.length === 0) {
    return;
  }

  // A single sign-in can clear pending status across MORE than one org (a user
  // pending in several). Record every org activated in this pass, not just the
  // last, so the audit trail is complete; the first is the primary for the
  // event's top-level organizationId.
  const activated: Array<{ membershipId: string; organizationId: string }> = [];
  let primaryReason: SignupDecisionReason | null = null;
  for (const membership of memberships) {
    // F-480: an admin-placed membership (no sign-up source) waits for an
    // approver; the sign-up policy governs sign-ups only (see the doc above).
    if (!isAuthMethod(membership.source_provider)) {
      continue;
    }
    const policy = await getAuthPolicyForOrg(membership.organization_id);
    const decision = decideInitialStatus(policy, {
      // Judge the membership by how it was created, not by this sign-in.
      provider: membership.source_provider,
      email: input.email,
      emailVerified: input.emailVerified,
      emailVerificationWaived: input.emailVerificationWaived === true,
    });
    if (decision.status !== "active") {
      continue;
    }
    activated.push({ membershipId: membership.id, organizationId: membership.organization_id });
    primaryReason ??= decision.reason;
  }
  if (activated.length === 0) {
    return;
  }
  const activatedOrgIds = activated.map((a) => a.organizationId);

  // F-95: the memberships and the account activate in ONE transaction. Written
  // one by one, a failure after a membership flipped left the account pending
  // with no pending membership left for the next sign-in to re-decide, so only
  // an approver could finish the activation.
  //
  // Lock order: the account first, then its memberships, the order the admin
  // status change, soft-delete and restore take them in. The other way round,
  // an approval landing between the two writes held the account while it
  // waited on a membership this held, this then waited on the account, and
  // Postgres aborted one side (40P01).
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("app_users")
      .set({ status: "active", updated_at: sql`now()` })
      .where("id", "=", user.id)
      .where("status", "=", "pending_approval")
      .execute();
    for (const { membershipId } of activated) {
      await trx
        .updateTable("app_organization_memberships")
        .set({ status: "active", updated_at: sql`now()` })
        .where("id", "=", membershipId)
        .where("status", "=", "pending_approval")
        .execute();
    }
  });

  await auditEvent({
    eventType: "auth.account.auto_activated",
    outcome: "success",
    actorBetterAuthUserId: input.betterAuthUserId,
    appUserId: user.id,
    organizationId: activatedOrgIds[0],
    provider: input.provider,
    email: input.email,
    metadata: {
      from: "pending_approval",
      decisionReason: primaryReason,
      trigger: "sign_in_reevaluation",
      // Only meaningful when more than one org cleared at once; the common
      // single-org case keeps the pre-existing metadata shape.
      ...(activatedOrgIds.length > 1 ? { activatedOrgIds } : {}),
    },
  });
}
