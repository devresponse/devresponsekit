import { isSupportedLocale } from "./i18n-config";

/**
 * Route-region classification.
 *
 * Classifies URL pathnames into `public`, `auth`, or `secure` regions so
 * `proxy.ts` and layout guards can apply the correct access rules without
 * hardcoding path prefixes in multiple places.
 *
 * Definitions (per §28):
 *   - public  — No authentication required. Normal document scroll.
 *               Comfortable density.
 *   - auth    — No secure shell. May be visited unauthenticated (sign-in,
 *               sign-up) or post-auth (pending-approval, blocked).
 *               Comfortable density.
 *   - secure  — Requires an active session and approved membership.
 *               Compact density. Viewport-bounded shell.
 */
export type RouteRegion = "public" | "auth" | "secure";

/**
 * Path prefixes (after the locale segment) that belong to the `auth` region.
 * Unauthenticated users may visit these without being redirected.
 */
const AUTH_PREFIXES = [
  "sign-in",
  "sign-up",
  "forgot-password",
  "pending-approval",
  "blocked",
] as const;

/**
 * Path prefixes (after the locale segment) that belong to the `public` region.
 * Listed here for documentation — the public region is the default fallback.
 *
 * ```text
 * ""          — locale root (/en)
 * "about"     — /en/about
 * "docs"      — /en/docs
 * "logged-out"— /en/logged-out
 * ```
 */
// (Public paths are the fallback — everything that is not secure or auth.)
/**
 * Returns the route region for a given pathname.
 *
 * The root `/` and any unknown locale segment are treated as `public` so
 * unauthenticated visitors always land on a public page rather than a
 * redirect loop.
 */
export function getRouteRegion(pathname: string): RouteRegion {
  const parts = pathname.split("/");
  // parts[0] is always "" for absolute paths starting with "/"
  const maybeLocale = parts[1] ?? "";
  const first = parts[2] ?? "";

  // Paths without a known locale (including bare "/") are public.
  if (!isSupportedLocale(maybeLocale)) {
    return "public";
  }

  // Secure: /[locale]/app/*
  if (first === "app") {
    return "secure";
  }

  // Auth region paths
  if ((AUTH_PREFIXES as readonly string[]).includes(first)) {
    return "auth";
  }

  // Public region paths (includes the locale root where first === "")
  return "public";
}

/**
 * Returns `true` when the pathname requires an active session.
 *
 * Thin wrapper used by `proxy.ts` to keep the route-guard logic declarative.
 */
export function isSecurePath(pathname: string): boolean {
  return getRouteRegion(pathname) === "secure";
}

/**
 * Returns `true` when the pathname is safe to serve without authentication.
 * Both `public` and `auth` regions are considered non-secure for this check.
 */
export function isPublicPath(pathname: string): boolean {
  return !isSecurePath(pathname);
}
