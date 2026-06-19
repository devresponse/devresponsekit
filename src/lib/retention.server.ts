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
 *   - `app_revoked_tokens`  → rows are pruned the moment they expire (also
 *     done opportunistically on each `revokeJti`, since that is the only
 *     writer — see revocation.server.ts).
 *   - `app_audit_events`    → retained AUDIT_RETENTION_DAYS (default 365);
 *     a compliance record, so the window is long and configurable.
 *   - `app_outbox`          → terminal rows (sent/failed/logged) retained
 *     OUTBOX_RETENTION_DAYS (default 90); `pending` rows are never pruned
 *     (they are in-flight retries — see the D1 outbox worker).
 *
 * Set either window to 0 to disable that table's time-based prune.
 */

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const DEFAULT_OUTBOX_RETENTION_DAYS = 90;

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
 * DELETE — EXCEPT inside a transaction that has set the `app.audit_retention`
 * flag, which ONLY this path does. Setting the flag is a harmless no-op if the
 * trigger is not installed yet, so D3 and B3 are order-independent.
 */
export async function pruneAuditEvents(days: number): Promise<number> {
  if (days <= 0) return 0;
  return db.transaction().execute(async (trx) => {
    await trx.executeQuery(CompiledQuery.raw("set local app.audit_retention = 'on'"));
    const res = await trx
      .deleteFrom("app_audit_events")
      .where(sql<boolean>`created_at < now() - ${sql.lit(days)} * interval '1 day'`)
      .executeTakeFirst();
    return Number(res.numDeletedRows ?? 0);
  });
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

export interface RetentionResult {
  revocations: number;
  auditEvents: number;
  outbox: number;
}

/** Runs all three prunes using the env-configured windows. */
export async function pruneAll(): Promise<RetentionResult> {
  const auditDays = retentionDays(process.env.AUDIT_RETENTION_DAYS, DEFAULT_AUDIT_RETENTION_DAYS);
  const outboxDays = retentionDays(
    process.env.OUTBOX_RETENTION_DAYS,
    DEFAULT_OUTBOX_RETENTION_DAYS,
  );
  return {
    revocations: await pruneExpiredRevocations(),
    auditEvents: await pruneAuditEvents(auditDays),
    outbox: await pruneOutbox(outboxDays),
  };
}
