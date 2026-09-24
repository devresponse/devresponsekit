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
 *   - `…_pre_auth_refusals_total{event_type}` — refusals decided before the
 *     caller authenticated, which are logged instead of audited (F-15).
 *   - `…_outbox_delivery_total{outcome,template}` — every email delivery
 *     outcome, inline and from the drain worker, that happens in THIS process
 *     (F-27): a `pnpm outbox:drain` run counts into its own copy of this
 *     registry, which nothing scrapes and which dies with it.
 *
 * Next increments (tracked in docs/observability.md §6): request latency/status
 * by route, DB latency and auth failures.
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
 * Times the Postgres-backed pre-auth limiter (review #98) could not reach its
 * table and fell back to the in-process bucket, by scope. Non-zero means the
 * "deployment-wide" floors are per-instance right now — either the database
 * is unhealthy or migration 0006 has not been applied; the paired structured
 * warning in the log stream carries the error.
 */
export const rateLimitSharedFallbacksTotal = new Counter({
  name: "devresponsekit_rate_limit_shared_fallbacks_total",
  help: "Times the shared (Postgres) pre-auth rate limiter fell back to the in-process bucket, by scope.",
  labelNames: ["scope"],
  registers: [registry],
});

/**
 * Requests refused BEFORE the caller authenticated (F-15), by the event type
 * on the paired log line: the CSRF origin guard on every cookie surface, the
 * SSO consume refusals decided before the handoff token verifies, and the
 * signed-out SSO launch. None of these writes an `app_audit_events` row any
 * more — an anonymous loop must not be able to grow the append-only table —
 * so this counter and the `pre_auth_refusal` log line are their record. The
 * label is a code literal per call site, never request data, so its
 * cardinality is fixed.
 */
export const preAuthRefusalsTotal = new Counter({
  name: "devresponsekit_pre_auth_refusals_total",
  help: "Requests refused before authentication (logged, not audited), by event type.",
  labelNames: ["event_type"],
  registers: [registry],
});

/**
 * Email delivery outcomes (F-27), one increment per outcome written to an
 * `app_outbox` row: `sent`, `retry` (a transient failure, rescheduled),
 * `failed` (terminal: a permanent provider rejection or the attempt cap),
 * `expired` (the drain worker failed a row whose one-time link had died,
 * without calling the provider) and `logged` (no provider configured, so
 * nothing was sent). Before this an inline failure left no trace outside the
 * row itself, so a sender the provider refuses failed every reset,
 * verification and invitation email without anything alerting. The only
 * writer is `recordOutboxDelivery` (src/lib/email/delivery-telemetry.server.ts),
 * which maps any template key outside the built-in set to `other`, so both
 * labels have a fixed cardinality. The worker's outcomes land here only when
 * the drain runs in the server (the `/api/internal/outbox-drain` route), not
 * from the `pnpm outbox:drain` CLI; see docs/observability.md §5.
 */
export const outboxDeliveryTotal = new Counter({
  name: "devresponsekit_outbox_delivery_total",
  help: "Email outbox delivery outcomes (sent, retry, failed, expired, logged), by template.",
  labelNames: ["outcome", "template"],
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
