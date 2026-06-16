import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { AdministratorGroupsGrid } from "./_groups-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/groups
 *
 * Organization groups list (ADR-0002). Re-validates `admin.groups.read`
 * (defence-in-depth on the layout) and renders the client grid that fetches
 * `/api/administrator/groups`. The "New group" CTA is hidden unless the
 * caller holds `admin.groups.create`.
 */
export default async function AdministratorGroupsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.groups.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canCreate = guard.access.permissions.includes("admin.groups.create");
  const canDelete = guard.access.permissions.includes("admin.groups.delete");

  const t = await getTranslations({ locale, namespace: "administrator.groups" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AdministratorGroupsGrid
        locale={locale}
        canDelete={canDelete}
        headerActions={
          canCreate ? (
            <Button asChild size="sm">
              <LocaleLink locale={locale} href="/app/administrator/groups/new">
                {t("newButton")}
              </LocaleLink>
            </Button>
          ) : null
        }
      />
    </section>
  );
}
