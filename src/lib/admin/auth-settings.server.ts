import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import type { AuthPolicySettingsInput } from "@/lib/validation/auth-policy";

/**
 * Admin accessors for `app_organization_auth_settings` —
 * the per-organization signup policy. Shared by the administrator API
 * routes AND the org-detail RSC page (which loads initial values directly,
 * per the admin architecture).
 *
 * Threat / contract:
 *   - These helpers do NOT scope: callers MUST have already authorized the
 *     target (`canAccessOrg` for an org row). The platform-default row
 *     (`organizationId = null`) is the policy every tenant inherits, so a
 *     route handler gates it on `hasCrossOrgReach` — NOT `isSuperadmin`,
 *     which is also true for an ORG-BOUND bearer credential owned by a
 *     superuser (MACHINE-2; see `api/administrator/auth-settings/defaults`).
 *     The RSC pages only ever see a cookie session, where the two agree;
 *     the org detail page also reads the row (never writes it) to show an
 *     org with no override what it inherits.
 *   - Rows are stored normalized (lowercased, deduped domains/methods) so
 *     the signup-time resolver never has to guess.
 */

export interface OrgAuthSettingsRow {
  organizationId: string | null;
  requireEmailVerification: boolean;
  signupApprovalMode: string;
  allowedAuthMethods: string[] | null;
  autoApproveEmailDomains: string[] | null;
  updatedAt: Date | null;
}

/**
 * The raw policy row for one org (`null` when the org inherits the platform
 * default) — pass `organizationId = null` for the platform-default row
 * itself. No fallback resolution here; for the EFFECTIVE policy use
 * `getAuthPolicyForOrg` (auth-policy.server.ts).
 */
export async function getOrgAuthSettingsRow(
  organizationId: string | null,
): Promise<OrgAuthSettingsRow | null> {
  const row = await db
    .selectFrom("app_organization_auth_settings")
    .select([
      "organization_id",
      "require_email_verification",
      "signup_approval_mode",
      "allowed_auth_methods",
      "auto_approve_email_domains",
      "updated_at",
    ])
    .where((eb) =>
      organizationId
        ? eb("organization_id", "=", organizationId)
        : eb("organization_id", "is", null),
    )
    .executeTakeFirst();
  if (!row) {
    return null;
  }
  return {
    organizationId: row.organization_id,
    requireEmailVerification: row.require_email_verification,
    signupApprovalMode: row.signup_approval_mode,
    allowedAuthMethods: row.allowed_auth_methods,
    autoApproveEmailDomains: row.auto_approve_email_domains,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : null,
  };
}

function normalize(values: AuthPolicySettingsInput): AuthPolicySettingsInput {
  return {
    requireEmailVerification: values.requireEmailVerification,
    signupApprovalMode: values.signupApprovalMode,
    allowedAuthMethods:
      values.allowedAuthMethods === null ? null : [...new Set(values.allowedAuthMethods)],
    autoApproveEmailDomains:
      values.autoApproveEmailDomains === null
        ? null
        : [...new Set(values.autoApproveEmailDomains.map((d) => d.trim().toLowerCase()))],
  };
}

/**
 * Creates or replaces the policy row for `organizationId` (or the platform
 * default when null). The row is a COMPLETE policy, so upsert semantics are
 * exact — no partial merge.
 *
 * One `INSERT … ON CONFLICT DO UPDATE` statement (F-97). It used to SELECT the
 * row and then UPDATE or INSERT, so a double-submit of an org's FIRST save
 * sent both requests down the insert branch and the loser failed on the
 * `organization_id` unique constraint with a 500. The conflict target is that
 * constraint for an org row, and for the platform-default row (NULL, which a
 * plain unique constraint never matches) 0001's partial unique index on
 * `((true)) WHERE organization_id IS NULL`.
 */
export async function upsertOrgAuthSettings(
  organizationId: string | null,
  values: AuthPolicySettingsInput,
  updatedBy: string,
): Promise<void> {
  const v = normalize(values);
  const policy = {
    require_email_verification: v.requireEmailVerification,
    signup_approval_mode: v.signupApprovalMode,
    allowed_auth_methods: v.allowedAuthMethods,
    auto_approve_email_domains: v.autoApproveEmailDomains,
    updated_by: updatedBy,
  };
  await db
    .insertInto("app_organization_auth_settings")
    .values({ organization_id: organizationId, ...policy })
    .onConflict((oc) =>
      (organizationId === null
        ? oc.expression(sql`(true)`).where("organization_id", "is", null)
        : oc.column("organization_id")
      ).doUpdateSet({ ...policy, updated_at: sql`now()` }),
    )
    .execute();
}

/**
 * Removes an org's policy override so it reverts to the platform default.
 * Returns false when there was nothing to remove. Never used for the
 * platform-default row — the baseline must always exist (the resolver
 * fails closed if it somehow doesn't, but deleting it is a footgun the
 * API deliberately does not expose).
 */
export async function deleteOrgAuthSettings(organizationId: string): Promise<boolean> {
  const result = await db
    .deleteFrom("app_organization_auth_settings")
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  return result.numDeletedRows > 0n;
}
