import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { isSuperadmin, resolveOrgScope } from "@/lib/admin/access-scope.server";
import { NewRoleForm } from "./_new-role-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/roles/new
 *
 * Server entry for the create-role form (docs/admin-manager.md §8.4).
 * Gated on `admin.roles.create`.
 *
 * A SUPERADMIN may create a Global role or scope it to any org (the picker
 * is shown). An ORG ADMIN may only create a role in their own org, so the
 * picker is hidden and their org is sent as the default.
 */
export default async function AdministratorNewRolePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.roles.create");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.roles" });

  const superadmin = isSuperadmin(guard.access);
  const scope = resolveOrgScope(guard.access);
  // SUPERADMIN defaults to Global (null); an org admin defaults to their org.
  const defaultOrganizationId = superadmin
    ? null
    : scope?.kind === "org"
      ? scope.organizationId
      : null;

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>
      <NewRoleForm
        locale={locale}
        showOrgPicker={superadmin}
        defaultOrganizationId={defaultOrganizationId}
      />
    </section>
  );
}
