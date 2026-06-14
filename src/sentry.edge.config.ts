import * as Sentry from "@sentry/nextjs";
import { parseSampleRate, scrubBreadcrumb, scrubEvent } from "@/lib/observability/sentry-shared";

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
  sendDefaultPii: false,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
