import "server-only";
import { pgPool } from "@/db/database";
import { logger } from "@/lib/observability/logger.server";

/**
 * Graceful shutdown (OPS-4).
 *
 * On SIGTERM/SIGINT (an orchestrator stopping the container, `docker stop`,
 * a deploy rollout) we drain the shared pg pool so in-flight queries finish
 * and connections close cleanly instead of being severed mid-statement. The
 * drain is bounded by `SHUTDOWN_TIMEOUT_MS` (default 10s) so a stuck query
 * can never hang the shutdown past the orchestrator's own kill grace period.
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

let registered = false;
let shuttingDown = false;

/**
 * Drains the pg pool and exits. Re-entrant-safe (a second signal is ignored).
 * `exit` is injected for testing; it defaults to `process.exit`.
 */
export async function gracefulShutdown(
  signal: string,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "graceful shutdown: draining database pool");

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    logger.warn(
      { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
      "graceful shutdown: pool drain timed out, exiting anyway",
    );
    exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't let the timer itself keep the event loop alive.
  if (typeof timer.unref === "function") timer.unref();

  try {
    await pgPool.end();
    if (!timedOut) logger.info({ signal }, "graceful shutdown: database pool drained");
  } catch (err) {
    logger.error(
      { signal, err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "graceful shutdown: error draining database pool",
    );
  } finally {
    clearTimeout(timer);
    // If the timeout already fired and exited, don't double-exit.
    if (!timedOut) exit(0);
  }
}

/**
 * Registers SIGTERM/SIGINT handlers that drain the pg pool before exiting.
 * Idempotent — safe to call more than once. Invoke once at server startup
 * (see `src/instrumentation.ts`).
 */
export function registerGracefulShutdown(): void {
  if (registered) return;
  registered = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void gracefulShutdown(signal);
    });
  }
}
