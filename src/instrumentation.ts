import * as Sentry from "@sentry/nextjs";
import {
  REQUEST_ID_HEADER,
  headerValueFromRecord,
  normalizeInboundRequestId,
} from "@/lib/request-id";

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
    // OPS-4 / review #24: arm the SIGTERM/SIGINT watchdog. Next's own cleanup
    // drains HTTP and exits 143/130; the watchdog only ends the pg pool and
    // exits if that drain overruns SHUTDOWN_TIMEOUT_MS. Skipped during the
    // production *build* phase (no live pool) and confined to the Node
    // runtime — the shutdown module imports `pg`, which the edge runtime
    // cannot load. A no-op on Vercel (see the module).
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { registerGracefulShutdown } = await import("@/lib/shutdown.server");
      registerGracefulShutdown();
      // D5 / review #23: log + capture stray unhandledRejection /
      // uncaughtException to Sentry (otherwise they are invisible). They do
      // not exit — Next treats both as non-fatal — unless
      // PROCESS_FATAL_ON_UNCAUGHT=1 opts uncaught exceptions into exit(1).
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
 *
 * Review #99: this hook used to tag Sentry and stdout with the RAW inbound
 * header — no UUID check, no provenance check — while every other producer
 * ran it through the admin helper's validation. So the ONE id that reached
 * the error sinks was the one a client could choose: a forged value split the
 * correlation it exists to provide, and a malformed one (control characters,
 * markup, kilobytes of junk) went straight into a log line and a Sentry tag.
 * It now goes through the shared {@link normalizeInboundRequestId}, so a
 * malformed id yields NO tag rather than a poisoned one, and this hook and the
 * admin helper answer "which inbound ids do we honour" identically instead of
 * disagreeing. A well-formed FORGED id is still honoured here exactly as it is
 * everywhere else — that gap is #224's and is documented on the normaliser.
 *
 * The tag is set inside `Sentry.withScope` so it applies to THIS capture only
 * — `getCurrentScope()` mutated the scope the whole request shares, which on
 * a runtime that reuses an isolation scope let one request's id linger on a
 * later event.
 */
export const onRequestError = async (
  ...args: Parameters<typeof Sentry.captureRequestError>
): Promise<void> => {
  const [error, request] = args;
  const requestId = normalizeInboundRequestId(
    headerValueFromRecord(request.headers, REQUEST_ID_HEADER),
    headerValueFromRecord(request.headers, "x-forwarded-for"),
  );
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("request_id", requestId);
    Sentry.captureRequestError(...args);
  });

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
