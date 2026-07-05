import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import {
  decideInitialStatus,
  findEmailDomainOrganization,
  getAuthPolicyForOrg,
  type AuthMethod,
  type SignupDecisionReason,
  type SignupStatusDecision,
} from "@/lib/auth-policy.server";
import {
  resolveProviderOrganization,
  type ProviderOrganizationInput,
} from "@/lib/provider-organization-resolver";

export interface ProvisionUserInput {
  betterAuthUserId: string;
  email: string;
  emailVerified: boolean;
  provider: ProviderOrganizationInput["provider"];
  profile?: Record<string, unknown>;
  account?: Record<string, unknown>;
  displayName?: string | null;
  preferredLocale?: string;
  isSeed?: boolean;
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
 *   2. Resolve provider organization: provider metadata first, then the
 *      admin-curated email-domain mapping (0007), then the `default` org.
 *   3. Create an organization membership when missing.
 *   4. Initial statuses follow the organization's runtime-configurable
 *      signup policy (`app_organization_auth_settings`, 0007):
 *      `admin_approval` parks new accounts in `pending_approval` (the
 *      fail-closed default = pre-0007 behavior); `auto_active` and verified
 *      auto-approve-domain matches activate immediately. Existing rows
 *      ALWAYS keep their status — the only upgrade path is the explicit
 *      `reevaluatePendingActivation` below.
 *   5. Stores preferred locale when provided.
 *   6. Audit-logs provisioning and account-linking outcomes.
 *
 * Threat / contract:
 *   - This function MUST NOT grant secure access from arbitrary OAuth
 *     profile data. Activation happens only via (a) trusted seeds, or
 *     (b) the org's admin-configured policy — and the domain-based rule
 *     additionally requires the address to be VERIFIED.
 *   - Email-based account linking is enforced by Better Auth's
 *     `accountLinking` configuration; this function only links
 *     application records, never auth credentials.
 */
export async function provisionUserFromAuth(
  input: ProvisionUserInput,
): Promise<ProvisionUserResult> {
  const resolution = resolveProviderOrganization({
    provider: input.provider,
    email: input.email,
    emailVerified: input.emailVerified,
    profile: input.profile,
    account: input.account,
  });

  // 1. Find or create the target organization. Email/password sign-ups
  // otherwise fall back to `default`; an admin-curated email-domain mapping
  // (`app_provider_organizations` with provider = 'email') routes them to a
  // specific organization first, so that org's signup policy governs its
  // own domain's registrations end-to-end (0007).
  let organizationId: string | undefined;
  let membershipOrgKey = resolution.providerOrganizationKey;
  let emailDomainRouted = false;

  if (input.provider === "email" && resolution.providerOrganizationKey === "default") {
    const mapped = await findEmailDomainOrganization(input.email);
    if (mapped) {
      organizationId = mapped.organizationId;
      membershipOrgKey = mapped.providerOrganizationKey;
      emailDomainRouted = true;
    }
  }

  if (!organizationId) {
    const orgRow = await db
      .selectFrom("app_organizations")
      .select(["id"])
      .where(
        "slug",
        "=",
        resolution.providerOrganizationKey === "default"
          ? "default"
          : resolution.providerOrganizationKey,
      )
      .executeTakeFirst();

    if (orgRow) {
      organizationId = orgRow.id;
    } else {
      const inserted = await db
        .insertInto("app_organizations")
        .values({
          slug: resolution.providerOrganizationKey,
          name: resolution.displayName,
          status: "active",
          is_default: false,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      organizationId = inserted.id;

      await db
        .insertInto("app_provider_organizations")
        .values({
          organization_id: organizationId,
          provider: resolution.provider,
          provider_organization_key: resolution.providerOrganizationKey,
          display_name: resolution.displayName,
        })
        .onConflict((oc) => oc.columns(["provider", "provider_organization_key"]).doNothing())
        .execute();
    }
  }

  // 2. Decide initial statuses from the org's signup policy (0007). Seeds
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
    });
    policySource = policy.source;
  }

  // 3. Find or create the app_user record. Existing rows preserve status.
  const existing = await db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("better_auth_user_id", "=", input.betterAuthUserId)
    .executeTakeFirst();

  let appUserId: string;
  let status: string;
  let linkedExisting = false;

  if (existing) {
    appUserId = existing.id;
    status = existing.status;
    linkedExisting = true;

    // Only overwrite profile fields the provider actually supplied —
    // re-provisioning must never clear an existing display name or
    // reset a user's saved locale preference.
    await db
      .updateTable("app_users")
      .set({
        primary_email: input.email,
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.preferredLocale ? { preferred_locale: input.preferredLocale } : {}),
        updated_at: sql`now()`,
      })
      .where("id", "=", appUserId)
      .execute();
  } else {
    const inserted = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: input.betterAuthUserId,
        primary_email: input.email,
        display_name: input.displayName ?? null,
        status: decision.status,
        preferred_locale: input.preferredLocale ?? "en",
      })
      .returning(["id", "status"])
      .executeTakeFirstOrThrow();
    appUserId = inserted.id;
    status = inserted.status;
  }

  // 4. Find or create the membership.
  const membership = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "status"])
    .where("app_user_id", "=", appUserId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();

  let membershipStatus: string;
  if (membership) {
    membershipStatus = membership.status;
  } else {
    await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: organizationId,
        app_user_id: appUserId,
        status: decision.status,
        source_provider: resolution.provider,
        provider_organization_key: membershipOrgKey,
      })
      .execute();
    membershipStatus = decision.status;
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
 * sign-in time (0007). This is the ONLY path that upgrades an existing row;
 * `provisionUserFromAuth` never elevates.
 *
 * Activation triggers, per pending membership's organization:
 *   - the org now runs `signup_approval_mode = 'auto_active'` (a brand-new
 *     signup would be active anyway, so keeping the old row pending protects
 *     nothing and only confuses the approval queue), or
 *   - the user's email is now VERIFIED and matches an auto-approve domain —
 *     this is how a verify-then-approve-by-domain org activates its
 *     email/password users the moment they click the verification link.
 *
 * Guards:
 *   - Runs only for `app_users.status = 'pending_approval'`; blocked /
 *     suspended / deactivated are explicit admin denials and are NEVER
 *     touched. The UPDATEs re-assert the pending status in their WHERE
 *     clauses, so a concurrent admin action wins.
 *   - A user-level activation requires at least one membership to activate.
 */
export async function reevaluatePendingActivation(input: {
  betterAuthUserId: string;
  email: string;
  emailVerified: boolean;
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
    .execute();
  if (memberships.length === 0) {
    return;
  }

  let activatedOrgId: string | null = null;
  let activatedReason: SignupDecisionReason | null = null;
  for (const membership of memberships) {
    const policy = await getAuthPolicyForOrg(membership.organization_id);
    const decision = decideInitialStatus(policy, {
      // Judge the membership by how it was created; fall back to the
      // current sign-in's provider for legacy rows without a source.
      provider: isAuthMethod(membership.source_provider)
        ? membership.source_provider
        : input.provider,
      email: input.email,
      emailVerified: input.emailVerified,
    });
    if (decision.status !== "active") {
      continue;
    }
    await db
      .updateTable("app_organization_memberships")
      .set({ status: "active", updated_at: sql`now()` })
      .where("id", "=", membership.id)
      .where("status", "=", "pending_approval")
      .execute();
    activatedOrgId = membership.organization_id;
    activatedReason = decision.reason;
  }
  if (!activatedOrgId) {
    return;
  }

  await db
    .updateTable("app_users")
    .set({ status: "active", updated_at: sql`now()` })
    .where("id", "=", user.id)
    .where("status", "=", "pending_approval")
    .execute();

  await auditEvent({
    eventType: "auth.account.auto_activated",
    outcome: "success",
    actorBetterAuthUserId: input.betterAuthUserId,
    appUserId: user.id,
    organizationId: activatedOrgId,
    provider: input.provider,
    email: input.email,
    metadata: {
      from: "pending_approval",
      decisionReason: activatedReason,
      trigger: "sign_in_reevaluation",
    },
  });
}

function isAuthMethod(value: string | null): value is AuthMethod {
  return value === "email" || value === "google" || value === "microsoft" || value === "github";
}
