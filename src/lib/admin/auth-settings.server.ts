import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import type { AuthPolicySettingsInput } from "@/lib/validation/auth-policy";

/**
 * Admin accessors for `app_organization_auth_settings` (migration 0007) —
 * the per-organization signup policy. Shared by the administrator API
 * routes AND the org-detail RSC page (which loads initial values directly,
 * per the admin architecture).
 *
 * Threat / contract:
 *   - These helpers do NOT scope: callers MUST have already authorized the
 *     target (`canAccessOrg` for an org row; `isSuperadmin` for the
 *     platform-default row, `organizationId = null`). The org detail page
 *     and every route handler perform that check before calling in.
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
 */
export async function upsertOrgAuthSettings(
  organizationId: string | null,
  values: AuthPolicySettingsInput,
  updatedBy: string,
): Promise<void> {
  const v = normalize(values);
  const existing = await db
    .selectFrom("app_organization_auth_settings")
    .select(["id"])
    .where((eb) =>
      organizationId
        ? eb("organization_id", "=", organizationId)
        : eb("organization_id", "is", null),
    )
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable("app_organization_auth_settings")
      .set({
        require_email_verification: v.requireEmailVerification,
        signup_approval_mode: v.signupApprovalMode,
        allowed_auth_methods: v.allowedAuthMethods,
        auto_approve_email_domains: v.autoApproveEmailDomains,
        updated_by: updatedBy,
        updated_at: sql`now()`,
      })
      .where("id", "=", existing.id)
      .execute();
    return;
  }

  await db
    .insertInto("app_organization_auth_settings")
    .values({
      organization_id: organizationId,
      require_email_verification: v.requireEmailVerification,
      signup_approval_mode: v.signupApprovalMode,
      allowed_auth_methods: v.allowedAuthMethods,
      auto_approve_email_domains: v.autoApproveEmailDomains,
      updated_by: updatedBy,
    })
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
