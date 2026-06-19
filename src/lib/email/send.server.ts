import "server-only";
import { db } from "@/db/database";
import { getServerEnv } from "@/lib/env";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { getConfiguredEmailProvider } from "./providers.server";
import { backoffDelayMs, summarizeDeliveryError } from "./outbox-worker.server";
import { getDefaultEmailTemplate, renderEmailTemplate } from "./templates";

/**
 * Outbox-first email sender (specs.md §35).
 *
 * EVERY outbound email is inserted into `app_outbox` BEFORE any
 * delivery attempt, so the outbox is a complete record regardless of
 * provider configuration or delivery outcome:
 *
 *   - provider configured, delivery ok     → `sent` (+ provider id)
 *   - provider configured, delivery threw  → `pending`, scheduled for retry
 *     (the outbox worker re-attempts with backoff; → `failed` only after the
 *     attempt cap, see outbox-worker.server.ts)
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
  /** `pending` = the inline attempt failed but the row is queued for retry. */
  status: "sent" | "failed" | "logged" | "pending";
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

  const subject = renderEmailTemplate(template.subject, input.variables, "text");
  const bodyHtml = renderEmailTemplate(template.bodyHtml, input.variables, "html");
  const bodyText = template.bodyText
    ? renderEmailTemplate(template.bodyText, input.variables, "text")
    : null;

  const provider = getConfiguredEmailProvider();

  const inserted = await db
    .insertInto("app_outbox")
    .values({
      organization_id: organizationId,
      template_key: input.templateKey,
      to_email: input.to,
      from_email: env.EMAIL_FROM,
      subject,
      body_html: bodyHtml,
      body_text: bodyText,
      // Recorded for debugging/re-render; reset URLs embed one-time
      // tokens which are consumed on use, the same trade-off as any
      // provider dashboard or mail spool.
      variables: JSON.stringify(input.variables),
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
      to: input.to,
      from: env.EMAIL_FROM,
      subject,
      html: bodyHtml,
      text: bodyText ?? undefined,
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
      })
      .where("id", "=", inserted.id)
      .execute();
    return { outboxId: inserted.id, status: "sent" };
  } catch (err) {
    // Attempt #1 failed. Leave the row RETRYABLE (still `pending`, scheduled
    // for the next attempt) rather than terminally `failed` — the outbox
    // worker re-attempts with backoff until it succeeds or hits the cap.
    const now = new Date();
    await db
      .updateTable("app_outbox")
      .set({
        attempts: 1,
        last_attempt_at: now,
        next_attempt_at: new Date(now.getTime() + backoffDelayMs(1)),
        // Short, sanitized reason — never the provider's raw response body
        // (P3-8); `app_outbox.error` is surfaced in the admin Email workspace.
        error: summarizeDeliveryError(err),
      })
      .where("id", "=", inserted.id)
      .execute();
    return { outboxId: inserted.id, status: "pending" };
  }
}
