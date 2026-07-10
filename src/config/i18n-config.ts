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

/**
 * Human-readable, endonym labels per locale. Single source of truth so every
 * locale picker (the switcher, the admin new-user form, …) stays in lock-step
 * with {@link locales} — a new locale added above is a type error here until it
 * gets a label. (audit #24)
 */
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  uk: "Українська",
  pt: "Português",
  zh: "简体中文",
  hi: "हिन्दी",
  ja: "日本語",
};

/** Type guard to validate untrusted locale input from URLs and APIs. */
export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}
