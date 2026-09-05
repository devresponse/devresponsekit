import "server-only";
import * as Sentry from "@sentry/nextjs";
import { logServerError } from "@/lib/observability/logger.server";

/**
 * D5: last-resort process-level error handlers for the Node runtime.
 *
 * An `unhandledRejection` or `uncaughtException` must never be SILENT: these
 * handlers record it (stdout via `logServerError` + Sentry, tagged with the
 * kind) so a fault that escaped every request boundary is still visible.
 *
 * What they deliberately do NOT do any more (review #23): exit. Next 16
 * installs its own listeners for both events and treats them as NON-fatal —
 * `node_modules/next/dist/server/node-environment-extensions/process-error-handlers.js`
 * (installed from `next-server.js`): a late-awaited prefetch promise that
 * rejects after the render decided it did not need the data is a normal RSC
 * pattern, not a crash, and per that file "even a legit unhandled error
 * unrelated to prefetching shouldn't prevent the rest of the page from
 * rendering". The previous `process.exit(1)` turned one stray rejection into a
 * full restart of the single `node server.js` instance — dropping every
 * in-flight request — for an event Next had already contained.
 *
 * `unhandledRejection` therefore NEVER exits. An `uncaughtException` is a
 * synchronous throw that escaped every frame, so some operators prefer the
 * classic fail-fast restart; that is opt-in via `PROCESS_FATAL_ON_UNCAUGHT=1`
 * (see `src/lib/env.ts`), which exits 1 after the capture + a bounded Sentry
 * flush. Registered from `instrumentation.ts` (Node branch).
 */
let registered = false;

type ProcessErrorKind = "uncaughtException" | "unhandledRejection";

/**
 * Same "1"/"true" rule as the flag's schema entry in `env.ts`, read straight
 * from `process.env` at event time: the crash path must not depend on the
 * (throwing) schema parser, and the flag must be flippable without a rebuild.
 */
function fatalOnUncaught(): boolean {
  const value = process.env.PROCESS_FATAL_ON_UNCAUGHT;
  return value === "1" || value === "true";
}

export function registerProcessErrorHandlers(): void {
  if (registered) return;
  registered = true;

  const onProcessError = (kind: ProcessErrorKind, err: unknown): void => {
    const fatal = kind === "uncaughtException" && fatalOnUncaught();
    try {
      logServerError(`process.${kind}`, { err, fatal });
      Sentry.captureException(err, { tags: { kind } });
    } catch {
      // The handler itself must never throw — it runs where nothing can catch it.
    }
    if (!fatal) return;
    // Best-effort, bounded Sentry flush so the event ships before we exit. A
    // process that just threw synchronously past every frame is in an
    // undefined state, so we exit fast rather than attempt a clean drain.
    void Sentry.flush(2000)
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };

  process.on("uncaughtException", (err) => onProcessError("uncaughtException", err));
  process.on("unhandledRejection", (reason) => onProcessError("unhandledRejection", reason));
}
