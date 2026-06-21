import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { isLocalizedSecurePath } from "@/config/route-regions";

const intlMiddleware = createIntlMiddleware(routing);

function getLocaleFromPath(pathname: string): string {
  const locale = pathname.split("/")[1] ?? "";
  return isSupportedLocale(locale) ? locale : defaultLocale;
}

/**
 * Builds the per-request Content-Security-Policy (A7 cutover, review #34).
 *
 * Enforcing mode: `script-src` drops `'unsafe-inline'` / `'unsafe-eval'` in
 * favour of a per-request `'nonce-…'` plus `'strict-dynamic'`. Next.js reads
 * the nonce off the request's `Content-Security-Policy` header and stamps it
 * onto every framework `<script>` it injects (hydration/RSC payloads), and
 * `'strict-dynamic'` lets those trusted scripts pull in the chunked bundles
 * without an allowlist. This is the layer that actually stops reflected-XSS
 * script execution — the prior policy allowed any inline script.
 *
 * Deliberate exception — `style-src` keeps `'unsafe-inline'`. React renders
 * `style={{…}}` props as inline `style="…"` ATTRIBUTES, which a nonce cannot
 * cover (nonces apply to `<script>`/`<style>` elements, not attributes), and
 * libraries inject `<style>` blobs (recharts' `chart.tsx`, the theme provider). Style
 * injection is a far weaker vector than script injection, so allowing inline
 * styles is the standard pragmatic trade to keep the UI intact.
 *
 * Development keeps the permissive `script-src` because Next's HMR / React
 * Fast Refresh runtime relies on `eval` and unnonced inline bootstrap; the
 * strict nonce policy only engages in production builds. `report-uri` /
 * `report-to` are retained through the switch so any regression still lands in
 * the hardened sink at `/api/security/csp-report`.
 */
function buildContentSecurityPolicy(nonce: string): string {
  const scriptSrc =
    process.env.NODE_ENV === "production"
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    scriptSrc,
    // Sentry ingest — only contacted when observability is enabled.
    "connect-src 'self' https://*.ingest.sentry.io https://*.sentry.io",
    "worker-src 'self' blob:",
    "report-uri /api/security/csp-report",
    "report-to csp-endpoint",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** A fresh base64 nonce per request (Edge runtime: `crypto`/`btoa` are globals). */
function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * proxy
 *
 * Combines three concerns:
 *   1. A per-request CSP nonce: an enforcing `Content-Security-Policy` is set
 *      on every response, and the nonce is threaded into the request headers
 *      (`x-nonce` + the CSP itself) so Next.js — and the root layout, which
 *      hands it to the server theme script — can stamp it onto inline scripts.
 *   2. next-intl locale routing (rewrites `/` to `/<defaultLocale>` and
 *      validates the locale segment).
 *   3. Early redirect for localized secure browser paths
 *      (`isLocalizedSecurePath`, classified by `route-regions.ts`) when
 *      no Better Auth session cookie is present, so unauthenticated
 *      users never see the secure layout shell flash.
 *
 * This is NOT the authorization boundary — it intentionally avoids any
 * database calls. The real check happens in `requireSecureSession`.
 *
 * Note: the file is named `proxy.ts` per Next.js 16. Only `proxy` is
 * exported — defining a `middleware` alias in the same file is
 * forbidden by Next.js 16 and would fail the build.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce);

  // API routes are excluded by the matcher, but defend in depth.
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  if (isLocalizedSecurePath(pathname)) {
    const sessionCookie = getSessionCookie(request);
    if (!sessionCookie) {
      const locale = getLocaleFromPath(pathname);
      const url = new URL(`/${locale}/sign-in`, request.url);
      url.searchParams.set("returnTo", `${pathname}${search}`);
      const response = NextResponse.redirect(url);
      response.headers.set("Content-Security-Policy", csp);
      return response;
    }
  }

  // Forward the nonce + CSP into the rendered request so Next.js applies the
  // nonce to its injected scripts (next-intl copies these request headers onto
  // the rewrite/next it returns — see its middleware), then enforce the policy
  // on the outgoing response.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = intlMiddleware(new NextRequest(request, { headers: requestHeaders }));
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
