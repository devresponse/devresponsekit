import "server-only";
import { CompiledQuery, sql } from "kysely";
import { db } from "@/db/database";
import { pruneExpiredRevocations } from "@/lib/api-auth/revocation.server";

/**
 * Data-retention pruning (review D3). Three tables grow without bound under
 * normal operation; this is the maintenance path that keeps them in check.
 * Run it on a schedule via `pnpm db:prune` (cron / Kubernetes CronJob / init
 * job) — the same "no new scheduler infra" approach as the outbox drainer.
 *
 *   - `app_revoked_tokens`  → rows are pruned the moment they expire. The
 *     table has had NO writer since review #43 retired the `jti` denylist in
 *     favour of the per-request credential check (see revocation.server.ts),
 *     so this scheduled prune is the only thing that touches it until a
 *     later core migration drops the table.
 *   - `app_audit_events`    → retained AUDIT_RETENTION_DAYS (default 365);
 *     a compliance record, so the window is long and configurable. Deleted in
 *     BATCHES (audit #21) so a backlog can't stall against statement_timeout.
 *   - `app_outbox`          → terminal rows (sent/failed/logged) retained
 *     OUTBOX_RETENTION_DAYS (default 90). `pending` rows are in-flight retries
 *     and are normally left alone — but a row queued for a since-removed
 *     provider is never claimed, so a hard OUTBOX_MAX_PENDING_DAYS sweep
 *     (default 7, well past the retry budget) fails such orphans so they can
 *     then be pruned (audit #10).
 *
 * Set any window to 0 to disable that table's time-based prune / sweep.
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const DEFAULT_OUTBOX_RETENTION_DAYS = 90;
export const DEFAULT_OUTBOX_MAX_PENDING_DAYS = 7;
/** Batch size for the audit prune — bounds each DELETE's lock/WAL/timeout cost. */
const AUDIT_PRUNE_BATCH = 5000;

/** Parses a non-negative integer day-count env var, falling back when unset/invalid. */
export function retentionDays(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * Deletes audit rows older than `days` (a no-op when `days <= 0`).
 *
 * B3 makes `app_audit_events` append-only via a trigger that blocks UPDATE and
 * DELETE. The ONE sanctioned path is `app_audit_events_prune(days, batch)`
 * (migration 0004, review #83): a SECURITY DEFINER function owned by the
 * schema owner, so it runs with the owner's privileges whoever calls it — the
 * least-privilege runtime role has no DELETE on the table at all, and the
 * trigger only lets a DELETE through when the effective role IS the owner
 * inside that function. Nothing here sets a GUC any more; the marker the
 * trigger checks is set inside the function, transaction-locally.
 */
export async function pruneAuditEvents(
  days: number,
  batchSize = AUDIT_PRUNE_BATCH,
): Promise<number> {
  if (days <= 0) return 0;
  let total = 0;
  // Delete in bounded batches (audit #21): the function deletes at most
  // `batchSize` rows per call (`ctid in (… limit N)`), each call its own
  // short statement, so a large backlog can't stall against
  // statement_timeout — loop until a short batch says it is drained.
  for (;;) {
    const res = await db.executeQuery(
      CompiledQuery.raw("select app_audit_events_prune($1, $2) as n", [days, batchSize]),
    );
    const deleted = Number((res.rows[0] as { n?: number | string } | undefined)?.n ?? 0);
    total += deleted;
    if (deleted < batchSize) break; // a short/empty batch means we drained it
  }
  return total;
}

/**
 * Deletes TERMINAL outbox rows (anything not `pending`) older than `days`
 * (a no-op when `days <= 0`). `pending` rows are in-flight retries and are
 * never pruned, so this can never drop an email still awaiting delivery.
 */
export async function pruneOutbox(days: number): Promise<number> {
  if (days <= 0) return 0;
  const res = await db
    .deleteFrom("app_outbox")
    .where("status", "!=", "pending")
    .where(sql<boolean>`created_at < now() - ${sql.lit(days)} * interval '1 day'`)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

/**
 * Fails `pending` outbox rows older than `days` (a no-op when `days <= 0`).
 *
 * The drain worker claims ONLY rows for the CURRENTLY configured provider
 * (providers own their `from`), so a row queued for a since-removed or switched
 * provider is never retried and — being `pending` — never pruned, accumulating
 * forever (audit #10). Well past the retry budget (OUTBOX_MAX_ATTEMPTS × backoff
 * ≈ hours) a still-`pending` row is orphaned; mark it terminally `failed` so the
 * time-based {@link pruneOutbox} can reclaim it.
 */
export async function failStalePendingOutbox(days: number): Promise<number> {
  if (days <= 0) return 0;
  const res = await db
    .updateTable("app_outbox")
    .set({
      status: "failed",
      error: "orphaned: no active provider claimed this row within the retry window",
      last_attempt_at: new Date(),
      // Terminal: the unredacted delivery copy is no longer needed (#21).
      delivery_payload: null,
    })
    .where("status", "=", "pending")
    .where(sql<boolean>`created_at < now() - ${sql.lit(days)} * interval '1 day'`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

export interface RetentionResult {
  revocations: number;
  auditEvents: number;
  outbox: number;
  staleOutboxFailed: number;
}

/** Runs all prunes/sweeps using the env-configured windows. */
export async function pruneAll(): Promise<RetentionResult> {
  const auditDays = retentionDays(process.env.AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS);
  const outboxDays = retentionDays(
    process.env.OUTBOX_RETENTION_DAYS,
    DEFAULT_OUTBOX_RETENTION_DAYS,
  );
  const maxPendingDays = retentionDays(
    process.env.OUTBOX_MAX_PENDING_DAYS,
    DEFAULT_OUTBOX_MAX_PENDING_DAYS,
  );
  const revocations = await pruneExpiredRevocations();
  const auditEvents = await pruneAuditEvents(auditDays);
  // Fail orphaned pending rows BEFORE the time-based prune so they can be
  // reclaimed in the same run.
  const staleOutboxFailed = await failStalePendingOutbox(maxPendingDays);
  const outbox = await pruneOutbox(outboxDays);
  return { revocations, auditEvents, outbox, staleOutboxFailed };
}
