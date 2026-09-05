import "server-only";
import { pgPool } from "@/db/database";
import { logger } from "@/lib/observability/logger.server";

/**
 * Graceful shutdown (OPS-4, reworked for review #24).
 *
 * Who owns what on SIGTERM/SIGINT under `next start` / the standalone
 * `node server.js` (both go through `next/dist/server/lib/start-server.js`):
 *
 * - **Next's `cleanup`** stops accepting connections, waits for every
 *   in-flight request (and `after()` work) to finish, then exits with the
 *   signal code — 143 for SIGTERM, 130 for SIGINT. It has NO time bound.
 *
 * - **This module is a bounded watchdog on top of that.** It must never end
 *   the pool while HTTP is still draining: `pgPool.end()` rejects every later
 *   checkout with "Cannot use a pool after calling end on the pool", and
 *   Kysely checks a client out PER QUERY, so the old handler (which ended the
 *   pool the instant the signal arrived) 500'd any request that was between
 *   its first and second query. It must also never exit 0: the old `exit(0)`
 *   raced Next's own exit and replaced the 128+signal code orchestrators use
 *   to tell a signal stop from a clean exit.
 *
 * Sequence:
 *
 * 1. Signal → log, arm a timer for `SHUTDOWN_TIMEOUT_MS` (default 10s). The
 *    timer is unref'd so it never keeps the process alive by itself.
 * 2. Normal path: Next drains HTTP and exits 143/130 first. Every in-flight
 *    query has completed by then; the idle pool sockets are closed by the OS
 *    at exit, which Postgres treats as an ordinary client disconnect.
 * 3. Stuck path: the timer fires — a request or `after()` job is wedged past
 *    the budget — so we end the pool best-effort (idle clients send a proper
 *    Terminate; checked-out ones are severed by the exit) and exit 128+signal
 *    ourselves. A stuck query can therefore never hang the shutdown past
 *    `SHUTDOWN_TIMEOUT_MS`; set the orchestrator's grace period above it.
 *
 * Owning the full sequence via `NEXT_MANUAL_SIG_HANDLE=1` was rejected: the
 * standalone `server.js` never exposes its `http.Server`, so nothing outside
 * Next can close it — do not set that variable, or the watchdog becomes the
 * only handler and the process exits after the budget without draining HTTP.
 *
 * Vercel / serverless: a no-op. The function runtime does not go through
 * `start-server.js` and does not deliver SIGTERM to a warm function in the
 * normal freeze/teardown path; registration is skipped outright when the
 * platform's `VERCEL` variable is set so nothing here can ever run there.
 */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

export type ShutdownSignal = "SIGTERM" | "SIGINT";

/** Conventional 128 + signal number, matching what Next's own cleanup exits with. */
const SIGNAL_EXIT_CODE: Record<ShutdownSignal, number> = { SIGTERM: 143, SIGINT: 130 };

let registered = false;
let shuttingDown = false;

/**
 * Arms the shutdown watchdog for `signal`. Returns as soon as the timer is
 * armed — the pool is NOT ended here (Next's drain owns that window, see
 * above). Re-entrant-safe: a second signal is ignored. `exit` is injected
 * for testing; it defaults to `process.exit`.
 */
export function gracefulShutdown(
  signal: ShutdownSignal,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(
    { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
    "graceful shutdown: signal received; HTTP drain owned by Next, watchdog armed",
  );

  const timer = setTimeout(() => {
    logger.warn(
      { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS, pool: poolStats() },
      "graceful shutdown: drain budget exhausted, ending pool and exiting",
    );
    // Fire-and-forget on purpose: `end()` waits for checked-out clients, and
    // the only reason we are here is that something is holding one past the
    // budget. Kicking it still sends Terminate to every idle client before the
    // exit severs the rest.
    void pgPool.end().catch((err: unknown) => {
      logger.error(
        { signal, err: err instanceof Error ? { name: err.name, message: err.message } : err },
        "graceful shutdown: error ending database pool",
      );
    });
    exit(SIGNAL_EXIT_CODE[signal]);
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't let the timer itself keep the event loop alive.
  if (typeof timer.unref === "function") timer.unref();
}

function poolStats(): { total: number; idle: number; waiting: number } {
  return { total: pgPool.totalCount, idle: pgPool.idleCount, waiting: pgPool.waitingCount };
}

/**
 * Registers the SIGTERM/SIGINT watchdog. Idempotent — safe to call more than
 * once. Invoke once at server startup (see `src/instrumentation.ts`).
 * Registers nothing on Vercel (see the module comment).
 */
export function registerGracefulShutdown(): void {
  if (registered) return;
  registered = true;
  if (process.env.VERCEL) return;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      gracefulShutdown(signal);
    });
  }
}
