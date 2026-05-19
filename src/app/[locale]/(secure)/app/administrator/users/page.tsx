import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { AdministratorUsersGrid } from "./_users-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/users
 *
 * Server entry point for the users list. Re-validates the caller holds
 * `admin.users.read` (defense-in-depth on top of the layout) and then
 * renders the client `DataGrid` which will hit
 * `/api/administrator/users` for paginated data.
 *
 * Header surfaces the "New user" CTA when the caller also holds
 * `admin.users.create`. The CTA is hidden (not just disabled) when the
 * permission is missing so the screen never advertises an action the
 * caller cannot complete.
 */
export default async function AdministratorUsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.users.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canCreate = guard.access.permissions.includes("admin.users.create");

  const t = await getTranslations({ locale, namespace: "administrator.users" });

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <AdministratorUsersGrid
        locale={locale}
        headerActions={
          canCreate ? (
            <Button asChild size="sm">
              <LocaleLink locale={locale} href="/app/administrator/users/new">
                {t("newButton")}
              </LocaleLink>
            </Button>
          ) : null
        }
      />
    </section>
  );
}
