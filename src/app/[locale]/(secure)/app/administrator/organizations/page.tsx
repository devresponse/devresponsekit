import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
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

  const t = await getTranslations({ locale, namespace: "administrator.orgs" });

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {canCreate ? (
          <Button asChild size="sm">
            <LocaleLink locale={locale} href="/app/administrator/organizations/new">
              {t("newButton")}
            </LocaleLink>
          </Button>
        ) : null}
      </div>
      <AdministratorOrganizationsGrid locale={locale} canDelete={canDelete} />
    </section>
  );
}
