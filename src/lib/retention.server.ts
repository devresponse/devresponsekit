import "server-only";
import { CompiledQuery, sql } from "kysely";
import { db } from "@/db/database";
import { pruneExpiredRevocations } from "@/lib/api-auth/revocation.server";

/**
 * Data-retention pruning (review D3). These tables grow without bound under
 * normal operation; this is the maintenance path that keeps them in check.
 * Two schedulers call {@link pruneAll}, the same "no new scheduler infra"
 * approach as the outbox drainer: the daily `GET /api/internal/outbox-drain`
 * Vercel Cron runs it after each drain (F-96 — on Vercel nothing else would),
 * and `pnpm db:prune` runs it from a cron / Kubernetes CronJob / init job on
 * any other host.
 *
 *   - `app_revoked_tokens`  → rows are pruned the moment they expire. The
 *     table has had NO writer since review #43 retired the `jti` denylist in
 *     favour of the per-request credential check (see revocation.server.ts),
 *     so this scheduled prune is the only thing that touches it until a
 *     later core migration drops the table.
 *   - `app_audit_events`    → retained AUDIT_RETENTION_DAYS (default 365);
 *     a compliance record, so the window is long and configurable.
 *   - `app_outbox`          → terminal rows (sent/failed/logged) retained
 *     OUTBOX_RETENTION_DAYS (default 90). `pending` rows are in-flight retries
 *     and are normally left alone — but a row queued for a since-removed
 *     provider is never claimed, so a hard OUTBOX_MAX_PENDING_DAYS sweep
 *     (default 7, well past the retry budget) fails such orphans so they can
 *     then be pruned (audit #10).
 *   - `app_sso_handoff_nonces` → rows expired over an hour ago (F-84). Each
 *     SSO launch purges these too, so this only matters when launches stop.
 *
 * Every time-based prune and sweep runs in BATCHES (audit #21 for the audit
 * log, F-96 for the outbox), each batch its own short statement, so the first
 * run over months of backlog can't stall against statement_timeout. A caller
 * with a wall-clock ceiling passes a deadline and the batches stop there; the
 * next run picks up where this one stopped.
 *
 * Set any window to 0 to disable that table's time-based prune / sweep.
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const DEFAULT_OUTBOX_RETENTION_DAYS = 90;
export const DEFAULT_OUTBOX_MAX_PENDING_DAYS = 7;
/**
 * Batch size for the audit prune — bounds each DELETE's lock/WAL/timeout cost.
 * Must stay ≤ the function's own cap (`c_max_batch`, 10000, migration 0005):
 * the loop below treats a batch shorter than THIS number as "drained", so a
 * larger value would stop after one capped batch.
 */
const AUDIT_PRUNE_BATCH = 5000;
/**
 * Batch size for the outbox prune and the stale-pending sweep (F-96). Smaller
 * than the audit batch because an outbox row carries whole rendered email
 * bodies, so each one costs more to delete or rewrite.
 */
const OUTBOX_BATCH = 1000;
/**
 * The shortest audit window the database will honour (review #83). Mirrors
 * `c_floor_days` in `app_audit_events_prune` (migration 0005) — the database
 * clamps whatever it is asked, this constant only lets the worker say so in
 * its log instead of silently pruning less than configured. Change both in
 * lock-step (a new migration re-creates the function).
 */
export const AUDIT_RETENTION_FLOOR_DAYS = 30;

/**
 * How long past its expiry an SSO handoff nonce is kept. A handoff token lives
 * at most 60 s and the consume burn needs an unexpired row, so an hour is far
 * past any use; it is the same grace the launch-time purge applies
 * (`createSsoHandoffRedirect`, src/lib/sso.server.ts).
 */
const SSO_NONCE_GRACE_MS = 60 * 60 * 1000;

/** Parses a non-negative integer day-count env var, falling back when unset/invalid. */
export function retentionDays(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/** `created_at` more than `days` days ago: the one window every time-based sweep uses. */
function olderThanDays(days: number) {
  return sql<boolean>`created_at < now() - ${sql.lit(days)} * interval '1 day'`;
}

/**
 * Runs `runBatch` until a batch shorter than `batchSize` says the table is
 * drained, or until `deadline` (epoch ms) has passed, and returns the total.
 *
 * The deadline is checked before every batch, the first included (F-96): the
 * cron route runs this after the outbox drain inside one function invocation,
 * and a batch started past its budget risks the platform killing the function
 * before it can answer. Stopping early loses nothing — every batch commits on
 * its own — so it only logs how far it got.
 */
async function inBatches(
  table: string,
  batchSize: number,
  deadline: number,
  runBatch: () => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    if (Date.now() >= deadline) {
      console.warn(
        `[retention] ${table}: stopped at the time budget after ${total} rows; the next run continues`,
      );
      return total;
    }
    const n = await runBatch();
    total += n;
    if (n < batchSize) return total; // a short/empty batch means we drained it
  }
}

/**
 * Deletes audit rows older than `days` (a no-op when `days <= 0`; a window
 * shorter than {@link AUDIT_RETENTION_FLOOR_DAYS} is raised to the floor).
 *
 * B3 makes `app_audit_events` append-only via a trigger that blocks UPDATE and
 * DELETE. The ONE sanctioned path for the application is
 * `app_audit_events_prune(days, batch)` (migration 0005, review #83): a
 * SECURITY DEFINER function owned by the schema owner, so it runs with the
 * owner's privileges whoever calls it — the least-privilege runtime role has
 * no DELETE on the table at all, and the trigger lets a DELETE through only
 * when the EFFECTIVE role is the table owner and the transaction-local
 * `app.audit_retention` marker is on. The function satisfies both; a session
 * connected as the runtime role can satisfy neither. (A session connected as
 * the owner itself — the default until Deployment §8's role switch — can
 * still set the marker and delete; the boundary is the role, not the
 * trigger.) The function also clamps `days` to the floor server-side, so the
 * clamp here is a courtesy log, not the enforcement. Nothing here sets a GUC.
 */
export async function pruneAuditEvents(
  days: number,
  batchSize = AUDIT_PRUNE_BATCH,
  deadline = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (days <= 0) return 0;
  if (days < AUDIT_RETENTION_FLOOR_DAYS) {
    console.warn(
      `[retention] AUDIT_RETENTION_DAYS=${days} is below the database floor of ${AUDIT_RETENTION_FLOOR_DAYS} days; pruning at ${AUDIT_RETENTION_FLOOR_DAYS}`,
    );
    days = AUDIT_RETENTION_FLOOR_DAYS;
  }
  // Delete in bounded batches (audit #21): the function deletes at most
  // `batchSize` rows per call (`ctid in (… limit N)`).
  return inBatches("audit", batchSize, deadline, async () => {
    const res = await db.executeQuery(
      CompiledQuery.raw("select app_audit_events_prune($1, $2) as n", [days, batchSize]),
    );
    return Number((res.rows[0] as { n?: number | string } | undefined)?.n ?? 0);
  });
}

/**
 * Deletes TERMINAL outbox rows (anything not `pending`) older than `days`
 * (a no-op when `days <= 0`). `pending` rows are in-flight retries and are
 * never pruned, so this can never drop an email still awaiting delivery.
 *
 * Batched like the audit prune (F-96): each statement deletes at most
 * `batchSize` rows, picked by `id in (select … limit N)`. It used to be one
 * DELETE over every due row, which on a first run against months of backlog
 * could outlast statement_timeout, roll back, and fail the same way on every
 * run after.
 */
export async function pruneOutbox(
  days: number,
  batchSize = OUTBOX_BATCH,
  deadline = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (days <= 0) return 0;
  return inBatches("outbox", batchSize, deadline, async () => {
    const res = await db
      .deleteFrom("app_outbox")
      // Repeated outside the subquery: READ COMMITTED re-checks only the outer
      // WHERE on a row another transaction changed after the subquery chose it.
      .where("status", "!=", "pending")
      .where(
        "id",
        "in",
        db
          .selectFrom("app_outbox")
          .select("id")
          .where("status", "!=", "pending")
          .where(olderThanDays(days))
          .limit(batchSize),
      )
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  });
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
export async function failStalePendingOutbox(
  days: number,
  batchSize = OUTBOX_BATCH,
  deadline = Number.POSITIVE_INFINITY,
): Promise<number> {
  if (days <= 0) return 0;
  // Batched for the same reason as the prune (F-96): orphans pile up for as
  // long as nothing sweeps them, so the first sweep can face all of them.
  return inBatches("outbox (stale pending)", batchSize, deadline, async () => {
    const res = await db
      .updateTable("app_outbox")
      .set({
        status: "failed",
        error: "orphaned: no active provider claimed this row within the retry window",
        last_attempt_at: new Date(),
        // Terminal: the unredacted delivery copy is no longer needed (#21).
        delivery_payload: null,
      })
      // Repeated outside the subquery, so a row the drain sent while this
      // statement waited on its lock is re-checked and stays `sent`.
      .where("status", "=", "pending")
      .where(
        "id",
        "in",
        db
          .selectFrom("app_outbox")
          .select("id")
          .where("status", "=", "pending")
          .where(olderThanDays(days))
          .limit(batchSize),
      )
      .executeTakeFirst();
    return Number(res.numUpdatedRows ?? 0);
  });
}

/**
 * Deletes SSO handoff nonces that expired more than {@link SSO_NONCE_GRACE_MS}
 * ago (F-84).
 *
 * The only purge used to be the one each SSO launch runs before it inserts its
 * own nonce, so the table shrank only while someone launched an available app:
 * after the last launch its rows stayed forever. This scheduled prune makes
 * the table's size independent of launch traffic. One statement, on the
 * `expires_at` index: the launch-time purge keeps the table to about an hour
 * of launches, so there is no backlog to batch.
 */
export async function pruneExpiredSsoNonces(): Promise<number> {
  const result = await db
    .deleteFrom("app_sso_handoff_nonces")
    .where("expires_at", "<", new Date(Date.now() - SSO_NONCE_GRACE_MS))
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

export interface RetentionResult {
  revocations: number;
  auditEvents: number;
  outbox: number;
  staleOutboxFailed: number;
  ssoNonces: number;
}

export interface PruneAllOptions {
  /**
   * Epoch ms after which no further batch starts (F-96). The cron route sets
   * it so the whole tick fits its `maxDuration`; `pnpm db:prune` leaves it
   * unset and runs to completion.
   */
  deadline?: number;
}

/** Runs all prunes/sweeps using the env-configured windows. */
export async function pruneAll(options: PruneAllOptions = {}): Promise<RetentionResult> {
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const auditDays = retentionDays(process.env.AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS);
  const outboxDays = retentionDays(
    process.env.OUTBOX_RETENTION_DAYS,
    DEFAULT_OUTBOX_RETENTION_DAYS,
  );
  const maxPendingDays = retentionDays(
    process.env.OUTBOX_MAX_PENDING_DAYS,
    DEFAULT_OUTBOX_MAX_PENDING_DAYS,
  );
  // One statement over a table nothing writes any more (see the header), so
  // it needs neither batching nor the deadline.
  const revocations = await pruneExpiredRevocations();
  const auditEvents = await pruneAuditEvents(auditDays, AUDIT_PRUNE_BATCH, deadline);
  // Fail orphaned pending rows BEFORE the time-based prune so they can be
  // reclaimed in the same run.
  const staleOutboxFailed = await failStalePendingOutbox(maxPendingDays, OUTBOX_BATCH, deadline);
  const outbox = await pruneOutbox(outboxDays, OUTBOX_BATCH, deadline);
  // Like the revocation prune: one short statement, so no deadline check.
  const ssoNonces = await pruneExpiredSsoNonces();
  return { revocations, auditEvents, outbox, staleOutboxFailed, ssoNonces };
}
