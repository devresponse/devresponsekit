"use client";

import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * The href a locale switch hands to next-intl's `router.replace`: the current
 * URL without its locale prefix, with the query string and the fragment
 * carried over byte-for-byte. next-intl then prefixes the new locale, so only
 * that one segment changes.
 *
 * F-35: both switchers used to replace with the bare pathname, dropping every
 * query parameter on a language change. `/en/invite?token=…` became
 * `/uk/invite` (the "invitation not available" panel), `/en/sign-up?invite=…`
 * lost the invitation and its locked email, `/en/sign-in?returnTo=…` lost the
 * signed-out SSO launch continuation (#464), and an Administrator grid lost
 * its page and filters.
 *
 * `search` and `hash` are the page's own `location.search` / `location.hash`
 * and are concatenated verbatim, never parsed into a `query` object. next-intl
 * re-serializes an object `query` through `URLSearchParams`, which would
 * percent-encode the brackets of `filter[status]`, turn `%20` into `+`, and
 * escape the `/` and `?` of a raw `returnTo=/en/sso/launch?applicationId=a`.
 * The query stays opaque here: the destination page's own validation sees
 * exactly what it saw before the switch. For a `returnTo` that validation is
 * the auth pages' server-side `getSafeReturnToInLocale`. It sanitizes the value,
 * then re-points its locale segment at the page's own, so the language picked
 * here still holds after signing in. Because the prefix is the only change, the
 * target is the same page on the same origin, so this cannot widen where the
 * browser goes.
 */
export function localeSwitchHref(pathname: string, search: string, hash: string): string {
  // next-intl folds a bare root into the new prefix only when nothing or a
  // query follows it ("/" → "/fr", "/?q" → "/fr?q"). "/#main" would come out
  // as "/fr/#main", a trailing-slash URL Next answers with a redirect to
  // "/fr", so the root hands over the fragment alone ("#main" → "/fr#main").
  if (pathname === "/" && search === "" && hash !== "") return hash;
  return `${pathname}${search}${hash}`;
}

export interface UseSwitchLocaleOptions {
  /** When true, persists the choice via /api/preferences/locale. */
  persistAuthenticated?: boolean;
}

/**
 * The one locale-switch implementation behind every language picker
 * (`LocaleSwitcher`, `LanguageMenu`), so a fix to what a switch preserves
 * cannot land in one picker and miss the other (F-35).
 *
 * `switchLocale` ignores anything that is not a supported locale. For
 * authenticated users (`persistAuthenticated`) it also posts the choice to
 * `/api/preferences/locale`, fire-and-forget; the server validates the value
 * and audit-logs `i18n.locale.changed`.
 */
export function useSwitchLocale({ persistAuthenticated = false }: UseSwitchLocaleOptions = {}): {
  switchLocale: (next: string) => void;
  isPending: boolean;
} {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const switchLocale = (next: string) => {
    if (!isSupportedLocale(next)) return;
    // Read the query and fragment when the user acts, not at render time.
    // `useSearchParams` would put every page that mounts a switcher behind a
    // Suspense boundary (a client-rendering bailout), and a render-time value
    // goes stale when the page rewrites its own query (the Administrator grid
    // replaces its URL on every page or filter change).
    const { search, hash } = window.location;
    startTransition(() => {
      router.replace(localeSwitchHref(pathname, search, hash), { locale: next });
      if (persistAuthenticated) {
        // Fire-and-forget: server validates and audits.
        void fetch("/api/preferences/locale", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ locale: next }),
        });
      }
    });
  };

  return { switchLocale, isPending };
}
