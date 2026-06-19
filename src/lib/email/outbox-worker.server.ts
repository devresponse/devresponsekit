import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { logServerError } from "@/lib/observability/logger.server";
import { getConfiguredEmailProvider } from "./providers.server";

/**
 * Outbox retry worker (review D1).
 *
 * `sendAppEmail` records every email in `app_outbox` and attempts delivery
 * once inline. A transient provider failure leaves the row RETRYABLE
 * (`status='pending'` with a future `next_attempt_at`); this worker re-attempts
 * those rows on a schedule until they succeed or exhaust {@link OUTBOX_MAX_ATTEMPTS}.
 *
 * Concurrency-safe: each row is claimed in its own short transaction with
 * `FOR UPDATE SKIP LOCKED`, so multiple drainers (or instances) never
 * double-send, and a slow provider call only ever holds ONE row's lock.
 * Invoke from a scheduler / init job (e.g. `pnpm outbox:drain`).
 */

/** Max delivery attempts before a row is marked terminally `failed`. */
export const OUTBOX_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60_000; // 1 minute
const BACKOFF_CAP_MS = 60 * 60_000; // 1 hour
const ERROR_MAX_LEN = 500;

/** Backoff before the Nth attempt (1-indexed): base · 2^(n-1), capped. */
export function backoffDelayMs(attempts: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

export interface DrainOutboxResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Process up to `limit` due rows (`status='pending'` AND `next_attempt_at`
 * null-or-past). Returns a per-outcome summary. A no-op (and no DB work) when
 * no email provider is configured.
 */
export async function drainOutbox(limit = 50): Promise<DrainOutboxResult> {
  const provider = getConfiguredEmailProvider();
  const result: DrainOutboxResult = { claimed: 0, sent: 0, retried: 0, failed: 0 };
  if (!provider) return result;

  for (let i = 0; i < limit; i++) {
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("app_outbox")
        .select(["id", "to_email", "from_email", "subject", "body_html", "body_text", "attempts"])
        .where("status", "=", "pending")
        .where((eb) =>
          eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", new Date())]),
        )
        .orderBy(sql`next_attempt_at asc nulls first`)
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return "empty" as const;

      const attempts = row.attempts + 1;
      const now = new Date();
      try {
        const delivered = await provider.deliver({
          to: row.to_email,
          from: row.from_email,
          subject: row.subject,
          html: row.body_html,
          text: row.body_text ?? undefined,
        });
        await trx
          .updateTable("app_outbox")
          .set({
            status: "sent",
            provider_message_id: delivered.providerMessageId ?? null,
            attempts,
            last_attempt_at: now,
            next_attempt_at: null,
            sent_at: now,
            error: null,
          })
          .where("id", "=", row.id)
          .execute();
        return "sent" as const;
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX_LEN);
        const terminal = attempts >= OUTBOX_MAX_ATTEMPTS;
        await trx
          .updateTable("app_outbox")
          .set({
            status: terminal ? "failed" : "pending",
            attempts,
            last_attempt_at: now,
            next_attempt_at: terminal ? null : new Date(now.getTime() + backoffDelayMs(attempts)),
            error: message,
          })
          .where("id", "=", row.id)
          .execute();
        return terminal ? ("failed" as const) : ("retried" as const);
      }
    });

    if (outcome === "empty") break;
    result.claimed++;
    result[outcome]++;
  }

  if (result.failed > 0) {
    logServerError("email outbox: rows exhausted their retry budget", {
      failedCount: result.failed,
    });
  }
  return result;
}
