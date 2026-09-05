/**
 * Supported locales for the application.
 *
 * Adding a locale requires (review #110):
 *  1. Updating this list — `LOCALE_LABELS` below is a type error until the
 *     new locale gets a label.
 *  2. Adding `src/messages/<locale>.json` (the parity test pins its keys
 *     against `en.json`).
 *  3. Adding the locale's email-template migration under
 *     `src/db/migrations/locales/` (see `migration-plan.ts`).
 *  4. Optionally a localized hero screenshot — `HERO_SCREENSHOT_LOCALES` in
 *     the public landing page falls back to `en` otherwise.
 * Nothing in `src/` reads a `NEXT_PUBLIC_SUPPORTED_LOCALES` env value; the
 * locale switcher and language menu import `locales` from this module.
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
