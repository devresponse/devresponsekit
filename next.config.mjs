/**
 * Next.js configuration.
 *
 * Strict App Router project. Server Components are default; Client
 * Components opt in via the "use client" directive.
 */
import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The enforcing **Content-Security-Policy** is set PER REQUEST in
 * `src/proxy.ts`, not here: it carries a per-request `'nonce-…'` in
 * `script-src` (with `'strict-dynamic'`, dropping `'unsafe-inline'` /
 * `'unsafe-eval'`), which a static `next.config` header cannot express.
 * Violations still report to the hardened sink at
 * `POST /api/security/csp-report` (A7) via the `report-uri` / `report-to` the
 * proxy keeps. The static headers below are the request-invariant ones; they
 * apply to every response (including `/api` and assets the proxy matcher
 * skips). Clickjacking is blocked by `X-Frame-Options: DENY` here AND
 * `frame-ancestors 'none'` in the proxy CSP.
 */

/**
 * Baseline security headers applied to every response (enterprise
 * hardening). HSTS is inert over plain HTTP (browsers ignore it) so it is
 * safe to send everywhere.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Declares the `csp-endpoint` reporting group referenced by the proxy CSP's
  // `report-to`. Static so it rides on every response alongside the CSP.
  { key: "Reporting-Endpoints", value: 'csp-endpoint="/api/security/csp-report"' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (`.next/standalone`) with only the
  // traced runtime dependencies, so the production container is a thin
  // `node server.js` image instead of the full repo + node_modules. This is
  // an ADDITIONAL build artifact: `next start` and serverless targets are
  // unaffected. See the Dockerfile and docs/docker.md.
  output: "standalone",
  // Local subdomain-SSO testing: the dev server may be reached via a
  // non-localhost hostname (devresponse.local via the hosts file, or
  // *.localtest.me via public DNS), which Next's dev cross-origin protection
  // would otherwise block. Dev-only setting; ignored by production builds.
  // See docs/integration-satellite-apps.md §6.6.
  allowedDevOrigins: ["devresponse.local", "*.devresponse.local", "*.localtest.me"],
  // The proxy.ts (formerly middleware.ts) file lives under src/.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

const config = withNextIntl(nextConfig);

/**
 * Sentry is an OPT-IN deployment feature. The build-time plugin (source-map
 * upload, release tagging, tree-shaking of debug code) only engages when a
 * client DSN is configured, so a default build — and CI without Sentry
 * secrets — is byte-for-byte unchanged. Source-map UPLOAD additionally
 * requires `SENTRY_AUTH_TOKEN` (+ `SENTRY_ORG`/`SENTRY_PROJECT`); without it
 * the plugin still runs but skips upload. See docs/observability.md.
 */
const sentryEnabled = Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);

export default sentryEnabled
  ? withSentryConfig(config, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      telemetry: false,
      widenClientFileUpload: true,
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    })
  : config;
