import { APP_ID_RE } from "@/lib/admin/enterprise-apps";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";

/**
 * Builders for the signed-out SSO launch continuation.
 *
 * The problem they solve: `/api/sso/launch` is the only endpoint that mints a
 * handoff, and a satellite's application switcher links straight at it. When
 * the browser holds no session that route redirects to sign-in, and before this
 * module existed it carried no return target — so a user who signed in landed
 * on the dashboard instead of the application they clicked.
 *
 * The return target cannot simply be the launch URL itself: `getSafeReturnTo`
 * deliberately refuses any `returnTo` under `/api/`, because a post-sign-in
 * redirect into an API route is a phishing and loop surface (that rule is
 * pinned by `tests/security/safe-return-to.test.ts`, which names
 * `/api/sso/launch?applicationId=evil` as a vector that MUST collapse to the
 * dashboard). Widening it for one path would turn a categorical rule into an
 * exception list, so instead the route returns the user to a localized page —
 * `/{locale}/sso/launch` — which the sanitizer already accepts untouched, and
 * that page forwards to the API route. The sanitizer is not modified.
 *
 * Both builders RECONSTRUCT their output: a hard-coded literal path plus
 * `URLSearchParams`, never caller input interpolated into a path. That removes
 * an implicit dependency on {@link APP_ID_RE} happening to exclude `?`, `#` and
 * `&` — a regex owned by the admin surface, which nothing pins on their behalf.
 * Invalid input yields `null` rather than a best-effort string, so every caller
 * has to decide what to do instead of silently emitting a broken link.
 *
 * This module is pure and free of side effects (like `@/lib/admin/enterprise-apps`
 * it deliberately omits `server-only`) so both a route handler and a page can
 * share one definition, and so the logic is unit-testable: `vitest.config.ts`
 * excludes `src/app/**\/page.tsx` from coverage, meaning anything left in the
 * page itself would have no unit-level proof at all.
 */

/**
 * Longest `applicationId` the enterprise-apps contract accepts
 * (docs/admin-manager.md §8.7).
 */
const MAX_APP_ID_LENGTH = 128;

/**
 * Narrows a candidate application id and locale, or returns `null`.
 *
 * `searchParams` values arrive as `string | string[] | undefined` in a Next.js
 * page, so an array (`?applicationId=a&applicationId=b`) is rejected rather
 * than coerced — taking `[0]` would let a caller smuggle a second value past a
 * reader's expectations.
 */
export function parseSsoLaunchParams(
  applicationId: string | string[] | null | undefined,
  locale: string | string[] | null | undefined,
): { applicationId: string; locale: string } | null {
  if (typeof applicationId !== "string") return null;
  if (applicationId.length === 0 || applicationId.length > MAX_APP_ID_LENGTH) return null;
  if (!APP_ID_RE.test(applicationId)) return null;

  const localeCandidate = typeof locale === "string" ? locale : undefined;
  return {
    applicationId,
    locale: localeCandidate && isSupportedLocale(localeCandidate) ? localeCandidate : defaultLocale,
  };
}

/**
 * The `returnTo` the launch route hands to sign-in: a localized PAGE path that
 * `getSafeReturnTo` returns unchanged. Never starts with `/api/`.
 */
export function buildSsoLaunchReturnPath(
  applicationId: string | string[] | null | undefined,
  locale: string | string[] | null | undefined,
): string | null {
  const parsed = parseSsoLaunchParams(applicationId, locale);
  if (!parsed) return null;
  const query = new URLSearchParams({
    applicationId: parsed.applicationId,
    locale: parsed.locale,
  });
  return `/${parsed.locale}/sso/launch?${query.toString()}`;
}

/**
 * The API path the interstitial page forwards to — the real launch endpoint,
 * which performs every authorization check (session, impersonation, signing
 * key, application status, organization scope). The page decides nothing.
 */
export function buildSsoLaunchApiPath(
  applicationId: string | string[] | null | undefined,
  locale: string | string[] | null | undefined,
): string | null {
  const parsed = parseSsoLaunchParams(applicationId, locale);
  if (!parsed) return null;
  const query = new URLSearchParams({
    applicationId: parsed.applicationId,
    locale: parsed.locale,
  });
  return `/api/sso/launch?${query.toString()}`;
}
