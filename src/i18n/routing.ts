import { defineRouting } from "next-intl/routing";
import { defaultLocale, locales } from "@/config/i18n-config";

/**
 * next-intl routing configuration.
 *
 * Locale always present in the URL (`/en`, `/fr`, ...). The locale prefix is
 * required so that enterprise URLs are unambiguous when shared.
 */
export const routing = defineRouting({
  locales: [...locales],
  defaultLocale,
  localePrefix: "always",
});
