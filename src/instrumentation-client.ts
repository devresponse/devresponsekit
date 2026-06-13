import * as Sentry from "@sentry/nextjs";
import { parseSampleRate, scrubEvent } from "@/lib/observability/sentry-shared";

/**
 * Browser-side Sentry initialization (Next.js loads this file in the
 * client bundle automatically). Delivers the four client capabilities:
 *
 *   - **Errors** — unhandled exceptions + promise rejections + React
 *     render crashes (via the error boundaries) are captured.
 *   - **Tracing + Web Vitals** — `browserTracingIntegration` records
 *     route/navigation spans and Core Web Vitals (LCP/INP/CLS).
 *   - **Masked Session Replay** — `replayIntegration` with *all text and
 *     inputs masked and media blocked*; by default only sessions that hit
 *     an error are recorded (`replaysOnErrorSampleRate`), so an auth app
 *     never streams a clean session.
 *
 * Opt-in: with no `NEXT_PUBLIC_SENTRY_DSN`, the SDK is a disabled no-op.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  tracesSampleRate: parseSampleRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1),
  // Session replays: default to 0% of clean sessions, 100% of sessions
  // that error. Both are env-overridable per deployment.
  replaysSessionSampleRate: parseSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
    0,
  ),
  replaysOnErrorSampleRate: parseSampleRate(
    process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ERROR_SAMPLE_RATE,
    1,
  ),
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    }),
  ],
  sendDefaultPii: false,
  beforeSend: scrubEvent,
});

// Instruments App Router client-side navigations (Next.js calls this).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
