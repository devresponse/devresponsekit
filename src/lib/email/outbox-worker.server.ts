import "server-only";
import { sql, type Transaction } from "kysely";
import { db } from "@/db/database";
import type { AppDatabase } from "@/db/schema/app-schema";
import { hashSecret } from "@/lib/api-auth/api-key";
import { logServerError } from "@/lib/observability/logger.server";
import {
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  INVITATION_TTL_MS,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from "@/lib/token-ttls";
import { getConfiguredEmailProvider, isRetryableDeliveryError } from "./providers.server";
import { recordOutboxDelivery, type OutboxDeliveryRecord } from "./delivery-telemetry.server";
import { findQueryTokens, parseOutboxDeliveryPayload, type RenderedEmail } from "./outbox-secrets";

/**
 * Outbox retry worker (review D1).
 *
 * `sendAppEmail` records every email in `app_outbox` and attempts delivery
 * inline, retrying a transient failure a bounded number of times (F-99). A
 * transient failure that outlasts those leaves the row RETRYABLE
 * (`status='pending'` with a future `next_attempt_at`); this worker re-attempts
 * those rows on a schedule until they succeed or exhaust {@link OUTBOX_MAX_ATTEMPTS}.
 * While the inline send is still at work, the row's `next_attempt_at` is a
 * short lease in the future, so no drain claims it mid-delivery (F-101).
 *
 * Four ways a row stops short of that budget:
 *   - the provider rejected it PERMANENTLY (a non-retryable 4xx) → terminal on
 *     the attempt that saw it (review #219)
 *   - the one-time token it carries has already expired → terminal WITHOUT a
 *     delivery attempt, so nobody receives a dead link (review #90)
 *   - it is an invitation whose invitation was revoked, resent, accepted or
 *     deleted since, or whose email carries no accept link → terminal WITHOUT
 *     a delivery attempt (F-100)
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
 * F-103: the values come from `src/lib/token-ttls.ts`, the constants the
 * minting side reads too: `auth.ts` hands the reset and verification TTLs to
 * Better Auth (`resetPasswordTokenExpiresIn` / `emailVerification.expiresIn`)
 * and `invitations.server.ts` stamps `expires_at` with the invitation one.
 * They used to be copied here, kept in step by a comment.
 */
export const TOKEN_TTL_MS_BY_TEMPLATE: Readonly<Record<string, number>> = {
  password_reset: PASSWORD_RESET_TOKEN_TTL_MS,
  email_verification: EMAIL_VERIFICATION_TOKEN_TTL_MS,
  organization_invitation: INVITATION_TTL_MS,
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

/**
 * F-100: whether the accept link in an `organization_invitation` row still
 * opens a PENDING invitation, checked just before the drain delivers it.
 *
 * The row is queued when the invitation is created or resent, and nothing tied
 * it to the invitation afterwards. So a row whose inline send failed
 * transiently was still delivered by the next drain after the admin had
 * revoked the invitation (telling an address the admin withdrew about the org
 * and the inviter), after a resend had rotated the token (the stale mail then
 * landed after the fresh one and looked like the newest link) or after the org
 * was deleted, which cascades the invitation away. Asking the invitation table
 * at send time covers each of those, and any later way an invitation dies,
 * without a link column on `app_outbox`: the unredacted payload holds the
 * token, and the table stores its hash (`invitations.server.ts` hashes with
 * the same `hashSecret`).
 *
 * The link is found as the redaction rule finds it (`findQueryTokens`). Any
 * one of the tokens opening a pending invitation is enough (`live`), since
 * only an invitation token can; none doing so is `dead`. An email that
 * carries no token at all (a template edited to drop `{{acceptUrl}}`) is
 * `missing`: it cannot be accepted, but nothing withdrew it either, so the
 * caller fails it as a broken email rather than a superseded one. An
 * invitation's `expires_at` is left to the TTL rule above it, and a suspended
 * org's still-pending invitation is delivered as before (F-09 keeps those
 * rows for a reactivation).
 */
async function invitationLinkState(
  trx: Transaction<AppDatabase>,
  message: RenderedEmail,
): Promise<"live" | "dead" | "missing"> {
  const tokens = new Set([
    ...findQueryTokens(message.html),
    ...findQueryTokens(message.text ?? ""),
  ]);
  if (tokens.size === 0) return "missing";
  const hashes = await Promise.all([...tokens].map((token) => hashSecret(token)));
  const live = await trx
    .selectFrom("app_organization_invitations")
    .select("id")
    .where("token_hash", "in", hashes)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return live === undefined ? "dead" : "live";
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
  /**
   * Invitation rows failed WITHOUT a delivery attempt because their
   * invitation was revoked, resent, accepted or deleted since they were
   * queued (F-100). Not counted in `failed`: the mail was withdrawn, nobody is
   * waiting for it, so it is no alarm. The row itself is `failed`, the only
   * terminal state short of `sent` that `app_outbox` allows.
   */
  superseded: number;
}

/** One claimed row's result: its bucket in {@link DrainOutboxResult}, and what to report (F-27). */
interface DrainStep {
  outcome: "sent" | "retried" | "failed" | "expired" | "superseded";
  delivery: OutboxDeliveryRecord;
}

/**
 * Process up to `limit` due rows (`status='pending'` AND `next_attempt_at`
 * null-or-past) for the CURRENTLY configured provider. Returns a per-outcome
 * summary. A no-op (and no DB work) when no email provider is configured.
 */
export async function drainOutbox(limit = 50): Promise<DrainOutboxResult> {
  const provider = getConfiguredEmailProvider();
  const result: DrainOutboxResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    expired: 0,
    superseded: 0,
  };
  if (!provider) return result;

  for (let i = 0; i < limit; i++) {
    const step = await db.transaction().execute(async (trx): Promise<DrainStep | null> => {
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
        // Due: `next_attempt_at` past, or null. A row the inline send is still
        // delivering holds a lease in the future (F-101), so it is not due;
        // null is left only by rows written before that lease existed.
        .where((eb) =>
          eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", new Date())]),
        )
        .orderBy(sql`next_attempt_at asc nulls first`)
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;

      const attempts = row.attempts + 1;
      const now = new Date();
      const delivery = {
        path: "worker",
        outboxId: row.id,
        templateKey: row.template_key,
        provider: provider.id,
      } as const;

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
        return {
          outcome: "expired",
          delivery: { ...delivery, outcome: "expired", attempts: row.attempts },
        };
      }

      // The deliverable is the unredacted payload when the row carries one;
      // otherwise the stored columns ARE the message (#21).
      const message = parseOutboxDeliveryPayload(row.delivery_payload) ?? {
        subject: row.subject,
        html: row.body_html,
        text: row.body_text,
      };

      // F-100: an invitation email is delivered only while its link still
      // opens a pending invitation (see `invitationLinkState`). Otherwise the
      // row ends here like an expired one: no attempt, and the unredacted
      // payload dropped (#21). A dead link was withdrawn (`superseded`, no
      // alarm); an email with no link at all is broken, so it is a logged
      // `failed` with its own reason.
      const link =
        row.template_key === "organization_invitation"
          ? await invitationLinkState(trx, message)
          : "live";
      if (link !== "live") {
        const missing = link === "missing";
        await trx
          .updateTable("app_outbox")
          .set({
            status: "failed",
            // NOT incremented: no attempt was made against the provider.
            last_attempt_at: now,
            next_attempt_at: null,
            error: missing
              ? "invitation_link_missing: the email carries no accept link"
              : "invitation_superseded: the invitation was revoked, resent, accepted or deleted before delivery",
            delivery_payload: null,
          })
          .where("id", "=", row.id)
          .execute();
        return missing
          ? {
              outcome: "failed",
              delivery: {
                ...delivery,
                outcome: "failed",
                attempts: row.attempts,
                reason: "invitation_link_missing",
              },
            }
          : {
              outcome: "superseded",
              delivery: { ...delivery, outcome: "superseded", attempts: row.attempts },
            };
      }

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
        return { outcome: "sent", delivery: { ...delivery, outcome: "sent", attempts } };
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
        return {
          outcome: terminal ? "failed" : "retried",
          delivery: { ...delivery, outcome: terminal ? "failed" : "retry", attempts, error: err },
        };
      }
    });

    if (step === null) break;
    // F-27: reported only once the claim transaction has COMMITTED, so an
    // outcome whose row write rolled back is neither counted nor logged (the
    // row is still `pending` and will be claimed again).
    recordOutboxDelivery(step.delivery);
    const { outcome } = step;
    result.claimed++;
    if (outcome === "expired") {
      // An expired row is a failure too — it will never be delivered — so it
      // counts in both buckets (review #90).
      result.expired++;
      result.failed++;
    } else {
      // A `superseded` row counts in its own bucket only (F-100).
      result[outcome]++;
    }
  }

  // The per-drain summary. Each of these rows already has its own
  // `email_delivery` line with the template, provider and status (F-27).
  if (result.failed > 0) {
    logServerError("email outbox: rows will never be delivered", {
      failedCount: result.failed,
      expiredCount: result.expired,
    });
  }
  return result;
}
