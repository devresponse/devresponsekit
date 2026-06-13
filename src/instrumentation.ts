import * as Sentry from "@sentry/nextjs";

/**
 * Next.js server instrumentation entry point.
 *
 * `register()` loads the runtime-appropriate Sentry config (Node vs.
 * Edge). Both configs are opt-in no-ops without a DSN, so this is safe to
 * always run.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * App Router server-error hook (RSC, route handlers, server actions).
 *
 * We stamp the request's `x-request-id` onto the captured event as a tag
 * so a single id ties together: the user-facing "Support ID" rendered by
 * the error boundaries, the Sentry issue, and the
 * `app_audit_events.request_id` row written by `auditEvent`. That is the
 * whole point of wiring Sentry to the existing correlation id rather than
 * bolting on a parallel one.
 */
export const onRequestError: typeof Sentry.captureRequestError = (error, request, context) => {
  const raw = request.headers?.["x-request-id"];
  const requestId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (requestId) {
    Sentry.getCurrentScope().setTag("request_id", requestId);
  }
  return Sentry.captureRequestError(error, request, context);
};
