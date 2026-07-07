import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { getOrgAuthSettingsRow } from "@/lib/admin/auth-settings.server";
import { AdminError, loadOrgOrThrow } from "@/lib/admin/orgs.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import type { AuthPolicySettingsJson } from "@/components/admin/auth-policy-form";
import {
  AUTH_POLICY_APPROVAL_MODES,
  type AuthPolicyApprovalMode,
} from "@/lib/validation/auth-policy";
import { OrganizationDetailTabs } from "./_organization-detail-tabs";
import type { OrgAuthSettingsRow } from "@/lib/admin/auth-settings.server";

/** JSON-safe projection for the client tabs (drops updatedAt/organizationId). */
function toAuthPolicyJson(row: OrgAuthSettingsRow | null): AuthPolicySettingsJson | null {
  if (!row) return null;
  // Pass every known mode through (a two-way ternary here once silently
  // downgraded `invite_only` to admin approval in the editor); unknown
  // values render as the strictest mode, matching the resolver's fail-closed.
  const mode = (AUTH_POLICY_APPROVAL_MODES as readonly string[]).includes(row.signupApprovalMode)
    ? (row.signupApprovalMode as AuthPolicyApprovalMode)
    : "admin_approval";
  return {
    requireEmailVerification: row.requireEmailVerification,
    signupApprovalMode: mode,
    allowedAuthMethods: row.allowedAuthMethods as AuthPolicySettingsJson["allowedAuthMethods"],
    autoApproveEmailDomains: row.autoApproveEmailDomains,
  };
}

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/organizations/[orgId]
 *
 * Server entry for the organization detail (docs/admin-manager.md §8.2).
 *
 * Loads the organization + its counts via the shared `loadOrgOrThrow`
 * helper so the members, providers tables render the right counts on
 * first paint without a client round-trip.
 *
 * Tabs (rendered client-side):
 *   - Members   — paginated grid of memberships
 *   - Providers — paginated grid of provider bindings
 *   - Settings  — name/slug/status editor
 */
export default async function AdministratorOrganizationDetailPage({
  params,
}: {
  params: Promise<{ locale: string; orgId: string }>;
}) {
  const { locale, orgId } = await params;

  const guard = await checkAdminPermissionServer("admin.orgs.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  if (!isUuid(orgId)) {
    notFound();
  }

  let org;
  try {
    org = await loadOrgOrThrow(orgId);
  } catch (err) {
    if (err instanceof AdminError && err.code === "organization_not_found") {
      notFound();
    }
    throw err;
  }

  // ADR-0001: an org admin may only view their own org. notFound() (not
  // 403) preserves existence indistinguishability for foreign orgs.
  if (!canAccessOrg(guard.access, org.id)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.orgs" });

  const canUpdate = guard.access.permissions.includes("admin.orgs.update");

  // Initial rows for the Authentication tab (0007): the org's override (null
  // = inheriting) and the platform default it would inherit. Loaded here —
  // AFTER the canAccessOrg gate above — so the client tab needs no fetch.
  const [authSettings, platformAuthDefaults] = await Promise.all([
    getOrgAuthSettingsRow(org.id),
    getOrgAuthSettingsRow(null),
  ]);

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{org.name}</h1>
          <p className="text-muted-foreground text-sm">
            <code className="text-xs">{org.slug}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={org.status} />
          {org.is_default ? <Badge variant="secondary">{t("defaultYes")}</Badge> : null}
        </div>
      </div>

      <OrganizationDetailTabs
        org={{
          id: org.id,
          slug: org.slug,
          name: org.name,
          status: org.status,
          isDefault: org.is_default,
          memberCount: org.member_count,
          bindingCount: org.binding_count,
        }}
        canUpdate={canUpdate}
        authSettings={toAuthPolicyJson(authSettings)}
        platformAuthDefaults={toAuthPolicyJson(platformAuthDefaults)}
      />
    </section>
  );
}
