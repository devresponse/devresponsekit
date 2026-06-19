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
 * Content-Security-Policy shipped in **Report-Only** mode to start. Next.js
 * injects inline/eval scripts for hydration, so an enforcing strict CSP
 * would break the app until we move to per-request nonces — report-only
 * lets us observe violations first, then tighten without an outage.
 * Violations are now collected at `POST /api/security/csp-report` (A7).
 * Clickjacking is blocked TODAY regardless, via the enforced
 * `X-Frame-Options: DENY` + `frame-ancestors 'none'` below.
 *
 * Enforcing cutover plan (post-1.0): (1) watch the sink until the only
 * reports are known-safe; (2) emit a per-request nonce from `src/proxy.ts`
 * and add it to `script-src` / `style-src`; (3) drop `unsafe-inline` /
 * `unsafe-eval`; (4) rename the header to `Content-Security-Policy` to
 * enforce. Keep `report-uri` / `report-to` through the switch so any
 * regression still surfaces.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // Sentry ingest — only contacted when observability is enabled.
  "connect-src 'self' https://*.ingest.sentry.io https://*.sentry.io",
  "worker-src 'self' blob:",
  // CSP violation sink (A7): collect Report-Only violations so we can see what
  // an enforcing policy would block before flipping the switch. `report-uri` is
  // honored by the most browsers; `report-to` is the modern Reporting API form
  // (its group is declared by the `Reporting-Endpoints` header below).
  "report-uri /api/security/csp-report",
  "report-to csp-endpoint",
  "upgrade-insecure-requests",
].join("; ");

/**
 * Baseline security headers applied to every response (enterprise
 * hardening). The non-CSP headers are enforced; HSTS is inert over plain
 * HTTP (browsers ignore it) so it is safe to send everywhere.
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
  // Declares the `csp-endpoint` reporting group referenced by `report-to`.
  { key: "Reporting-Endpoints", value: 'csp-endpoint="/api/security/csp-report"' },
  { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy },
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
