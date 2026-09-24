import * as Sentry from "@sentry/nextjs";
import { clientIpSource } from "@/lib/client-ip-source";
import { createSentryScrubbers, parseSampleRate } from "@/lib/observability/sentry-shared";

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

// F-23 (from F-17): the header CLIENT_IP_SOURCE names carries the client IP
// too, and it can be one the shared deny rules miss (`x-azure-clientip`).
const ipSource = clientIpSource();
const scrubbers = createSentryScrubbers(ipSource?.kind === "header" ? [ipSource.header] : []);

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
  // Never record cookies / query strings / bodies / IPs at write time;
  // the scrubbers below are the backstop for errors, transactions, AND
  // spans (review #22).
  dataCollection: scrubbers.dataCollection,
  beforeSend: scrubbers.beforeSend,
  beforeSendTransaction: scrubbers.beforeSendTransaction,
  beforeSendSpan: scrubbers.beforeSendSpan,
  beforeBreadcrumb: scrubbers.beforeBreadcrumb,
});
