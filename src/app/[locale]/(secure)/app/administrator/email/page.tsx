import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { AdministratorOutboxGrid } from "./_outbox-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/email
 *
 * Email outbox explorer (specs.md §35). Every outbound email is
 * recorded in `app_outbox` before any delivery attempt, so this grid is
 * the operator's source of truth for what the system tried to send —
 * including environments with no delivery provider configured, where
 * rows are kept as `logged`.
 *
 * Caller MUST hold `admin.email.read`; the "send test email" action in
 * the toolbar additionally requires `admin.email.manage`.
 */
export default async function AdministratorEmailPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.email.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }
  const manageGuard = await checkAdminPermissionServer("admin.email.manage");
  const canManage = manageGuard !== "denied" && manageGuard !== "unauthenticated";

  const t = await getTranslations({ locale, namespace: "administrator.email" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AdministratorOutboxGrid canManage={canManage} />
    </section>
  );
}
