import * as Sentry from "@sentry/nextjs";
import {
  SENTRY_DATA_COLLECTION,
  installReplayRecordingScrubber,
  parseSampleRate,
  scrubBreadcrumb,
  scrubEvent,
  scrubReplayEvent,
  scrubReplayRecordingEvent,
  scrubSpan,
  scrubTransaction,
} from "@/lib/observability/sentry-shared";

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
 *     never streams a clean session. Its URLs are scrubbed on all three
 *     channels a replay uses (F-23, see sentry-shared.ts).
 *
 * Opt-in: with no `NEXT_PUBLIC_SENTRY_DSN`, the SDK is a disabled no-op.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

const replay = Sentry.replayIntegration({
  maskAllText: true,
  maskAllInputs: true,
  blockAllMedia: true,
  // F-23: rrweb records a hidden input's value verbatim (`maskAllInputs`
  // covers the typed fields only), and /sso/confirm carries the handoff token
  // in one. A hidden input is never on screen, so masking it costs a replay
  // nothing.
  mask: ['input[type="hidden"]'],
  // F-23: the frames the SDK adds to the recording (navigation and request
  // spans, breadcrumbs) name full URLs, query included.
  beforeAddRecordingEvent: scrubReplayRecordingEvent,
});

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
    // F-23: rrweb's own events (the page URL each snapshot opens with, every
    // link's `href`) reach no SDK hook, so the scrubber rides in as an rrweb
    // plugin. An SDK that no longer takes one gets no replay at all rather
    // than an unscrubbed one.
    ...(installReplayRecordingScrubber(replay) ? [replay] : []),
  ],
  // Never record cookies / query strings / bodies / IPs at write time;
  // the scrubbers below are the backstop for errors, transactions, AND
  // spans (review #22).
  dataCollection: SENTRY_DATA_COLLECTION,
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubTransaction,
  beforeSendSpan: scrubSpan,
  beforeBreadcrumb: scrubBreadcrumb,
});

// F-23: the `replay_event` goes out through event processors only, never
// `beforeSend`, so its `urls`, `request.url` and `Referer` are scrubbed here.
Sentry.addEventProcessor(scrubReplayEvent);

// Instruments App Router client-side navigations (Next.js calls this).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
