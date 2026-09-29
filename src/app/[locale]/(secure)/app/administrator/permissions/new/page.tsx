import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { hasCrossOrgReach } from "@/lib/admin/access-scope.server";
import { NewPermissionForm } from "./_new-permission-form";

export const dynamic = "force-dynamic";

/**
 * Administrator → New permission page (docs/admin-manager.md §8.5).
 *
 * RSC entry point that gates on `admin.permissions.manage` AND cross-org
 * reach and renders a client-side form (`NewPermissionForm`), following the
 * same new-record pattern as `users/new`. The form `POST`s to
 * `/api/administrator/permissions`, which is SUPERADMIN-only, so the page
 * guard must equal the mutation's authority (F-66, as review #73 did for the
 * email-template editor).
 */
export default async function AdministratorNewPermissionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  const guard = await checkAdminPermissionServer("admin.permissions.manage");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  // F-66: an org admin holding the key got a form whose every submit 403'd.
  if (!hasCrossOrgReach(guard.access)) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.permissions" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("new.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("new.description")}</p>
      </div>

      <NewPermissionForm locale={locale} />
    </section>
  );
}
