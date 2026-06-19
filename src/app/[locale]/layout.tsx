import "@/app/globals.css";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { ThemeProvider } from "@/components/theme/theme-provider";
import type { ReactNode } from "react";

/**
 * Only supported locale segments are valid. Without this, dotted asset
 * requests such as `/favicon.png` can fall through to the `[locale]`
 * segment at runtime and force a static page into dynamic rendering.
 */
export const dynamicParams = false;

export const metadata: Metadata = {
  title: {
    default: "DevResponse Enterprise Platform",
    template: "%s · DevResponse",
  },
  description: "Enterprise application shell.",
  icons: {
    icon: "/favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * LocaleLayout — the root layout for every localized route (§28.1).
 *
 * Owns the HTML shell so `<html lang>` can be set from the locale
 * SEGMENT rather than a dynamic request API (WCAG 3.1.1 requires the
 * lang attribute; `getLocale()` would read request headers and force
 * static public pages into dynamic rendering). The bare `/` redirect
 * has its own minimal root layout in `(root)/`.
 *
 * Minimal per §28.1: HTML scaffold, theme + locale providers only — no
 * secure-menu fetches, no user-specific data. Validates the locale
 * segment and provides translated messages to all descendants (public,
 * auth, and secure routes). Unknown locales 404 instead of falling back
 * so URLs remain unambiguous.
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

  // Per-request CSP nonce minted in `proxy.ts`. `next-themes` injects an inline
  // anti-flash <script>; under the enforcing (production) policy that script
  // must carry the nonce or it is blocked. Reading the request header opts the
  // shell into dynamic rendering — an accepted cost of a per-request nonce, and
  // moot for the secure routes (already dynamic). Undefined in dev, where the
  // policy keeps `'unsafe-inline'` for HMR.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <ThemeProvider nonce={nonce}>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <div data-locale={locale}>{children}</div>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

/**
 * Pre-renders the locale segment for every supported locale at build time.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}
