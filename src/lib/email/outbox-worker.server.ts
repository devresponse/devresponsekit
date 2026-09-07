import "server-only";
import { sql } from "kysely";
import { db } from "@/db/database";
import { logServerError } from "@/lib/observability/logger.server";
import { getConfiguredEmailProvider, isRetryableDeliveryError } from "./providers.server";
import { parseOutboxDeliveryPayload } from "./outbox-secrets";

/**
 * Outbox retry worker (review D1).
 *
 * `sendAppEmail` records every email in `app_outbox` and attempts delivery
 * once inline. A transient provider failure leaves the row RETRYABLE
 * (`status='pending'` with a future `next_attempt_at`); this worker re-attempts
 * those rows on a schedule until they succeed or exhaust {@link OUTBOX_MAX_ATTEMPTS}.
 *
 * Three ways a row stops short of that budget:
 *   - the provider rejected it PERMANENTLY (a non-retryable 4xx) → terminal on
 *     the attempt that saw it (review #219)
 *   - the one-time token it carries has already expired → terminal WITHOUT a
 *     delivery attempt, so nobody receives a dead link (review #90)
 *   - `EMAIL_PROVIDER` was switched → the row waits (see the claim predicate)
 *
 * Concurrency-safe: each row is claimed in its own short transaction with
 * `FOR UPDATE SKIP LOCKED`, so multiple drainers (or instances) never claim the
 * same row at once, and a slow provider call only ever holds ONE row's lock.
 *
 * Delivery is at-least-once, not exactly-once: the provider call runs inside
 * the claim transaction, so a crash after a successful send but before the
 * `sent` UPDATE commits leaves the row `pending` and it is re-attempted. To
 * make that effectively-once, each send carries a stable `idempotencyKey` (the
 * outbox row id) so the provider dedupes the retry (audit #11) — Resend
 * natively; Mailgun best-effort (see providers.server.ts). Invoke from a
 * scheduler / init job (e.g. `pnpm outbox:drain`).
 *
 * Secrets (review #21): `body_html` / `body_text` hold a REDACTED rendering
 * (tokens replaced by `[redacted]`), so a retry delivers from
 * `delivery_payload` — the unredacted copy `sendAppEmail` stores only for
 * rows that carried a secret — and falls back to the stored columns when it
 * is null (a row without secrets, or one written before 0003). The payload
 * is nulled as soon as the row is terminal, so a live token never outlives
 * the delivery that needs it.
 */

/** Max delivery attempts before a row is marked terminally `failed`. */
export const OUTBOX_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60_000; // 1 minute
const BACKOFF_CAP_MS = 60 * 60_000; // 1 hour
/** Bound on the reason stored in `app_outbox.error` (a short reason, not a body). */
const ERROR_MAX_LEN = 200;

/**
 * How long the one-time credential inside each token-bearing template stays
 * valid, keyed by `app_outbox.template_key` (review #90).
 *
 * The drain runs on a DAILY cron (`vercel.json`: `0 8 * * *`), so a
 * `password_reset` row whose inline attempt failed was re-attempted ~24h
 * later and delivered a link that had been dead for ~23 of them: the user
 * receives a mail, clicks it, and is told the link is invalid — worse than
 * receiving nothing, because it looks like the account is broken.
 *
 * DECISION: such a row is marked terminally `failed` with a `token_expired`
 * reason instead of being delivered. We do NOT regenerate the token here.
 * Minting a fresh password-reset or verification credential is a
 * user-initiated, rate-limited, audited action; a background cron silently
 * re-issuing one — hours after the request, to an address nobody re-asserted
 * — would turn a delivery worker into a credential issuer. The honest
 * outcome is "this mail was never delivered, ask for another link": the row
 * is visible in the admin Email workspace with its reason, and the user's own
 * "forgot password" / "resend verification" action mints a live token.
 *
 * Values mirror Better Auth's defaults, which `src/lib/auth.ts` does not
 * override (`resetPasswordTokenExpiresIn` / `emailVerification.expiresIn`,
 * both 1h) and `INVITATION_TTL_MS` in `invitations.server.ts` (7 days,
 * inlined so the worker does not pull the invitation module into the cron
 * path). Overriding a TTL there means updating it here.
 */
export const TOKEN_TTL_MS_BY_TEMPLATE: Readonly<Record<string, number>> = {
  password_reset: 60 * 60_000,
  email_verification: 60 * 60_000,
  organization_invitation: 7 * 24 * 60 * 60_000,
};

/**
 * Whether the one-time token this row carries is already dead, so delivering
 * it would hand the recipient a link that cannot work (review #90). Rows for
 * templates that carry no time-limited credential (`test_email`, and any
 * future notification) are never expired by this rule.
 */
export function outboxTokenExpired(
  templateKey: string | null,
  // `Date | string` because the driver hands back whatever the column's
  // `ColumnType` allows; a pg `timestamptz` is a Date, but a string survives
  // a raw query or a serialised round-trip.
  createdAt: Date | string,
  now: Date = new Date(),
): boolean {
  if (templateKey === null) return false;
  const ttl = TOKEN_TTL_MS_BY_TEMPLATE[templateKey];
  if (ttl === undefined) return false;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  // An unparseable timestamp must not silently expire live mail.
  if (Number.isNaN(created.getTime())) return false;
  return created.getTime() + ttl <= now.getTime();
}

/** Backoff before the Nth attempt (1-indexed): base · 2^(n-1), capped. */
export function backoffDelayMs(attempts: number): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, BACKOFF_CAP_MS);
}

/**
 * Distils a delivery error into a SHORT, single-line reason for
 * `app_outbox.error` (P3-8). Providers embed the vendor's raw HTTP response
 * body in the thrown message (see providers.server.ts); that body is
 * attacker/vendor-influenced and `app_outbox.error` is surfaced in the
 * org-scoped admin Email workspace, so we must not persist it verbatim.
 * Strip control characters (the newlines etc. that carry multi-line dumps),
 * collapse whitespace, and hard-cap the length — keeping the useful
 * `"<provider> <status>: …"` prefix while dropping the bulk of the body.
 */
export function summarizeDeliveryError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const oneLine = raw
    .replace(/\p{Cc}/gu, " ") // strip control chars (newlines, tabs, …)
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > ERROR_MAX_LEN ? `${oneLine.slice(0, ERROR_MAX_LEN)}…` : oneLine;
}

export interface DrainOutboxResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  /**
   * Rows failed WITHOUT a delivery attempt because their one-time token had
   * already expired (review #90). Counted in `failed` as well, so existing
   * consumers of that number keep their meaning; broken out so an operator
   * can tell "the provider rejects our mail" from "we are queueing
   * token-bearing mail faster than the cron drains it".
   */
  expired: number;
}

/**
 * Process up to `limit` due rows (`status='pending'` AND `next_attempt_at`
 * null-or-past) for the CURRENTLY configured provider. Returns a per-outcome
 * summary. A no-op (and no DB work) when no email provider is configured.
 */
export async function drainOutbox(limit = 50): Promise<DrainOutboxResult> {
  const provider = getConfiguredEmailProvider();
  const result: DrainOutboxResult = { claimed: 0, sent: 0, retried: 0, failed: 0, expired: 0 };
  if (!provider) return result;

  for (let i = 0; i < limit; i++) {
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("app_outbox")
        .select([
          "id",
          "to_email",
          "from_email",
          "subject",
          "body_html",
          "body_text",
          "delivery_payload",
          "attempts",
          // review #90: needed to tell whether this row's one-time token is
          // still alive before we spend an attempt delivering it.
          "template_key",
          "created_at",
        ])
        .where("status", "=", "pending")
        // Claim ONLY rows enqueued for the active provider (P3-8). A row's
        // `from_email`/headers were chosen for the provider it was queued
        // against; if `EMAIL_PROVIDER` was switched mid-retry, re-sending it
        // through the new provider would use a `from` the new provider may
        // not own. Rows for the old provider wait until it is active again.
        .where("provider", "=", provider.id)
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

      // review #90: never deliver a dead credential. A `password_reset` /
      // `email_verification` row re-attempted by the daily cron carries a
      // token that expired ~23h ago; sending it hands the recipient a link
      // that is guaranteed to fail. Fail the row instead, with a reason an
      // operator can read in the Email workspace, and drop the unredacted
      // payload — nothing will ever deliver it (see TOKEN_TTL_MS_BY_TEMPLATE
      // for why we fail rather than mint a fresh token here).
      // `created_at` is declared `Generated<Timestamp>` — a ColumnType nested
      // inside a ColumnType, which Kysely does not unwrap, so the SELECT type
      // is the wrapper rather than the `Date` the driver actually returns.
      // The cast is to the real runtime shape; `outboxTokenExpired` still
      // handles a string defensively.
      const createdAt = row.created_at as unknown as Date;
      if (outboxTokenExpired(row.template_key, createdAt, now)) {
        await trx
          .updateTable("app_outbox")
          .set({
            status: "failed",
            // NOT incremented: no attempt was made against the provider.
            last_attempt_at: now,
            next_attempt_at: null,
            error: `token_expired: ${row.template_key} link expired before delivery`,
            delivery_payload: null,
          })
          .where("id", "=", row.id)
          .execute();
        return "expired" as const;
      }

      // The deliverable is the unredacted payload when the row carries one;
      // otherwise the stored columns ARE the message (#21).
      const message = parseOutboxDeliveryPayload(row.delivery_payload) ?? {
        subject: row.subject,
        html: row.body_html,
        text: row.body_text,
      };
      try {
        const delivered = await provider.deliver({
          to: row.to_email,
          from: row.from_email,
          subject: message.subject,
          html: message.html,
          text: message.text ?? undefined,
          // Stable per-row key → the provider dedupes a re-attempt of a send
          // that actually reached it before we recorded `sent` (#11).
          idempotencyKey: `outbox-${row.id}`,
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
            // Terminal: drop the unredacted copy (#21).
            delivery_payload: null,
          })
          .where("id", "=", row.id)
          .execute();
        return "sent" as const;
      } catch (err) {
        const reason = summarizeDeliveryError(err);
        // review #219: a permanent 4xx (invalid recipient, unverified sending
        // domain, revoked key) is terminal on the attempt that saw it — the
        // retry budget only exists for failures that can plausibly resolve
        // themselves. Retryable failures keep the backoff ladder.
        const terminal = attempts >= OUTBOX_MAX_ATTEMPTS || !isRetryableDeliveryError(err);
        await trx
          .updateTable("app_outbox")
          .set({
            status: terminal ? "failed" : "pending",
            attempts,
            last_attempt_at: now,
            next_attempt_at: terminal ? null : new Date(now.getTime() + backoffDelayMs(attempts)),
            error: reason,
            // A terminally failed row will never be delivered: drop the
            // unredacted copy; a retryable one keeps it for the next attempt.
            ...(terminal ? { delivery_payload: null } : {}),
          })
          .where("id", "=", row.id)
          .execute();
        return terminal ? ("failed" as const) : ("retried" as const);
      }
    });

    if (outcome === "empty") break;
    result.claimed++;
    if (outcome === "expired") {
      // An expired row is a failure too — it will never be delivered — so it
      // counts in both buckets (review #90).
      result.expired++;
      result.failed++;
    } else {
      result[outcome]++;
    }
  }

  if (result.failed > 0) {
    logServerError("email outbox: rows will never be delivered", {
      failedCount: result.failed,
      expiredCount: result.expired,
    });
  }
  return result;
}
