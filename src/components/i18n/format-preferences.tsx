"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useLocale, useTimeZone } from "next-intl";
import type { SupportedLocale } from "@/config/i18n-config";
import type { DateFormatOption } from "@/lib/account/preferences";
import { createAppFormatter, type AppFormatter } from "@/lib/format/app-format";

interface FormatChoice {
  dateFormat: DateFormatOption;
  numberLocale: SupportedLocale | null;
}

/** No provider (a test, a page outside the locale layout) = the UI locale's own style. */
const FormatChoiceContext = createContext<FormatChoice>({
  dateFormat: "system",
  numberLocale: null,
});

/**
 * Carries the viewer's saved date and number format to client components
 * (F-37). The root locale layout mounts it inside `NextIntlClientProvider`
 * with the values `getViewerFormatPreferences` resolved for this request, so
 * a client component formats with exactly what the server used. The zone is
 * NOT carried here: it is next-intl's `timeZone`, read back with
 * `useTimeZone()`, so next-intl and the app formatter share one source for it.
 * Props are plain strings, safe across the server/client boundary.
 */
export function FormatPreferencesProvider({
  dateFormat,
  numberLocale,
  children,
}: FormatChoice & { children: ReactNode }) {
  const value = useMemo(() => ({ dateFormat, numberLocale }), [dateFormat, numberLocale]);
  return <FormatChoiceContext.Provider value={value}>{children}</FormatChoiceContext.Provider>;
}

/**
 * The client-side formatter (F-37): every date, timestamp and number a client
 * component displays goes through it. It runs the same pure code as the
 * server's `getAppFormatter` over the same inputs (UI locale, next-intl's
 * zone, the saved formats), so server-rendered markup and the hydrated
 * client agree, and it applies the viewer's time zone, date format and
 * number format. Stable across renders until one of those changes, so it is
 * safe in a `useMemo` dependency list.
 */
export function useAppFormatter(): AppFormatter {
  const locale = useLocale();
  // next-intl's server provider always fills the zone from the request
  // config. The UTC fallback only covers a provider mounted without one (a
  // test), and keeps that deterministic instead of using the host's zone.
  const timeZone = useTimeZone() ?? "UTC";
  const { dateFormat, numberLocale } = useContext(FormatChoiceContext);
  return useMemo(
    () => createAppFormatter(locale, { timeZone, dateFormat, numberLocale }),
    [locale, timeZone, dateFormat, numberLocale],
  );
}
