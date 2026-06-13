import * as Sentry from "@sentry/nextjs";
import { parseSampleRate, scrubEvent } from "@/lib/observability/sentry-shared";

/**
 * Sentry initialization for the Node.js server runtime. Imported lazily
 * from `instrumentation.ts` `register()` only when `NEXT_RUNTIME` is
 * `nodejs`.
 *
 * Opt-in: with no DSN configured, `enabled` is false and the SDK is a
 * no-op (nothing is captured or sent). Enable per deployment by setting
 * `SENTRY_DSN` (server) — see docs/observability.md.
 */
const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment:
    process.env.SENTRY_ENVIRONMENT ||
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ||
    process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  // Distributed tracing (also powers server-side performance spans).
  tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
  // Never attach cookies / IPs by default; the scrubber is the backstop.
  sendDefaultPii: false,
  beforeSend: scrubEvent,
});
