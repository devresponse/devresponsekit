import { useTranslations } from "next-intl";

/**
 * AboutPage
 *
 * Public marketing page at `/[locale]/about`. Server Component.
 * Part of the `(public)` route group; no authentication required.
 * Does not call secure menu APIs.
 */
export default function AboutPage() {
  const t = useTranslations("common");
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-2xl font-semibold">{t("appName")}</h1>
      <p className="text-sm text-neutral-700">
        DevResponse Enterprise Platform — public marketing/landing content goes here.
      </p>
    </main>
  );
}
