import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { AdministratorAuditGrid } from "./_audit-grid";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/audit
 *
 * Server entry point for the audit explorer (docs/admin-manager.md
 * §8.11, Phase 6). Read-only — caller MUST hold `admin.audit.read`.
 *
 * The page itself is a thin wrapper around the client `AdministratorAuditGrid`
 * which fetches `/api/administrator/audit` and renders a paginated grid
 * with an inline filter toolbar and a per-row detail `Sheet` showing the
 * full JSON metadata, IP, user agent, and reason fields.
 */
export default async function AdministratorAuditPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.audit.read");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.audit" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>
      <AdministratorAuditGrid />
    </section>
  );
}
