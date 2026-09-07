import "server-only";
import { db } from "@/db/database";
import { getServerEnv } from "@/lib/env";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { getConfiguredEmailProvider, isRetryableDeliveryError } from "./providers.server";
import { backoffDelayMs, summarizeDeliveryError } from "./outbox-worker.server";
import { redactRenderedEmail } from "./outbox-secrets";
import { getDefaultEmailTemplate, renderEmailTemplate } from "./templates";

/**
 * Outbox-first email sender (specs.md §35).
 *
 * EVERY outbound email is inserted into `app_outbox` BEFORE any
 * delivery attempt, so the outbox is a complete record regardless of
 * provider configuration or delivery outcome:
 *
 *   - provider configured, delivery ok     → `sent` (+ provider id)
 *   - provider configured, transient error → `pending`, scheduled for retry
 *     (the outbox worker re-attempts with backoff; → `failed` after the
 *     attempt cap, see outbox-worker.server.ts)
 *   - provider configured, PERMANENT 4xx   → `failed` immediately — retrying
 *     an invalid recipient / unverified sending domain cannot help
 *     (review #219, and what makes `failed` reachable here — review #235)
 *   - no provider configured               → `logged` (recorded only)
 *
 * Delivery failures are recorded, never thrown: a password-reset
 * request must not 500 because a third-party API hiccuped — the inline
 * attempt is best-effort and the outbox worker (`pnpm outbox:drain`)
 * guarantees eventual delivery. Template resolution
 * prefers the editable `app_email_templates` row for the recipient's
 * locale, falls back to the `en` row, then to the code-level default
 * in `templates.ts`.
 */

export interface SendAppEmailInput {
  to: string;
  templateKey: string;
  variables: Record<string, string>;
  /** Recipient locale; resolved from the app user when omitted. */
  locale?: string;
  /** Better Auth user id the email concerns, recorded on the outbox row. */
  relatedBetterAuthUserId?: string;
  /**
   * Owning tenant for outbox visibility (ADR-0001). When omitted, it is
   * resolved from `relatedBetterAuthUserId`'s membership — a single
   * membership org is used; none or multiple memberships → null (the row is
   * then SUPERADMIN-only). Pass `null` explicitly to force a
   * platform/system (org-less) row regardless of the related user.
   */
  organizationId?: string | null;
}

export interface SendAppEmailResult {
  outboxId: string;
  /**
   * - `sent`    — the provider accepted it inline.
   * - `logged`  — no provider configured; recorded only.
   * - `pending` — the inline attempt failed TRANSIENTLY; queued for retry.
   * - `failed`  — the provider rejected it permanently (a non-retryable 4xx):
   *   terminal, no retry. Reachable since review #219 — before that the
   *   inline path could only ever return `pending`, which made this member
   *   (and the test route's `=== "failed"` branches) dead code (review #235).
   */
  status: "sent" | "failed" | "logged" | "pending";
}

/**
 * Bound on a rendered `Subject:` (review #79). RFC 5322 caps an unfolded
 * header line at 998 octets; a subject longer than that is a bug or an
 * attack, not a subject.
 */
const SUBJECT_MAX_LEN = 900;

/**
 * Makes a rendered value safe to hand to a mail header (review #79).
 *
 * Subjects interpolate ADMIN- and USER-controlled values — an organization
 * name, an inviter's display name, a recipient's own profile name — none of
 * which are constrained to a single line. A `\r\n` inside one is the classic
 * header-injection primitive: it terminates `Subject:` and lets the rest of
 * the value dictate its own headers (`Bcc:`, `Content-Type:`) or start the
 * body. Our two providers happen to encode the field (Resend takes JSON,
 * Mailgun form-encodes), so this is defence in depth today — and exactly the
 * kind of defence that must not depend on the transport a future provider
 * chooses. U+2028/U+2029 are included because they are line terminators to
 * some MIME encoders while `\p{Cc}` does not cover them.
 *
 * Same normalisation as `summarizeDeliveryError`: control characters become
 * spaces, runs of whitespace collapse, ends trim, length is capped.
 */
export function sanitizeHeaderValue(value: string): string {
  const oneLine = value
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > SUBJECT_MAX_LEN ? `${oneLine.slice(0, SUBJECT_MAX_LEN)}…` : oneLine;
}

interface ResolvedTemplate {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}

async function resolveTemplate(templateKey: string, locale: string): Promise<ResolvedTemplate> {
  const rows = await db
    .selectFrom("app_email_templates")
    .select(["locale", "subject", "body_html", "body_text"])
    .where("key", "=", templateKey)
    .where("locale", "in", locale === defaultLocale ? [defaultLocale] : [locale, defaultLocale])
    .execute();

  const row = rows.find((r) => r.locale === locale) ?? rows.find((r) => r.locale === defaultLocale);
  if (row) {
    return { subject: row.subject, bodyHtml: row.body_html, bodyText: row.body_text };
  }

  // No DB row at all (key never seeded / both rows deleted) → the code-level
  // default, localized for the recipient when a translation exists.
  const fallback = getDefaultEmailTemplate(templateKey, locale);
  if (!fallback) {
    // Unknown key is a programmer error, not an operational condition.
    throw new Error(`Unknown email template key: ${templateKey}`);
  }
  return { subject: fallback.subject, bodyHtml: fallback.bodyHtml, bodyText: fallback.bodyText };
}

/**
 * Resolve the owning tenant for an outbound email (ADR-0001). An explicit
 * `organizationId` (including `null`) always wins. Otherwise we attribute
 * the mail to the related user's org IFF it is unambiguous: exactly one
 * distinct membership org. Zero memberships, multiple orgs, or no related
 * user all yield `null` — an org-less row that only SUPERADMIN can read,
 * which fails safe (we never widen visibility on a guess).
 */
async function resolveOrganizationId(input: SendAppEmailInput): Promise<string | null> {
  if (input.organizationId !== undefined) return input.organizationId;
  if (!input.relatedBetterAuthUserId) return null;

  const rows = await db
    .selectFrom("app_organization_memberships")
    .select("organization_id")
    .where("app_user_id", "in", (eb) =>
      eb
        .selectFrom("app_users")
        .select("id")
        .where("better_auth_user_id", "=", input.relatedBetterAuthUserId!),
    )
    .execute();

  const orgIds = [...new Set(rows.map((r) => r.organization_id))];
  return orgIds.length === 1 ? orgIds[0]! : null;
}

async function resolveRecipientLocale(input: SendAppEmailInput): Promise<string> {
  if (input.locale && isSupportedLocale(input.locale)) return input.locale;
  if (input.relatedBetterAuthUserId) {
    const row = await db
      .selectFrom("app_users")
      .select(["preferred_locale"])
      .where("better_auth_user_id", "=", input.relatedBetterAuthUserId)
      .executeTakeFirst();
    if (row && isSupportedLocale(row.preferred_locale)) return row.preferred_locale;
  }
  return defaultLocale;
}

export async function sendAppEmail(input: SendAppEmailInput): Promise<SendAppEmailResult> {
  const env = getServerEnv();
  const locale = await resolveRecipientLocale(input);
  const organizationId = await resolveOrganizationId(input);
  const template = await resolveTemplate(input.templateKey, locale);

  // review #79: the address fields are header-bound too. Callers reach here
  // with a zod-validated address or a Better Auth `user.email`, so this is a
  // no-op for every real recipient — but "the caller validated it" is not a
  // property this module can check, and one unvalidated caller would be a
  // header injection. Normalise here, once, for the row AND the delivery.
  const toEmail = sanitizeHeaderValue(input.to);
  const fromEmail = sanitizeHeaderValue(env.EMAIL_FROM);

  // The deliverable: what the provider receives. Kept in memory for the
  // inline attempt below; never stored in an admin-readable column.
  const rendered = {
    // review #79: the subject is the one rendered field that becomes a mail
    // HEADER, so it is normalised to a single line here — before it is stored
    // AND before it is handed to the provider, so the outbox row and the
    // delivered message always agree.
    subject: sanitizeHeaderValue(renderEmailTemplate(template.subject, input.variables, "text")),
    html: renderEmailTemplate(template.bodyHtml, input.variables, "html"),
    text: template.bodyText
      ? renderEmailTemplate(template.bodyText, input.variables, "text")
      : null,
  };
  // The record: the same message with any one-time token replaced by
  // `[redacted]` (review #21). Only when redaction actually changed something
  // is the unredacted rendering also written to `delivery_payload`, so the
  // retry worker (and, with no provider, a developer reading the DB) still
  // has the real link; that column is never selected by an admin route and
  // is nulled once the row is terminal.
  const redaction = redactRenderedEmail(rendered, input.variables);

  const provider = getConfiguredEmailProvider();

  const inserted = await db
    .insertInto("app_outbox")
    .values({
      organization_id: organizationId,
      template_key: input.templateKey,
      to_email: toEmail,
      from_email: fromEmail,
      subject: redaction.stored.subject,
      body_html: redaction.stored.html,
      body_text: redaction.stored.text,
      // Recorded for debugging (redacted like the bodies).
      variables: JSON.stringify(redaction.variables),
      delivery_payload: redaction.redacted ? JSON.stringify(rendered) : null,
      status: provider ? "pending" : "logged",
      provider: provider?.id ?? null,
      related_better_auth_user_id: input.relatedBetterAuthUserId ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  if (!provider) {
    return { outboxId: inserted.id, status: "logged" };
  }

  try {
    const result = await provider.deliver({
      to: toEmail,
      from: fromEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text ?? undefined,
      // Same key as the worker's retries (the outbox row id), so a retry after
      // this inline send crashed post-delivery is deduped provider-side (#11).
      idempotencyKey: `outbox-${inserted.id}`,
    });
    const now = new Date();
    await db
      .updateTable("app_outbox")
      .set({
        status: "sent",
        provider_message_id: result.providerMessageId ?? null,
        attempts: 1,
        last_attempt_at: now,
        next_attempt_at: null,
        sent_at: now,
        // Delivered: the unredacted copy has served its purpose (#21).
        delivery_payload: null,
      })
      .where("id", "=", inserted.id)
      .execute();
    return { outboxId: inserted.id, status: "sent" };
  } catch (err) {
    // Attempt #1 failed. A TRANSIENT failure leaves the row RETRYABLE (still
    // `pending`, scheduled for the next attempt) — the outbox worker
    // re-attempts with backoff until it succeeds or hits the cap. A PERMANENT
    // provider rejection (non-retryable 4xx: invalid recipient, unverified
    // sending domain, revoked key) is terminal right here (review #219):
    // four more identical requests over the following days cannot change the
    // answer, and a `failed` row surfaces the misconfiguration in the admin
    // Email workspace instead of hiding it behind `pending`. This is also
    // what makes `status: "failed"` reachable at all (review #235).
    const terminal = !isRetryableDeliveryError(err);
    const now = new Date();
    await db
      .updateTable("app_outbox")
      .set({
        ...(terminal ? { status: "failed" as const } : {}),
        attempts: 1,
        last_attempt_at: now,
        next_attempt_at: terminal ? null : new Date(now.getTime() + backoffDelayMs(1)),
        // Short, sanitized reason — never the provider's raw response body
        // (P3-8); `app_outbox.error` is surfaced in the admin Email workspace.
        error: summarizeDeliveryError(err),
        // Terminal: nothing will ever deliver this row, so the unredacted
        // copy must not outlive it (#21).
        ...(terminal ? { delivery_payload: null } : {}),
      })
      .where("id", "=", inserted.id)
      .execute();
    return { outboxId: inserted.id, status: terminal ? "failed" : "pending" };
  }
}
