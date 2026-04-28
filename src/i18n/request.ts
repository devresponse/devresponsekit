import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "./routing";

/**
 * next-intl request config.
 *
 * Loads the per-locale message file at request time. Falls back to the
 * default locale when an unsupported value is passed via the URL.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  const messages = (await import(`../messages/${locale}.json`)).default as Record<string, unknown>;

  return {
    locale,
    messages,
  };
});
