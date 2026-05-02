import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { AdministratorEnterpriseAppsGrid } from "./_enterprise-apps-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/enterprise-apps
 *
 * Server entry point for the enterprise applications list (docs/admin-manager.md
 * §8.10, Phase 6). Re-validates the caller holds `admin.apps.read`
 * (defence-in-depth on top of the layout) and renders the client
 * `DataGrid` which fetches `/api/administrator/enterprise-apps`.
 *
 * The "New application" CTA is hidden (not just disabled) when the
 * caller lacks `admin.apps.manage` so the screen never advertises an
 * action the user cannot complete.
 */
export default async function AdministratorEnterpriseAppsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.apps.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canManage = guard.access.permissions.includes("admin.apps.manage");

  const t = await getTranslations({ locale, namespace: "administrator.enterpriseApps" });

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {canManage ? (
          <Button asChild size="sm">
            <LocaleLink locale={locale} href="/app/administrator/enterprise-apps/new">
              {t("newButton")}
            </LocaleLink>
          </Button>
        ) : null}
      </div>
      <AdministratorEnterpriseAppsGrid locale={locale} canManage={canManage} />
    </section>
  );
}
