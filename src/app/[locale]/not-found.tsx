"use client";

import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";

/**
 * Localized 404 (P2-14). Renders inside the [locale] layout, so it inherits
 * the theme + NextIntlClientProvider — replacing Next.js's unstyled,
 * English-only built-in not-found for the ~50 notFound() call sites (the
 * ADR-0001 404-not-403 pattern leans on this heavily). A Client Component so
 * `useTranslations` resolves against the provider regardless of which segment
 * triggered notFound().
 */
export default function NotFound() {
  const t = useTranslations("notFound");
  return (
    <section className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground max-w-md text-sm">{t("description")}</p>
      </div>
      <LocaleLink
        href="/"
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors"
      >
        {t("home")}
      </LocaleLink>
    </section>
  );
}
