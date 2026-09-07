import "server-only";
import { getServerEnv } from "@/lib/env";

/**
 * Third-party email delivery providers (specs.md §35).
 *
 * Each provider is a thin `fetch` wrapper around the vendor's REST API —
 * no SDK dependencies. Selection is env-driven (`EMAIL_PROVIDER`);
 * with no provider configured `getConfiguredEmailProvider()` returns
 * `null` and the sender records outbox rows as `logged` without
 * attempting delivery.
 *
 * Adding a provider = implement {@link EmailProvider}, add the env
 * wiring here and in `env.ts`, and extend the `EMAIL_PROVIDER` enum.
 */

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * Stable per-email key (the outbox row id) used to make delivery
   * effectively-once despite the at-least-once outbox (audit #11). The
   * provider call runs INSIDE the worker's `FOR UPDATE SKIP LOCKED` claim
   * transaction (so the row lock is held for the duration of the call), but a
   * crash after a successful send and before the `sent` UPDATE commits rolls
   * the claim back and re-attempts the SAME row — this key lets the provider
   * dedupe that retry (review #93). Resend honors it natively via
   * `Idempotency-Key`; Mailgun has no idempotency API, so it only rides as a
   * stable `Message-Id` (best-effort — Mailgun stays at-least-once).
   */
  idempotencyKey?: string;
}

export interface EmailDeliveryResult {
  providerMessageId?: string;
}

export interface EmailProvider {
  readonly id: "resend" | "mailgun";
  deliver(email: OutboundEmail): Promise<EmailDeliveryResult>;
}

/**
 * Per-call timeout for a provider HTTP request. `sendAppEmail` runs inline on
 * the request path (e.g. the password-reset flow), so without an abort a hung
 * provider connection would hold the request open until the platform's own
 * timeout. `AbortSignal.timeout` rejects the fetch; the caller leaves the
 * outbox row `pending` with a backoff `next_attempt_at`, and `drainOutbox`
 * (outbox-worker.server.ts) re-attempts it — a TIMED-OUT row becomes
 * terminally `failed` only after OUTBOX_MAX_ATTEMPTS (review #82); a row the
 * provider rejected permanently fails on attempt 1 ({@link EmailDeliveryError},
 * review #219).
 */
const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * A provider rejection carrying its HTTP status and a retry verdict
 * (review #219).
 *
 * Before this, EVERY delivery failure was retried up to
 * `OUTBOX_MAX_ATTEMPTS` — and because the outbox drain runs on a DAILY cron
 * (`vercel.json`), a permanent rejection like "422 invalid recipient" or
 * "403 domain not verified" burned four more days of attempts against an
 * answer that will never change, kept the (unredacted) `delivery_payload`
 * alive for that whole window, and hid a real configuration error behind a
 * row that still read `pending`.
 */
export class EmailDeliveryError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(provider: string, status: number, body: string) {
    super(`${provider} ${status}: ${body}`);
    this.name = "EmailDeliveryError";
    this.provider = provider;
    this.status = status;
    this.retryable = isRetryableDeliveryStatus(status);
  }
}

/**
 * Whether an HTTP status from a provider is worth re-attempting.
 *
 * Retryable — the same request may succeed later:
 *   - 5xx (provider fault), 408 request timeout, 425 too early
 *   - 409 conflict (both Resend and Mailgun use it for transient
 *     idempotency-key races)
 *   - 429 rate limited
 *
 * Terminal — everything else in the 4xx range. A malformed payload (400/422),
 * a bad or revoked API key (401), an unverified sending domain or suppressed
 * recipient (403), a wrong endpoint/domain (404), a body over the provider's
 * cap (413) and an unsupported media type (415) all describe a request that
 * is wrong, not a provider that is busy: re-sending it byte-for-byte four
 * more times cannot change the answer. Statuses below 400 never reach here
 * (`res.ok` covers 2xx; a redirect is followed by `fetch`), and an unknown
 * status is treated as retryable so a novel provider response fails safe
 * toward delivery rather than toward dropping mail.
 */
export function isRetryableDeliveryStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return !(status >= 400 && status < 500);
}

/**
 * Whether a thrown delivery error should be re-attempted. Anything that is
 * not a classified {@link EmailDeliveryError} — a network reset, a DNS
 * failure, the `AbortSignal.timeout` above, a JSON parse error — is transient
 * by nature and stays retryable (review #219).
 */
export function isRetryableDeliveryError(err: unknown): boolean {
  return err instanceof EmailDeliveryError ? err.retryable : true;
}

/** https://resend.com/docs/api-reference/emails/send-email */
function createResendProvider(apiKey: string): EmailProvider {
  return {
    id: "resend",
    async deliver(email) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          // Effectively-once delivery: Resend dedupes retries carrying the same
          // key within a 24h window (audit #11).
          ...(email.idempotencyKey ? { "Idempotency-Key": email.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          ...(email.text ? { text: email.text } : {}),
        }),
      });
      if (!res.ok) {
        throw new EmailDeliveryError("resend", res.status, truncateBody(await res.text()));
      }
      const body = (await res.json()) as { id?: string };
      return { providerMessageId: body.id };
    },
  };
}

/** https://documentation.mailgun.com/docs/mailgun/api-reference/send/ */
function createMailgunProvider(apiKey: string, domain: string, baseUrl: string): EmailProvider {
  return {
    id: "mailgun",
    async deliver(email) {
      const form = new URLSearchParams();
      form.set("from", email.from);
      form.set("to", email.to);
      form.set("subject", email.subject);
      form.set("html", email.html);
      if (email.text) form.set("text", email.text);
      // Mailgun has no idempotency-key API. Ride the stable key as a fixed
      // Message-Id so a re-sent duplicate at least shares an id downstream
      // (best-effort; Mailgun delivery stays at-least-once — audit #11).
      if (email.idempotencyKey) form.set("h:Message-Id", `<${email.idempotencyKey}@${domain}>`);

      const res = await fetch(`${baseUrl}/v3/${domain}/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      if (!res.ok) {
        throw new EmailDeliveryError("mailgun", res.status, truncateBody(await res.text()));
      }
      const body = (await res.json()) as { id?: string };
      return { providerMessageId: body.id };
    },
  };
}

/** Error bodies go into `app_outbox.error` — keep them bounded. */
function truncateBody(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}…` : body;
}

/**
 * Resolves the configured provider, or `null` when delivery is not
 * configured (env validation already guarantees the credentials exist
 * when `EMAIL_PROVIDER` is set).
 */
export function getConfiguredEmailProvider(): EmailProvider | null {
  const env = getServerEnv();
  if (env.EMAIL_PROVIDER === "resend") {
    return createResendProvider(env.RESEND_API_KEY ?? "");
  }
  if (env.EMAIL_PROVIDER === "mailgun") {
    return createMailgunProvider(
      env.MAILGUN_API_KEY ?? "",
      env.MAILGUN_DOMAIN ?? "",
      env.MAILGUN_BASE_URL,
    );
  }
  return null;
}
