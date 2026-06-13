/**
 * Next.js configuration.
 *
 * Strict App Router project. Server Components are default; Client
 * Components opt in via the "use client" directive.
 */
import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The proxy.ts (formerly middleware.ts) file lives under src/.
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
