import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { getOrgAuthSettingsRow } from "@/lib/admin/auth-settings.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { AuthPolicyForm, type AuthPolicySettingsJson } from "@/components/admin/auth-policy-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AdministratorOrganizationsGrid } from "./_organizations-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/organizations
 *
 * Server entry point for the organizations list (docs/admin-manager.md §19).
 * Re-validates the caller holds `admin.orgs.read` (defence-in-depth on
 * top of the layout) and renders the client `DataGrid` which fetches
 * `/api/administrator/organizations` for paginated data.
 *
 * The "New organization" CTA is hidden (not just disabled) when the caller
 * lacks `admin.orgs.create` so the screen never advertises an action
 * the user cannot complete.
 */
export default async function AdministratorOrganizationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.orgs.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canCreate = guard.access.permissions.includes("admin.orgs.create");
  const canDelete = guard.access.permissions.includes("admin.orgs.delete");

  // Platform sign-up defaults (0007): SUPERADMIN-only card — editing this row
  // changes the signup workflow of every org without its own override.
  const superadmin = isSuperadmin(guard.access);
  const platformDefaults: AuthPolicySettingsJson | null = superadmin
    ? await getOrgAuthSettingsRow(null).then((row) =>
        row
          ? {
              requireEmailVerification: row.requireEmailVerification,
              signupApprovalMode:
                row.signupApprovalMode === "auto_active" ? "auto_active" : "admin_approval",
              allowedAuthMethods:
                row.allowedAuthMethods as AuthPolicySettingsJson["allowedAuthMethods"],
              autoApproveEmailDomains: row.autoApproveEmailDomains,
            }
          : null,
      )
    : null;

  const t = await getTranslations({ locale, namespace: "administrator.orgs" });

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <AdministratorOrganizationsGrid
        locale={locale}
        canDelete={canDelete}
        headerActions={
          canCreate ? (
            <Button asChild size="sm">
              <LocaleLink locale={locale} href="/app/administrator/organizations/new">
                {t("newButton")}
              </LocaleLink>
            </Button>
          ) : null
        }
      />

      {superadmin ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("authPolicy.platformTitle")}</CardTitle>
            <CardDescription>{t("authPolicy.platformDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <AuthPolicyForm
              endpoint="/api/administrator/auth-settings/defaults"
              scope="platform"
              initialSettings={platformDefaults}
              canUpdate
            />
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
