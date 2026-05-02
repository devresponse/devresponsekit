import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

/**
 * Administrator landing page.
 *
 * Phase 1 keeps this intentionally minimal — a localized title and
 * description. Phase 2+ replaces the body with KPI cards
 * (docs/admin-manager.md §8.1). Each KPI will be permission-gated and
 * fall back to an `Empty` placeholder when the caller lacks the read
 * permission for that area.
 */
export default async function AdministratorPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "administrator.overview" });

  return (
    <section className="space-y-3 p-6">
      <h1 className="text-lg font-semibold">{t("title")}</h1>
      <p className="text-sm text-neutral-600">{t("description")}</p>
    </section>
  );
}
