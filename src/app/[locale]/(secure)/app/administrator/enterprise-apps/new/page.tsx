import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/db/database";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { resolveOrgScope } from "@/lib/admin/access-scope.server";
import { NewEnterpriseAppForm } from "./_new-enterprise-app-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/enterprise-apps/new
 *
 * Server entry for the create-application form (docs/admin-manager.md
 * §8.7). Gated on `admin.apps.manage`.
 *
 * R14: the page resolves the caller's scope with the rule `POST
 * /api/administrator/enterprise-apps` applies (`resolveOrgScope`, so
 * `hasCrossOrgReach` decides). A caller with cross-org reach gets the
 * organization picker and may create a global app; an org-confined caller's
 * active org is passed as plain data, with its slug, because the route refuses
 * that caller a global app and any name outside the slug (I-01). A confined
 * caller with no resolvable org gets neither, and the route refuses its create.
 */
export default async function AdministratorNewEnterpriseAppPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.apps.manage");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.enterpriseApps" });

  const scope = resolveOrgScope(guard.access);
  const ownOrganization =
    scope?.kind === "org"
      ? ((await db
          .selectFrom("app_organizations")
          .select(["id", "slug"])
          .where("id", "=", scope.organizationId)
          .executeTakeFirst()) ?? null)
      : null;

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>
      <NewEnterpriseAppForm
        locale={locale}
        showOrgPicker={scope?.kind === "all"}
        ownOrganization={ownOrganization}
      />
    </section>
  );
}
