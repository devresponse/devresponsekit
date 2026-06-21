import "server-only";
import { Counter, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics registry (observability epic #52 — first increment).
 *
 * Exposes a scrape endpoint at `GET /api/metrics` (token-guarded). This module
 * holds a DEDICATED `Registry` (not prom-client's global `register`) so test
 * module reloads never collide with a process-global singleton, and so the
 * surface stays explicit.
 *
 * What ships here:
 *   - Node/process default metrics (heap, RSS, event-loop lag, GC, CPU, handles)
 *     — the highest-value-per-effort signal for catching leaks / saturation,
 *     with zero application instrumentation.
 *   - `…_rate_limit_denials_total{scope}` — the first business counter, fed from
 *     the limiter's deny path.
 *
 * Next increments (tracked in docs/observability.md §5): request latency/status
 * by route, DB latency, auth failures, and outbox delivery.
 *
 * Per-instance, like the limiter: each process keeps its own counters, scraped
 * independently. That matches the single-instance 1.0 topology; a multi-instance
 * setup aggregates across scrape targets at the Prometheus layer.
 */
export const registry = new Registry();

let defaultsStarted = false;

/**
 * Lazily begin collecting Node/process default metrics — on first scrape, NOT at
 * import. Importing a counter (to increment it from a hot path like the limiter)
 * must not kick off default collection in every route that touches that path.
 */
export function startDefaultMetrics(): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  collectDefaultMetrics({ register: registry, prefix: "devresponsekit_" });
}

/** Rate-limit (429) denials, labelled by scope — the abuse / throttling signal. */
export const rateLimitDenialsTotal = new Counter({
  name: "devresponsekit_rate_limit_denials_total",
  help: "Total rate-limit denials (HTTP 429), by limiter scope.",
  labelNames: ["scope"],
  registers: [registry],
});

/**
 * Test-only: zero every counter/gauge value between cases.
 *
 * Deliberately does NOT flip `defaultsStarted` back to `false`: the default
 * collectors stay registered after the first {@link startDefaultMetrics}, and
 * `collectDefaultMetrics` throws on a second registration of the same names.
 * Re-arming the flag would make the next scrape re-register and crash — so we
 * only reset *values* (`resetMetrics`), never the one-shot start latch.
 */
export function __resetMetricsForTests(): void {
  registry.resetMetrics();
}
