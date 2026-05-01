import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import type { ReactNode } from "react";

/**
 * Only supported locale segments are valid. Without this, dotted asset
 * requests such as `/favicon.png` can fall through to the `[locale]`
 * segment at runtime and force a static page into dynamic rendering.
 */
export const dynamicParams = false;

/**
 * LocaleLayout
 *
 * Validates the locale segment and provides translated messages to all
 * descendants (public, auth, and secure routes). Unknown locales 404
 * instead of falling back so URLs remain unambiguous.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Required by next-intl when using static rendering with
  // dynamic locale segments.
  setRequestLocale(locale);

  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div data-locale={locale}>{children}</div>
    </NextIntlClientProvider>
  );
}

/**
 * Pre-renders the locale segment for every supported locale at build time.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
