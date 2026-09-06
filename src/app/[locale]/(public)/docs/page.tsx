import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";

/**
 * Public documentation index (`/[locale]/docs`).
 *
 * Deliberately a SIGNPOST, not a documentation renderer: the full guide
 * catalog lives behind sign-in at `/[locale]/app/docs`, which reads
 * `docs/` through the docs viewer. This page exists so the public shell's
 * "Documentation" entry resolves to something, and its copy now comes from
 * the `public.docs` message namespace in all eight locales instead of the
 * hardcoded English placeholder it shipped with (review #225).
 *
 * The `(public)` layout owns the document's single `<main>` landmark, so
 * the page root is a plain element (review #104).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "public.docs" });
  return { title: t("title"), description: t("body") };
}

export default async function DocsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "public.docs" });

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-foreground text-sm">{t("body")}</p>
    </div>
  );
}
