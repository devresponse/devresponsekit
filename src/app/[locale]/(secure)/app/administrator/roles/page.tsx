import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { AdministratorRolesGrid } from "./_roles-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/roles
 *
 * Server entry point for the roles list (docs/admin-manager.md §8.5).
 * Re-validates the caller holds `admin.roles.read` (defence-in-depth on
 * top of the layout) and renders the client `DataGrid` which fetches
 * `/api/administrator/roles` for paginated data.
 *
 * The "New role" CTA is hidden (not just disabled) when the caller
 * lacks `admin.roles.create` so the screen never advertises an action
 * the user cannot complete.
 */
export default async function AdministratorRolesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.roles.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canCreate = guard.access.permissions.includes("admin.roles.create");
  const canDelete = guard.access.permissions.includes("admin.roles.delete");
  const canDuplicate = canCreate;

  const t = await getTranslations({ locale, namespace: "administrator.roles" });

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        {canCreate ? (
          <Button asChild size="sm">
            <LocaleLink locale={locale} href="/app/administrator/roles/new">
              {t("newButton")}
            </LocaleLink>
          </Button>
        ) : null}
      </div>
      <AdministratorRolesGrid
        locale={locale}
        canDelete={canDelete}
        canDuplicate={canDuplicate}
      />
    </section>
  );
}
