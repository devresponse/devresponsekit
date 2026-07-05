import "server-only";
import { db } from "@/db/database";
import {
  resolveProviderOrganization,
  type ProviderOrganizationInput,
} from "@/lib/provider-organization-resolver";

/**
 * Runtime-configurable signup/authentication policy (migration 0007).
 *
 * Replaces the two previously hardcoded workflow decisions — mandatory email
 * verification (auth.ts) and mandatory admin approval (user-provisioning) —
 * with per-organization settings persisted in
 * `app_organization_auth_settings`.
 *
 * Resolution order:
 *   1. the organization's own row (a COMPLETE policy, no per-field merge);
 *   2. the platform-default row (`organization_id IS NULL`, seeded by 0007
 *      to today's behavior);
 *   3. `FAIL_CLOSED_AUTH_POLICY` — the strictest workflow.
 *
 * Threat / contract:
 *   - Every failure mode (missing rows, malformed values, DB errors during
 *     signup-time resolution) must degrade to the STRICTEST policy, never a
 *     more permissive one. Fail-closed here means "verification + admin
 *     approval", which is exactly the pre-0007 hardcoded workflow.
 *   - `auto_approve_email_domains` is only honored for VERIFIED emails
 *     (see `decideInitialStatus`), so an unproven address can never ride a
 *     domain match into an active membership.
 *   - `signup_approval_mode = 'auto_active'` intentionally activates anyone
 *     who completes signup for that org — the org admin's explicit choice.
 */

export type AuthMethod = "email" | "google" | "microsoft" | "github";
export type SignupApprovalMode = "admin_approval" | "auto_active" | "invite_only";

const APPROVAL_MODES: readonly SignupApprovalMode[] = [
  "admin_approval",
  "auto_active",
  "invite_only",
];

export interface OrgAuthPolicy {
  requireEmailVerification: boolean;
  signupApprovalMode: SignupApprovalMode;
  /** `null` = every enabled auth method is accepted. */
  allowedAuthMethods: AuthMethod[] | null;
  /** Lowercased domains; `null` = no domain auto-approval. */
  autoApproveEmailDomains: string[] | null;
  /** Where the policy came from — surfaced in audit metadata. */
  source: "organization" | "platform_default" | "fail_closed";
}

const AUTH_METHODS: readonly AuthMethod[] = ["email", "google", "microsoft", "github"];

export const FAIL_CLOSED_AUTH_POLICY: OrgAuthPolicy = Object.freeze({
  requireEmailVerification: true,
  signupApprovalMode: "admin_approval",
  allowedAuthMethods: null,
  autoApproveEmailDomains: null,
  source: "fail_closed",
});

/**
 * Loads the effective policy for an organization (org row → platform default
 * → fail-closed). Pass `null` to resolve the platform default itself, e.g.
 * when the target organization does not exist yet (it will be auto-created
 * by provisioning and starts without a policy row anyway).
 */
export async function getAuthPolicyForOrg(organizationId: string | null): Promise<OrgAuthPolicy> {
  const rows = await db
    .selectFrom("app_organization_auth_settings")
    .select([
      "organization_id",
      "require_email_verification",
      "signup_approval_mode",
      "allowed_auth_methods",
      "auto_approve_email_domains",
    ])
    .where((eb) =>
      organizationId
        ? eb.or([eb("organization_id", "=", organizationId), eb("organization_id", "is", null)])
        : eb("organization_id", "is", null),
    )
    .execute();

  const orgRow = organizationId
    ? rows.find((r) => r.organization_id === organizationId)
    : undefined;
  const defaultRow = rows.find((r) => r.organization_id === null);
  const row = orgRow ?? defaultRow;
  if (!row) {
    return FAIL_CLOSED_AUTH_POLICY;
  }
  return toPolicy(row, orgRow ? "organization" : "platform_default");
}

interface PolicyRow {
  require_email_verification: boolean;
  signup_approval_mode: string;
  allowed_auth_methods: string[] | null;
  auto_approve_email_domains: string[] | null;
}

function isApprovalMode(value: string): value is SignupApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

function toPolicy(row: PolicyRow, source: OrgAuthPolicy["source"]): OrgAuthPolicy {
  // The mode is CHECK-constrained in the DB; an unknown value can only mean
  // schema drift or a bypassed write path — fail closed rather than guess.
  if (!isApprovalMode(row.signup_approval_mode)) {
    return FAIL_CLOSED_AUTH_POLICY;
  }
  const methods =
    row.allowed_auth_methods === null
      ? null
      : row.allowed_auth_methods.filter((m): m is AuthMethod =>
          (AUTH_METHODS as readonly string[]).includes(m),
        );
  return {
    requireEmailVerification: row.require_email_verification,
    signupApprovalMode: row.signup_approval_mode,
    allowedAuthMethods: methods,
    autoApproveEmailDomains:
      row.auto_approve_email_domains === null
        ? null
        : row.auto_approve_email_domains.map((d) => d.trim().toLowerCase()).filter(Boolean),
    source,
  };
}

/**
 * Admin-curated email-domain routing: an `app_provider_organizations` row
 * with `provider = 'email'` maps an email domain to an organization for
 * email/password signups (which otherwise land in the `default` org). Rows
 * are currently created out-of-band (SQL / a follow-up admin UI); absence
 * simply means "no routing".
 */
export async function findEmailDomainOrganization(
  email: string,
): Promise<{ organizationId: string; providerOrganizationKey: string } | null> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) {
    return null;
  }
  const row = await db
    .selectFrom("app_provider_organizations")
    .select(["organization_id", "provider_organization_key"])
    .where("provider", "=", "email")
    .where("provider_organization_key", "=", domain)
    .executeTakeFirst();
  return row
    ? {
        organizationId: row.organization_id,
        providerOrganizationKey: row.provider_organization_key,
      }
    : null;
}

/**
 * Resolves the policy that governs a sign-up BEFORE the user exists — used by
 * the `user.create.before` database hook to decide whether the new identity
 * needs email verification. Mirrors provisioning's org resolution (provider
 * metadata → email-domain routing → default org) so the verification decision
 * and the eventual membership always follow the same organization's policy.
 *
 * Never throws: any resolution error degrades to `FAIL_CLOSED_AUTH_POLICY`
 * (and is logged), because a DB hiccup during signup must strengthen the
 * workflow, not weaken it.
 */
export async function resolveSignupPolicy(
  input: ProviderOrganizationInput,
): Promise<OrgAuthPolicy> {
  try {
    const resolution = resolveProviderOrganization(input);

    if (resolution.providerOrganizationKey !== "default") {
      const org = await db
        .selectFrom("app_organizations")
        .select(["id"])
        .where("slug", "=", resolution.providerOrganizationKey)
        .executeTakeFirst();
      // A not-yet-created org has no policy row by definition — the platform
      // default governs its first member.
      return await getAuthPolicyForOrg(org?.id ?? null);
    }

    if (input.provider === "email") {
      const mapped = await findEmailDomainOrganization(input.email);
      if (mapped) {
        return await getAuthPolicyForOrg(mapped.organizationId);
      }
    }

    const defaultOrg = await db
      .selectFrom("app_organizations")
      .select(["id"])
      .where("slug", "=", "default")
      .executeTakeFirst();
    return await getAuthPolicyForOrg(defaultOrg?.id ?? null);
  } catch (error) {
    const { logServerError } = await import("@/lib/observability/logger.server");
    logServerError("signup policy resolution failed; failing closed", { err: error });
    return FAIL_CLOSED_AUTH_POLICY;
  }
}

export type SignupDecisionReason =
  | "auth_method_not_allowed"
  | "invitation"
  | "auto_active"
  | "domain_auto_approved"
  | "invite_required"
  | "admin_approval";

export interface SignupStatusDecision {
  status: "active" | "pending_approval";
  reason: SignupDecisionReason;
}

/**
 * Pure policy → initial-status decision for a NEW user/membership.
 *
 * Order matters:
 *   1. a disallowed auth method always parks the signup in
 *      `pending_approval` (visible to admins, never silently dropped) —
 *      even for invited or `auto_active` signups;
 *   2. a valid invitation activates immediately — the invitation IS the
 *      approval (0008); callers set `hasValidInvitation` only after the
 *      token and the email-match rule have been verified;
 *   3. `auto_active` activates immediately;
 *   4. a VERIFIED email on an auto-approve domain activates immediately;
 *   5. `invite_only` parks everything else in `pending_approval`
 *      (`invite_required`) — uninvited signups are never silently dropped;
 *   6. everything else awaits admin approval.
 */
export function decideInitialStatus(
  policy: OrgAuthPolicy,
  input: {
    provider: AuthMethod;
    email: string;
    emailVerified: boolean;
    hasValidInvitation?: boolean;
  },
): SignupStatusDecision {
  if (policy.allowedAuthMethods !== null && !policy.allowedAuthMethods.includes(input.provider)) {
    return { status: "pending_approval", reason: "auth_method_not_allowed" };
  }
  if (input.hasValidInvitation) {
    return { status: "active", reason: "invitation" };
  }
  if (policy.signupApprovalMode === "auto_active") {
    return { status: "active", reason: "auto_active" };
  }
  const domain = input.email.split("@")[1]?.trim().toLowerCase();
  if (
    input.emailVerified &&
    domain &&
    policy.autoApproveEmailDomains !== null &&
    policy.autoApproveEmailDomains.includes(domain)
  ) {
    return { status: "active", reason: "domain_auto_approved" };
  }
  if (policy.signupApprovalMode === "invite_only") {
    return { status: "pending_approval", reason: "invite_required" };
  }
  return { status: "pending_approval", reason: "admin_approval" };
}
