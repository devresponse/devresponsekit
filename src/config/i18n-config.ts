/**
 * Supported locales for the application.
 *
 * Adding a locale requires:
 *  1. Updating this list.
 *  2. Adding `src/messages/<locale>.json`.
 *  3. Updating the `NEXT_PUBLIC_SUPPORTED_LOCALES` env value used by the
 *     client locale switcher.
 */
export const locales = ["en", "fr", "es", "uk", "pt", "zh", "hi", "ja"] as const;
export const defaultLocale = "en" as const;

export type SupportedLocale = (typeof locales)[number];

/** Type guard to validate untrusted locale input from URLs and APIs. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}
