import "server-only";
import { logServerError, logger } from "@/lib/observability/logger.server";
import { outboxDeliveryTotal } from "@/lib/observability/metrics.server";
import { EmailDeliveryError, isRetryableDeliveryError } from "./providers.server";
import { DEFAULT_EMAIL_TEMPLATES } from "./templates";

/**
 * The log line and counter for every email delivery outcome (F-27).
 *
 * `sendAppEmail` records a provider failure on the outbox row and RETURNS a
 * status instead of throwing, so a password-reset request never 500s on a
 * provider hiccup. The cost was that nothing else saw the failure: a sender
 * the provider refuses (an unset `EMAIL_FROM` left on its `@localhost`
 * default, a mistyped or unverified domain) failed every reset, verification
 * and invitation email on attempt 1, users were told to check their inbox,
 * and the only trace was a `failed` row in the admin Email workspace. The
 * drain worker logged a count of dead rows and nothing about why.
 *
 * Both writers of a delivery result, the inline attempt (which also serves
 * the admin test send) and the drain worker, call {@link recordOutboxDelivery}
 * once the row is written, so every outcome is counted in
 * `devresponsekit_outbox_delivery_total` and every failure is logged the same
 * way:
 *   - terminal (`failed`, `expired`) → `error`, through `logServerError`, so
 *     it reaches the same alerting as a 5xx;
 *   - transient (`retry`) → `warn`: the worker still owns the row;
 *   - `sent` / `logged` → the counter only. A `logged` count in production
 *     means `EMAIL_PROVIDER` is unset and nobody receives mail.
 *
 * The counter is per-process. The worker's increments reach `/api/metrics`
 * only when the drain runs in the server (the `/api/internal/outbox-drain`
 * cron route); a `pnpm outbox:drain` run is its own process, so there the
 * log lines and the script's summary line are the whole record. See
 * docs/observability.md §5.
 *
 * The line carries only values this code controls: the outbox id (the join
 * key to the row and its sanitized `error`), the template, the provider, the
 * attempt count, the provider's HTTP status, the error's class name and a
 * system error code. It never carries the recipient, the subject, a body, the
 * template variables (which hold the one-time link) or the provider's
 * response text, which is vendor-controlled and may echo request fields such
 * as the recipient. `app_outbox.error` keeps that text for the row.
 */

export type OutboxDeliveryOutcome = "sent" | "retry" | "failed" | "expired" | "logged";

export interface OutboxDeliveryRecord {
  outcome: OutboxDeliveryOutcome;
  /** `inline`: the attempt inside `sendAppEmail`. `worker`: `drainOutbox`. */
  path: "inline" | "worker";
  outboxId: string;
  templateKey: string | null;
  /** The provider the row was sent (or queued) through; `null` when none is configured. */
  provider: string | null;
  /** The row's `attempts` after this outcome (0 when nothing was attempted). */
  attempts: number;
  /** The thrown delivery error, for `retry` and a provider-driven `failed`. */
  error?: unknown;
}

/**
 * The built-in template keys, the only values the `template` label takes.
 * `sendAppEmail` is only called with these, but the worker reads the key back
 * from the database, so anything else is reported as `other` rather than
 * minting a new time series per stray string.
 */
const TEMPLATE_LABELS: ReadonlySet<string> = new Set(DEFAULT_EMAIL_TEMPLATES.map((t) => t.key));

export function outboxTemplateLabel(templateKey: string | null | undefined): string {
  return templateKey && TEMPLATE_LABELS.has(templateKey) ? templateKey : "other";
}

/** An identifier-shaped value, or nothing: these fields must never carry free text. */
function boundedIdentifier(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * The code-controlled facts about a delivery error: the provider's HTTP status
 * (an {@link EmailDeliveryError}), the error's class (`TimeoutError` for the
 * provider timeout, `TypeError` for a failed fetch) and a Node / undici error
 * code such as `ENOTFOUND` from the error or its `cause`. Never the message.
 */
function describeDeliveryError(error: unknown): Record<string, unknown> {
  const providerStatus = error instanceof EmailDeliveryError ? error.status : undefined;
  const errorName =
    error instanceof Error
      ? (boundedIdentifier(error.name, /^[A-Za-z0-9_]{1,64}$/) ?? "Error")
      : typeof error;
  const code = (value: unknown): string | undefined =>
    value && typeof value === "object"
      ? boundedIdentifier((value as { code?: unknown }).code, /^[A-Z0-9_]{1,40}$/)
      : undefined;
  const errorCode = code(error) ?? code((error as { cause?: unknown } | null)?.cause);
  return { providerStatus, errorName, errorCode };
}

/**
 * Why a row stopped: a code literal, so an alert can split "the provider
 * refuses our mail" (`provider_rejected`: fix the sender, the domain or the
 * key) from "the provider never answered" (`attempts_exhausted`) and from
 * "the cron drains slower than links expire" (`token_expired`).
 */
function reasonFor(record: OutboxDeliveryRecord): string | undefined {
  switch (record.outcome) {
    case "retry":
      return "transient";
    case "expired":
      return "token_expired";
    case "failed":
      return isRetryableDeliveryError(record.error) ? "attempts_exhausted" : "provider_rejected";
    default:
      return undefined;
  }
}

export function recordOutboxDelivery(record: OutboxDeliveryRecord): void {
  const template = outboxTemplateLabel(record.templateKey);
  outboxDeliveryTotal.inc({ outcome: record.outcome, template });
  if (record.outcome === "sent" || record.outcome === "logged") return;

  const fields = {
    kind: "email_delivery",
    outcome: record.outcome,
    reason: reasonFor(record),
    path: record.path,
    outboxId: record.outboxId,
    template,
    provider: record.provider,
    attempts: record.attempts,
    ...(record.error === undefined ? {} : describeDeliveryError(record.error)),
  };
  if (record.outcome === "retry") {
    logger.warn(fields, "email delivery failed, will retry");
  } else {
    logServerError("email will not be delivered", fields);
  }
}
