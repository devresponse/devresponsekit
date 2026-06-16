import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { checkAdminPermissionServer } from "@/lib/admin/permissions.server";
import { NewGroupForm } from "./_new-group-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/administrator/groups/new
 *
 * Create-group form (ADR-0002). Caller MUST hold `admin.groups.create`.
 */
export default async function NewGroupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const guard = await checkAdminPermissionServer("admin.groups.create");
  if (guard === "denied" || guard === "unauthenticated") {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: "administrator.groups" });

  return (
    <section className="space-y-4 p-6">
      <h1 className="text-lg font-semibold">{t("new.title")}</h1>
      <NewGroupForm locale={locale} />
    </section>
  );
}
