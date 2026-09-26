import "@/app/globals.css";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";
import { getBrand } from "@/config/brand";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { ThemeScript } from "@/components/theme/theme-script";
import { ClientMessagesProvider } from "@/components/i18n/client-messages-provider";
import { FormatPreferencesProvider } from "@/components/i18n/format-preferences";
import { getViewerFormatPreferences } from "@/lib/format/viewer-format.server";
import type { ReactNode } from "react";

const brand = getBrand();

/**
 * Only supported locale segments are valid. Without this, dotted asset
 * requests such as `/favicon.png` can fall through to the `[locale]`
 * segment at runtime and force a static page into dynamic rendering.
 */
export const dynamicParams = false;

export const metadata: Metadata = {
  title: {
    default: brand.name,
    template: `%s · ${brand.shortName}`,
  },
  description: "Enterprise application shell.",
  icons: {
    icon: brand.favicon,
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
 * secure-menu fetches. Validates the locale segment. Unknown locales 404
 * instead of falling back so URLs remain unambiguous.
 *
 * Client messages (F-123): this provider carries only the `locale` scope's
 * namespaces, what the public pages and this segment's error and not-found
 * boundaries read. The `(auth)` and `(secure)` layouts mount their own
 * provider with their scope, so the Administrator console's strings are no
 * longer inlined into the landing and sign-in pages
 * (`src/i18n/client-messages.ts`).
 *
 * The one per-user input is the viewer's display format (F-37): the saved
 * time zone, date format and number format, which the locale providers carry
 * to every client component. `getViewerFormatPreferences` reads no session
 * and no DB for a signed-out request, is shared with next-intl's request
 * config (one lookup per request), and falls back to the defaults rather
 * than fail the page.
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

  const formatPreferences = await getViewerFormatPreferences();

  // Per-request CSP nonce minted in `proxy.ts`. The server `ThemeScript` renders
  // an inline anti-flash <script>; under the enforcing (production) policy that
  // script must carry the nonce or it is blocked. Reading the request header opts the
  // shell into dynamic rendering — an accepted cost of a per-request nonce, and
  // moot for the secure routes (already dynamic). Undefined in dev, where the
  // policy keeps `'unsafe-inline'` for HMR.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning>
      <body>
        <ThemeScript nonce={nonce} />
        <ThemeProvider>
          <ClientMessagesProvider locale={locale} scope="locale">
            <FormatPreferencesProvider
              dateFormat={formatPreferences.dateFormat}
              numberLocale={formatPreferences.numberLocale}
            >
              <div data-locale={locale}>{children}</div>
            </FormatPreferencesProvider>
          </ClientMessagesProvider>
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
