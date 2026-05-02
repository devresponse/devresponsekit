import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { AdministratorMembershipsGrid } from "./_memberships-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/memberships
 *
 * Server entry point for the cross-org memberships search (docs/admin-manager.md §19).
 * Re-validates the caller holds `admin.orgs.read` (defence-in-depth on
 * top of the layout) and renders the client `DataGrid` which fetches
 * `/api/administrator/memberships` for paginated data.
 */
export default async function AdministratorMembershipsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.orgs.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.memberships" });

  return (
    <section className="space-y-4 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
      </div>
      <AdministratorMembershipsGrid locale={locale} />
    </section>
  );
}
