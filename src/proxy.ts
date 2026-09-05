import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { isLocalizedSecurePath } from "@/config/route-regions";
import { applyClientIpHeader } from "@/lib/client-ip";
import { ORG_SIGNUP_HINT_COOKIE } from "@/lib/scoped-auth";

const intlMiddleware = createIntlMiddleware(routing);

function getLocaleFromPath(pathname: string): string {
  const locale = pathname.split("/")[1] ?? "";
  return isSupportedLocale(locale) ? locale : defaultLocale;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Carries the organization scope of a sign-in/up page across the social OAuth
 * round trip (which has no request body) via a short-lived cookie. Set on a
 * scoped page (`/sign-in/<org>` or `?org=<slug>`), cleared on a plain one, so
 * the hint always matches the page the visitor launches social sign-in from —
 * the sign-in provisioning hook reads it for a brand-new social user. Placement
 * only: provisioning still applies the target org's signup policy
 * (auth-signup-policy.md §7). Never throws — a proxy exception breaks the page.
 */
function applyOrgSignupHint(request: NextRequest, response: NextResponse): void {
  const segments = request.nextUrl.pathname.split("/").filter(Boolean);
  if (!isSupportedLocale(segments[0])) {
    return;
  }
  const page = segments[1];
  if (page !== "sign-in" && page !== "sign-up") {
    return;
  }

  // Path scope (`/sign-in/<org>`) or query scope (`?org=`); path wins.
  const hint =
    page === "sign-in" && segments[2]
      ? safeDecode(segments[2])
      : (request.nextUrl.searchParams.get("org") ?? "");

  if (hint) {
    response.cookies.set(ORG_SIGNUP_HINT_COOKIE, hint, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600, // 10 min — a generous OAuth round-trip window
    });
  } else if (request.cookies.has(ORG_SIGNUP_HINT_COOKIE)) {
    // Plain sign-in/up: drop any stale hint so the scope matches the page.
    response.cookies.delete(ORG_SIGNUP_HINT_COOKIE);
  }
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
 * cover (nonces apply to `<script>`/`<style>` elements, not attributes).
 * Concretely, recharts (via `metric-bar-chart.tsx`) sets inline style
 * attributes — it emits no `<style>` element — and the theme provider
 * (`theme-provider.tsx`) appends a transient `<style>` element while
 * switching themes (review #133). Style injection is a far weaker vector than
 * script injection, so allowing inline styles is the standard pragmatic trade
 * to keep the UI intact.
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
    // Only meaningful in production (real TLS). In dev, a non-localhost host
    // (e.g. devresponse.local subdomain SSO testing) is not a "trustworthy
    // origin", so the directive would silently upgrade every subresource and
    // form POST to https:// and fail against the plain-http dev server
    // (localhost itself is exempt, which is why this never bites there).
    ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** A fresh base64 nonce per request (Edge runtime: `crypto`/`btoa` are globals). */
function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

/**
 * proxy
 *
 * Combines four concerns:
 *   0. The trusted client IP (review #35): `x-drk-client-ip` is derived from
 *      `X-Forwarded-For` with the app's `TRUSTED_PROXY_COUNT` model and
 *      ALWAYS overwritten on the forwarded request — for page renders (whose
 *      server actions call `auth.api.*`) and for the Better Auth catch-all
 *      (`/api/auth/*`, matched explicitly below), which reads ONLY that
 *      header for its sign-in/reset limiter and `session.ipAddress`. A client
 *      cannot inject it, and multi-hop chains resolve to the same hop the
 *      app's own limiter trusts. This is defence in depth, not the only
 *      line: every server-side `auth.api.*` call site (SSO consume, the
 *      admin wrappers, session reads) and the catch-all route itself
 *      re-derive the header via `withTrustedClientIp`, so routes outside
 *      this matcher (`/api/sso/*`, `/api/administrator/*`) are covered too.
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

  // Forwarded request headers: the trusted client IP is stamped first so
  // every branch below hands Better Auth the same derivation.
  const requestHeaders = new Headers(request.headers);
  applyClientIpHeader(requestHeaders);

  // Only `/api/auth/*` is matched (Better Auth needs the client-IP header);
  // other API routes are excluded by the matcher, but defend in depth.
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
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
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = intlMiddleware(new NextRequest(request, { headers: requestHeaders }));
  response.headers.set("Content-Security-Policy", csp);
  applyOrgSignupHint(request, response);
  return response;
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)",
    // Better Auth's catch-all must pass through the proxy so the trusted
    // client-IP header is set before its rate limiter runs (review #35).
    "/api/auth/:path*",
  ],
};
