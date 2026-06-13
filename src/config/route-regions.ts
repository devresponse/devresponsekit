import { isSupportedLocale } from "./i18n-config";

/**
 * Route region classifier.
 *
 * Centralizes the mapping from a localized browser pathname to one of
 * three regions used throughout the app:
 *
 *   - `secure`  — `/[locale]/app/*`. Behind `proxy.ts` cookie redirect
 *                 and `(secure)/layout.tsx` server-side authorization.
 *   - `auth`    — sign-in / sign-up / forgot-password / pending-approval
 *                 / blocked. Auth shell only; never the secure shell.
 *   - `public`  — everything else inside a localized tree (locale root,
 *                 about, docs, logged-out, ...) plus any non-localized
 *                 path that should not be treated as secure.
 *
 * This module is the single source of truth so `proxy.ts`, route
 * guards, navigation helpers, and tests all classify identically.
 */

export type RouteRegion = "secure" | "auth" | "public";

/**
 * Path segments (the second segment after `/[locale]`) that belong to
 * the auth route group. Kept in sync with `src/app/[locale]/(auth)`.
 */
export const AUTH_PATH_SEGMENTS = [
  "sign-in",
  "sign-up",
  "forgot-password",
  "reset-password",
  "pending-approval",
  "blocked",
] as const;

const AUTH_SEGMENT_SET = new Set<string>(AUTH_PATH_SEGMENTS);

/**
 * Classify a pathname into a route region.
 *
 * The pathname is expected to be `URL.pathname` shape (leading `/`,
 * no query). Unknown locales fall through to `public` so the proxy
 * never accidentally treats them as secure.
 */
export function classifyRoute(pathname: string): RouteRegion {
  const parts = pathname.split("/");
  const locale = parts[1] ?? "";
  if (!isSupportedLocale(locale)) return "public";
  const first = parts[2] ?? "";
  if (first === "app") return "secure";
  if (AUTH_SEGMENT_SET.has(first)) return "auth";
  return "public";
}

/**
 * Convenience predicate kept for back-compat with existing callers and
 * tests that look for this name in `src/proxy.ts`.
 */
export function isLocalizedSecurePath(pathname: string): boolean {
  return classifyRoute(pathname) === "secure";
}

/** Convenience predicate for auth routes. */
export function isLocalizedAuthPath(pathname: string): boolean {
  return classifyRoute(pathname) === "auth";
}

/** Convenience predicate for public routes. */
export function isLocalizedPublicPath(pathname: string): boolean {
  return classifyRoute(pathname) === "public";
}
