/**
 * Next.js configuration.
 *
 * Strict App Router project. Server Components are default; Client
 * Components opt in via the "use client" directive.
 */
import createNextIntlPlugin from "next-intl/plugin";
// Sentry 11 moved the build-time wrapper to its own entry point (R11).
import { withSentryConfig } from "@sentry/nextjs/config";

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

/**
 * I-07 (review #116): every `/api` response defaults to `Cache-Control:
 * private, no-store`. Cookie-authenticated JSON (the administrator grids, a
 * user's sessions with their IPs and user agents, the navigation menus, Better
 * Auth's own endpoints) otherwise went out with no caching policy at all, so
 * whether a browser or an intermediary kept a copy was left to heuristics.
 *
 * The routes that publish their OWN cacheable policy are left out of the
 * pattern rather than trusted to override it. A header from this list is
 * written to the response before the route runs, and on a self-hosted
 * `next start` Next then skips any route header of the same name
 * (`next/dist/server/send-response.js`), so the config value would silently
 * replace the route's `max-age`. Other platforms may merge the two
 * differently. Leaving those routes out makes the route the only writer,
 * wherever it runs. Each entry is a path relative to `/api/`: the public key sets and
 * OpenAPI document (`public, max-age=300`) and the docs/help image streams
 * (`private, max-age=300`). `tests/unit/api-cache-control.test.ts` walks every
 * route file and fails when one that sets a `max-age` is missing here, or when
 * any other route would go without `no-store`.
 */
const API_SELF_CACHED = [
  "sso/jwks\\.json$",
  "v1/jwks\\.json$",
  "v1/openapi\\.json$",
  "docs/asset/",
  "help/asset/",
];
const apiNoStore = {
  source: `/api/:path((?!${API_SELF_CACHED.join("|")}).*)`,
  headers: [{ key: "Cache-Control", value: "private, no-store" }],
};

/**
 * F-88: what the docs and help viewers read from disk at request time, per
 * route, so it travels with those server functions (Vercel) and into
 * `.next/standalone` (Docker).
 *
 * The content roots used to reach the functions only by accident: the dynamic
 * `path.resolve(process.cwd(), space)` in safe-path.server.ts made the tracer
 * ship the WHOLE working tree in each of the six functions, including a
 * developer checkout's gitignored coverage report, Playwright traces and
 * `.vercel` env file when `drk-deploy release` builds locally. The roots are
 * literal now, and the content is declared here so that narrowing the trace
 * can never drop it. `scripts/check-docs-trace.mjs` (CI, after `next build`)
 * proves both halves on the real build output.
 *
 * Literal roots are not enough on their own: Turbopack still approximates the
 * docs code's dynamic `fs` calls (readdir/readFile/realpath on computed
 * paths), and on this Next release that pulls the whole `src/lib/docs` source
 * tree into all six functions. `turbopackIgnore` does not help there: the
 * magic comment applies only to `import()`, `require()`, `require.resolve()`
 * and `new Worker()` (node_modules/next/dist/docs, "Magic Comments"), never to
 * an `fs` call. So the excludes below also drop that source tree (the
 * compiled code ships as `.next` chunks, so no function reads it at runtime),
 * which is the documented remedy for over-included files.
 *
 * Keep that exclude EXACT. An exclude pattern is not anchored to the project
 * root: a bare `src/**` also matched every package's own `src/` directory
 * under node_modules, and dropped `regex/src/internals.js`, which shiki needs
 * to highlight a docs page. The docs pages then answered 500 in the Docker
 * image while every unit test stayed green (caught by docker-scan.yml's smoke
 * run on #488).
 *
 * The route keys match every form a bundler may name a route by
 * (`/[locale]/app/docs/[...slug]`, `…/(secure)/app/docs/[...slug]/page`)
 * without spelling `[locale]`, which a route glob reads as a character class.
 * The image extensions are the asset route's allow-list (IMAGE_CONTENT_TYPES
 * in src/lib/docs/safe-path.server.ts; tests/unit/docs-trace.test.ts
 * keeps them equal).
 */
export const DOC_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"];
const docText = (space) => [`${space}/**/*.md`, `${space}/**/*.mdx`];
const docImages = (space) => DOC_IMAGE_EXTENSIONS.map((ext) => `${space}/**/*.${ext}`);
const docsTracingIncludes = {
  "**/app/docs": docText("docs"),
  "**/app/docs/**": docText("docs"),
  "**/app/help": docText("help"),
  "**/app/help/**": docText("help"),
  "**/api/docs/asset/**": docImages("docs"),
  "**/api/help/asset/**": docImages("help"),
};
/** Local, gitignored artifacts that must never ride along, whatever the trace finds. */
const LOCAL_ARTIFACTS = [
  ".vercel/**",
  "coverage/**",
  "test-results/**",
  "playwright-report/**",
  ".stryker-tmp/**",
];
/**
 * The source tree Turbopack's approximation of the docs code's dynamic `fs`
 * calls traces into these functions (see above), and that no function reads
 * at runtime. Exact on purpose: a broader pattern also matches directories
 * inside node_modules packages.
 */
const OVER_TRACED_SOURCE = ["src/lib/docs/**"];
const docsTracingExcludes = Object.fromEntries(
  Object.keys(docsTracingIncludes).map((route) => [
    route,
    [...LOCAL_ARTIFACTS, ...OVER_TRACED_SOURCE],
  ]),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework on every response (`X-Powered-By:
  // Next.js`); the static header set above is deliberately minimal and the
  // server must not add a fingerprint the config cannot strip (review #115).
  poweredByHeader: false,
  // Emit a self-contained server bundle (`.next/standalone`) with only the
  // traced runtime dependencies, so the production container is a thin
  // `node server.js` image instead of the full repo + node_modules. This is
  // an ADDITIONAL build artifact: `next start` and serverless targets are
  // unaffected. See the Dockerfile and docs/docker.md.
  output: "standalone",
  // F-88: the docs/help content, declared per route (see above).
  outputFileTracingIncludes: docsTracingIncludes,
  outputFileTracingExcludes: docsTracingExcludes,
  // Local subdomain-SSO testing: the dev server may be reached via a
  // non-localhost hostname (devresponse.local via the hosts file, or
  // *.localtest.me via public DNS), which Next's dev cross-origin protection
  // would otherwise block. Dev-only setting; ignored by production builds.
  // See docs/integration-satellite-apps.md §6.6.
  allowedDevOrigins: ["devresponse.local", "*.devresponse.local", "*.localtest.me"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, apiNoStore];
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
