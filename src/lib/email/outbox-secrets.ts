/**
 * Outbox secret redaction (review #21).
 *
 * Several outbound emails carry a live, single-use credential: Better Auth's
 * password-reset link (`/reset-password/<token>?callbackURL=…`), its
 * email-verification link (`/verify-email?token=…`), and the organization
 * invitation accept link (`/invite?token=…`). The outbox is an org-scoped
 * ADMIN surface (`admin.email.read`), so persisting those links verbatim in
 * `app_outbox.body_html` / `body_text` / `variables` let any org admin mint a
 * reset for a co-member (the public forgot-password endpoint needs no auth),
 * read the one-time URL from their outbox view and take over the account —
 * a second, unaudited path around the finer `admin.users.setPassword` grant.
 *
 * The fix is applied at INSERT time, in `sendAppEmail`: the columns the admin
 * API can ever read hold a REDACTED rendering (the secret path segment /
 * `token=` value replaced by {@link REDACTED_TOKEN}), while the real rendered
 * message is kept only where delivery needs it — in memory for the inline
 * attempt, and in `app_outbox.delivery_payload` for the retry worker. That
 * column is DB-only: no administrator route selects it, and the worker nulls
 * it the moment the row reaches a terminal `sent` / `failed` state, so a
 * live token is never kept at rest longer than a delivery can use it.
 *
 * This module is deliberately pure (no `server-only`, no DB) so the redaction
 * rules are unit-testable and reusable from scripts.
 */

/** Placeholder written in place of a secret in the stored copy. */
export const REDACTED_TOKEN = "[redacted]";

/**
 * `token=<value>` in a query string. Matches the raw (`&`) and the
 * HTML-escaped (`&amp;`) separator so a link inside an entity-escaped HTML
 * body is caught too; the value ends at the next separator / delimiter, which
 * also keeps `&amp;callbackURL=…` intact.
 */
const QUERY_TOKEN_RE = /((?:[?&]|&amp;)token=)[^&\s"'<>#]*/gi;

/**
 * Better Auth's reset link carries the token as a PATH segment:
 * `${baseURL}/reset-password/<token>?callbackURL=…`.
 */
const RESET_PATH_TOKEN_RE = /(\/reset-password\/)[^/?#\s"'<>]+/gi;

/**
 * Replaces every credential-bearing URL fragment in `text` with the
 * {@link REDACTED_TOKEN} placeholder. Idempotent; text without secrets is
 * returned unchanged.
 */
export function redactEmailSecrets(text: string): string {
  return text
    .replace(QUERY_TOKEN_RE, `$1${REDACTED_TOKEN}`)
    .replace(RESET_PATH_TOKEN_RE, `$1${REDACTED_TOKEN}`);
}

/** The exact message handed to a provider — subject + rendered bodies. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string | null;
}

export interface RedactedEmail {
  /** What `app_outbox.subject` / `body_html` / `body_text` store. */
  stored: RenderedEmail;
  /** What `app_outbox.variables` stores. */
  variables: Record<string, string>;
  /**
   * True when redaction changed something — i.e. the message carries a secret
   * and the unredacted rendering must be kept in `delivery_payload` for the
   * retry worker. False → the stored copy IS the deliverable, no payload.
   */
  redacted: boolean;
}

/**
 * Produces the admin-readable copy of a rendered email plus its variables.
 */
export function redactRenderedEmail(
  rendered: RenderedEmail,
  variables: Record<string, string>,
): RedactedEmail {
  const stored: RenderedEmail = {
    subject: redactEmailSecrets(rendered.subject),
    html: redactEmailSecrets(rendered.html),
    text: rendered.text === null ? null : redactEmailSecrets(rendered.text),
  };
  const storedVariables: Record<string, string> = {};
  let redacted =
    stored.subject !== rendered.subject ||
    stored.html !== rendered.html ||
    stored.text !== rendered.text;
  for (const [name, value] of Object.entries(variables)) {
    const safe = redactEmailSecrets(value);
    storedVariables[name] = safe;
    if (safe !== value) redacted = true;
  }
  return { stored, variables: storedVariables, redacted };
}

/**
 * Parses `app_outbox.delivery_payload` (jsonb, read back as an object by `pg`;
 * tolerated as a string for callers that hand the raw column through).
 * Returns null for an absent or malformed payload — the worker then falls back
 * to the stored (redacted) columns, which is the right thing for rows written
 * before this column existed (their stored body IS the deliverable).
 */
export function parseOutboxDeliveryPayload(raw: unknown): RenderedEmail | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const { subject, html, text } = value as Record<string, unknown>;
  if (typeof subject !== "string" || typeof html !== "string") return null;
  if (text !== null && text !== undefined && typeof text !== "string") return null;
  return { subject, html, text: typeof text === "string" ? text : null };
}
