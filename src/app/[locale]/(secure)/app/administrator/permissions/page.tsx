import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { AdministratorPermissionsGrid } from "./_permissions-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/permissions
 *
 * Permission-catalog management view (docs/admin-manager.md §8.7).
 * Visible to anyone with `admin.roles.read`; mutating endpoints are
 * additionally gated on `admin.permissions.manage` and the create /
 * edit / delete buttons hide themselves when the caller lacks it.
 */
export default async function AdministratorPermissionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.roles.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canManage = guard.access.permissions.includes("admin.permissions.manage");

  const t = await getTranslations({ locale, namespace: "administrator.permissions" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AdministratorPermissionsGrid
        canManage={canManage}
        headerActions={
          canManage ? (
            <Button asChild size="sm">
              <LocaleLink locale={locale} href="/app/administrator/permissions/new">
                {t("newButton")}
              </LocaleLink>
            </Button>
          ) : undefined
        }
      />
    </section>
  );
}
