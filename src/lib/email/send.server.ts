import "server-only";
import { db } from "@/db/database";
import { getServerEnv } from "@/lib/env";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { getConfiguredEmailProvider } from "./providers.server";
import { getDefaultEmailTemplate, renderEmailTemplate } from "./templates";

/**
 * Outbox-first email sender (specs.md §35).
 *
 * EVERY outbound email is inserted into `app_outbox` BEFORE any
 * delivery attempt, so the outbox is a complete record regardless of
 * provider configuration or delivery outcome:
 *
 *   - provider configured, delivery ok     → `sent` (+ provider id)
 *   - provider configured, delivery threw  → `failed` (+ error)
 *   - no provider configured               → `logged` (recorded only)
 *
 * Delivery failures are recorded, never thrown: a password-reset
 * request must not 500 because a third-party API hiccuped — operators
 * watch the outbox (and audit log) instead. Template resolution
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
}

export interface SendAppEmailResult {
  outboxId: string;
  status: "sent" | "failed" | "logged";
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

  const fallback = getDefaultEmailTemplate(templateKey);
  if (!fallback) {
    // Unknown key is a programmer error, not an operational condition.
    throw new Error(`Unknown email template key: ${templateKey}`);
  }
  return { subject: fallback.subject, bodyHtml: fallback.bodyHtml, bodyText: fallback.bodyText };
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
    await db
      .updateTable("app_outbox")
      .set({
        status: "sent",
        provider_message_id: result.providerMessageId ?? null,
        sent_at: new Date(),
      })
      .where("id", "=", inserted.id)
      .execute();
    return { outboxId: inserted.id, status: "sent" };
  } catch (err) {
    await db
      .updateTable("app_outbox")
      .set({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .where("id", "=", inserted.id)
      .execute();
    return { outboxId: inserted.id, status: "failed" };
  }
}
