import "server-only";
import * as Sentry from "@sentry/nextjs";
import { logServerError } from "@/lib/observability/logger.server";

/**
 * D5: last-resort process-level error handlers for the Node runtime.
 *
 * An `unhandledRejection` or `uncaughtException` would otherwise terminate the
 * server with NO structured log and NO Sentry event. These handlers record the
 * failure (stdout via `logServerError` + Sentry, tagged with the kind), flush
 * Sentry, then exit non-zero so the orchestrator restarts a worker that is now
 * in an undefined state.
 *
 * The clean SIGTERM/SIGINT path (pg-pool drain) is handled separately by
 * `registerGracefulShutdown`; an uncaught error is NOT a clean shutdown, so we
 * exit fast after capturing rather than attempting to drain a process whose
 * state we no longer trust. Registered from `instrumentation.ts` (Node branch).
 */
let registered = false;

export function registerProcessErrorHandlers(): void {
  if (registered) return;
  registered = true;

  const onFatal = (kind: "uncaughtException" | "unhandledRejection", err: unknown): void => {
    try {
      logServerError(`process.${kind}`, { err, fatal: true });
      Sentry.captureException(err, { tags: { kind } });
    } catch {
      // The handler itself must never throw — we are already crashing.
    }
    // Best-effort, bounded Sentry flush so the event ships before we exit.
    void Sentry.flush(2000)
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };

  process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => onFatal("unhandledRejection", reason));
}
