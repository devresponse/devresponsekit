import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/db/database";
import { APP_ID_RE } from "@/lib/admin/enterprise-apps.server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { EnterpriseAppSettingsForm } from "./_enterprise-app-settings-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/enterprise-apps/[appId]
 *
 * Server entry for the enterprise application detail (docs/admin-manager.md
 * §8.10, Phase 6).
 *
 * The application id is a stable text primary key referenced by SSO
 * handoff nonces, so it is read-only here. All other mutable fields can
 * be edited inline by callers holding `admin.apps.manage`; callers with
 * only `admin.apps.read` get the same view in disabled mode.
 */
export default async function AdministratorEnterpriseAppDetailPage({
  params,
}: {
  params: Promise<{ locale: string; appId: string }>;
}) {
  const { locale, appId } = await params;

  const guard = await checkAdminPermissionServer("admin.apps.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  if (!APP_ID_RE.test(appId)) {
    notFound();
  }

  const row = await db
    .selectFrom("app_enterprise_applications as a")
    .leftJoin("app_organizations as o", "o.id", "a.organization_id")
    .select([
      "a.id",
      "a.label",
      "a.description",
      "a.origin",
      "a.subdomain",
      "a.sso_audience",
      "a.status",
      "a.sort_order",
      "a.organization_id",
      "o.slug as organization_slug",
    ])
    .where("a.id", "=", appId)
    .executeTakeFirst();
  if (!row) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.enterpriseApps" });

  const canManage = guard.access.permissions.includes("admin.apps.manage");

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Button asChild variant="link" className="h-auto px-0 text-sm">
            <LocaleLink locale={locale} href="/app/administrator/enterprise-apps">
              ← {t("backToList")}
            </LocaleLink>
          </Button>
          <h1 className="text-lg font-semibold">{row.label}</h1>
          <p className="text-muted-foreground text-sm">
            <code className="text-xs">{row.id}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={row.status} />
        </div>
      </div>

      <EnterpriseAppSettingsForm
        app={{
          id: row.id,
          label: row.label,
          description: row.description,
          origin: row.origin,
          subdomain: row.subdomain,
          ssoAudience: row.sso_audience,
          status: row.status,
          sortOrder: row.sort_order,
          organizationSlug: row.organization_slug,
        }}
        canManage={canManage}
      />
    </section>
  );
}
