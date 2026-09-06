import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { getBrand } from "@/config/brand";

/**
 * Public "about" page (`/[locale]/about`).
 *
 * Still a one-paragraph stub — the substantive product copy lives on the
 * localized landing page (`(public)/page.tsx`, the `public.*` namespace) —
 * but its text now comes from the `public.about` message namespace in all
 * eight locales rather than the hardcoded English it shipped with, and it
 * carries `generateMetadata` like every other reachable page (review #225).
 * The heading stays the brand NAME, which is a proper noun and not
 * translated.
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
  const t = await getTranslations({ locale, namespace: "public.about" });
  const brand = getBrand();
  return { title: t("title"), description: t("body", { brand: brand.name }) };
}

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "public.about" });
  const brand = getBrand();

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-8">
      <h1 className="text-2xl font-semibold">{brand.name}</h1>
      <p className="text-foreground text-sm">{t("body", { brand: brand.name })}</p>
    </div>
  );
}
