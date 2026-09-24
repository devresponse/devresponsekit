import "server-only";
import { after } from "next/server";
import { logServerError } from "@/lib/observability/logger.server";
import { sendAppEmail, type SendAppEmailInput } from "./send.server";

/**
 * Sends an app email AFTER the response has gone out (F-20).
 *
 * `/request-password-reset`, `/send-verification-email` and `/sign-up/email`
 * give the same answer whether or not an account exists for the address, but
 * only an existing account gets an email. While the Better Auth callbacks in
 * `src/lib/auth.ts` awaited `sendAppEmail`, that email work was on the request
 * path: three lookups (locale, organization, template), the outbox INSERT and
 * the provider's HTTP call. It took 200-800 ms against a live provider, and
 * that difference in response time told an attacker which addresses have
 * accounts, well within the per-IP budget.
 *
 * This helper schedules the whole `sendAppEmail` call with Next's `after()`,
 * which runs it once the response has been sent. On Vercel `after()` is backed
 * by `waitUntil`, so the function stays alive until the send settles. The
 * outbox row is written after the response too. Keeping only the INSERT
 * inline would still leave four database round trips that happen only for a
 * real account. What changes is that the row appears a few milliseconds after
 * the response instead of before it. Delivery was already best-effort, and the
 * outbox worker still retries a `pending` row (specs.md §35).
 *
 * Outside a Next request scope (seeds, scripts, a test calling `auth.api.*`
 * directly), `after()` throws synchronously. The send then starts immediately
 * and is not awaited, so a caller's result still never depends on it.
 *
 * Either way a failure is logged with the app logger and never rethrown: it
 * must not become an unhandled rejection, and nobody on the response path is
 * left to receive it. The log line carries the template key and the related
 * user id, never the variables, which hold the one-time link.
 */
export function deferEmailSend(input: SendAppEmailInput): void {
  const send = async (): Promise<void> => {
    try {
      await sendAppEmail(input);
    } catch (error) {
      logServerError("deferred email send failed", {
        err: error,
        templateKey: input.templateKey,
        betterAuthUserId: input.relatedBetterAuthUserId ?? null,
      });
    }
  };
  try {
    after(send);
  } catch {
    // No request scope to defer into. Start now, without awaiting. `send`
    // never rejects, so dropping the promise cannot leak a rejection.
    void send();
  }
}
