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
   * effectively-once despite the at-least-once outbox (audit #11). The worker
   * holds no lock across the provider call, so a crash after a successful send
   * but before the row is marked `sent` re-attempts the SAME row — this key
   * lets the provider dedupe that retry. Resend honors it natively via
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
 * timeout. `AbortSignal.timeout` rejects the fetch, which the caller records as
 * a failed outbox row (and a future retry worker can re-attempt).
 */
const PROVIDER_TIMEOUT_MS = 10_000;

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
        throw new Error(`resend ${res.status}: ${truncateBody(await res.text())}`);
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
        throw new Error(`mailgun ${res.status}: ${truncateBody(await res.text())}`);
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
