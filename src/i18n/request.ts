import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { getViewerFormatPreferences } from "@/lib/format/viewer-format.server";
import { routing } from "./routing";

/**
 * next-intl request config.
 *
 * Loads the per-locale message file at request time. Falls back to the
 * default locale when an unsupported value is passed via the URL.
 *
 * `timeZone` is the signed-in viewer's saved zone, else the deployment's
 * (F-37). next-intl hands it to `NextIntlClientProvider` too, so the server
 * render and the browser format every instant in the SAME zone. Before, no
 * zone was configured: server components formatted in the server's zone and
 * client components in the browser's, and the saved preference was read by
 * nothing. The lookup costs nothing for a signed-out request and never
 * throws (`getViewerFormatPreferences`). The date and number format ride the
 * root layout's `FormatPreferencesProvider` instead of next-intl `formats`,
 * because Intl options cannot express their field order
 * (`src/lib/format/app-format.ts`).
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const messages = (await import(`../messages/${locale}.json`)).default as Record<string, unknown>;
  const { timeZone } = await getViewerFormatPreferences();

  return {
    locale,
    messages,
    timeZone,
  };
});
