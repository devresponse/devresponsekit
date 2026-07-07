import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { LocaleLink } from "@/components/i18n/locale-link";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { AdministratorApiKeysGrid } from "./_api-keys-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/api-keys
 *
 * Server entry point for the API-key governance console
 * (docs/admin-manager.md §8.8). Read-only callers need
 * `admin.apikeys.read`; the revoke / rotate / issue actions are gated
 * client-side on `admin.apikeys.manage` (and re-checked on every API
 * route), so a read-only admin sees the inventory without the
 * destructive controls.
 */
export default async function AdministratorApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.apikeys.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const canManage = guard.access.permissions.includes("admin.apikeys.manage");

  const t = await getTranslations({ locale, namespace: "administrator.apiKeys" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AdministratorApiKeysGrid
        locale={locale}
        canManage={canManage}
        headerActions={
          canManage ? (
            <Button asChild size="sm">
              <LocaleLink locale={locale} href="/app/administrator/api-keys/new">
                {t("newButton")}
              </LocaleLink>
            </Button>
          ) : null
        }
      />
    </section>
  );
}
