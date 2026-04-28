import { defaultLocale, isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";

/**
 * Picks a locale from an arbitrary input, falling back to the default
 * locale when invalid. Centralized so URL parsing, cookies, and provider
 * profiles all normalize the same way.
 */
export function pickLocale(value: unknown): SupportedLocale {
  return isSupportedLocale(value) ? value : defaultLocale;
}

/**
 * Builds a localized URL path for the given locale, ensuring there is no
 * accidental double slash and no missing leading slash.
 */
export function localizedPath(locale: SupportedLocale, path: string): string {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  if (trimmed === "/") return `/${locale}`;
  return `/${locale}${trimmed}`;
}
