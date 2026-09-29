import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { hasCrossOrgReach, isSuperadmin } from "@/lib/admin/access-scope.server";
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
 * the toolbar additionally requires `admin.email.manage`, and only a caller
 * with cross-org reach chooses its recipient (F-64): anyone else sends it to
 * their own address, which the toolbar fills in.
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
  // Review #75: derive the second permission from the context we already
  // hold instead of a second checkAdminPermissionServer() — that call repeated
  // the whole session + access-context resolution for an answer already in
  // `guard.access`. Mirrors the SUPERADMIN short-circuit the guard applies.
  const canManage =
    isSuperadmin(guard.access) || guard.access.permissions.includes("admin.email.manage");
  // F-64: the same rule the test route enforces.
  const testRecipient = hasCrossOrgReach(guard.access) ? null : guard.access.primaryEmail;

  const t = await getTranslations({ locale, namespace: "administrator.email" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AdministratorOutboxGrid canManage={canManage} testRecipient={testRecipient} />
    </section>
  );
}
