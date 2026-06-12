import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Button } from "@/components/ui/button";
import { NewOrganizationForm } from "./_new-organization-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/organizations/new
 *
 * Server entry for the create-organization form (docs/admin-manager.md §19).
 * Gated on `admin.orgs.create`.
 */
export default async function AdministratorNewOrganizationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.orgs.create");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.orgs" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <Button asChild variant="link" className="h-auto px-0 text-sm">
          <LocaleLink locale={locale} href="/app/administrator/organizations">
            ← {t("backToList")}
          </LocaleLink>
        </Button>
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>
      <NewOrganizationForm locale={locale} />
    </section>
  );
}
