import "server-only";
import * as Sentry from "@sentry/nextjs";

/**
 * Server-side error capture helper — the server mirror of
 * `captureClientError` in `./client.ts`. No-op when Sentry is disabled (no
 * DSN), so call sites stay unconditional.
 *
 * This exists for the "swallow-then-audit" 5xx paths (D4): a route that
 * catches an unexpected error, writes an audit row, and returns a 5xx
 * envelope never throws — so Next's `onRequestError` hook (wired in
 * `instrumentation.ts`) never fires for it, and the exception would reach the
 * structured log but never Sentry. The error-response helpers
 * (`adminErrorResponse` / `problemResponse`) call this when they emit a 5xx
 * with a `cause`, tagging the event with the same `request_id` that ties it to
 * the audit row and the user-facing "Support ID".
 */

export interface ServerErrorContext {
  /** Correlation id shared with the audit row and the `x-request-id` header. */
  requestId?: string | null;
  /** HTTP status being returned (tagged as `http_status`). */
  status?: number;
  /** The route path (no query string), when known. */
  endpoint?: string;
}

function tagsFor(context?: ServerErrorContext): Record<string, string> {
  const tags: Record<string, string> = {};
  if (context?.requestId) tags.request_id = context.requestId;
  if (context?.endpoint) tags.endpoint = context.endpoint;
  if (typeof context?.status === "number") tags.http_status = String(context.status);
  return tags;
}

/**
 * Captures a server-side exception with correlation tags. Returns the Sentry
 * event id, or `null` when Sentry is disabled or capture failed.
 */
export function captureServerError(error: unknown, context?: ServerErrorContext): string | null {
  return Sentry.captureException(error, { tags: tagsFor(context) }) || null;
}
