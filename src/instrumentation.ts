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
    // OPS-4: drain the pg pool on SIGTERM/SIGINT so a deploy/rollout closes
    // DB connections cleanly. Skipped during the production *build* phase
    // (no live pool to drain) and confined to the Node runtime — the
    // shutdown module imports `pg`, which the edge runtime cannot load.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { registerGracefulShutdown } = await import("@/lib/shutdown.server");
      registerGracefulShutdown();
      // D5: capture stray unhandledRejection/uncaughtException to Sentry + the
      // log before the process dies (otherwise a crash is silent).
      const { registerProcessErrorHandlers } = await import("@/lib/process-errors.server");
      registerProcessErrorHandlers();
    }
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
export const onRequestError = async (
  ...args: Parameters<typeof Sentry.captureRequestError>
): Promise<void> => {
  const [error, request] = args;
  const raw = request.headers?.["x-request-id"];
  const requestId = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (requestId) {
    Sentry.getCurrentScope().setTag("request_id", requestId);
  }
  Sentry.captureRequestError(...args);

  // OPS-OBS-1: also write the uncaught error to the always-on stdout stream so a
  // default (no-DSN) deploy isn't blind to its own 500s. The logger pulls in
  // pino (node-only) and is `server-only`, while this hook also fires in the
  // edge runtime — so guard on the runtime and import lazily, mirroring
  // `register()`. Logging must never mask the original error.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { logServerError } = await import("@/lib/observability/logger.server");
      logServerError("route.unhandled_error", { requestId, err: error });
    } catch {
      /* swallow — observability must not throw out of the error hook */
    }
  }
};
