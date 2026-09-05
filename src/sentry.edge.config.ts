import * as Sentry from "@sentry/nextjs";
import {
  SENTRY_DATA_COLLECTION,
  parseSampleRate,
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  scrubTransaction,
} from "@/lib/observability/sentry-shared";

/**
 * Sentry initialization for the Edge runtime (middleware/`proxy.ts` and
 * any edge route handlers). Imported lazily from `instrumentation.ts`
 * `register()` only when `NEXT_RUNTIME` is `edge`.
 *
 * Opt-in: no DSN → disabled no-op. Replay is browser-only, so the edge
 * config carries tracing + scrubbing only.
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
  tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
  // Never record cookies / query strings / bodies / IPs at write time;
  // the scrubbers below are the backstop for errors, transactions, AND
  // spans (review #22).
  dataCollection: SENTRY_DATA_COLLECTION,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubTransaction,
  beforeSendSpan: scrubSpan,
  beforeBreadcrumb: scrubBreadcrumb,
});
