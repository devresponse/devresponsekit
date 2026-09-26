"use client";

import * as Sentry from "@sentry/nextjs";

/**
 * Client-side error capture helpers. No-ops when Sentry is disabled (no
 * DSN), so call sites stay unconditional.
 */

export interface ClientErrorContext {
  /** The failing response's `x-request-id` — ties the client error to
   *  the server audit row and any server-side Sentry event. */
  requestId?: string | null;
  /** The endpoint that failed (path only — never include a query string). */
  endpoint?: string;
  /** HTTP status, when the error came from a response. */
  status?: number;
}

function tagsFor(context?: ClientErrorContext): Record<string, string> {
  const tags: Record<string, string> = {};
  if (context?.requestId) tags.request_id = context.requestId;
  if (context?.endpoint) tags.endpoint = context.endpoint;
  if (typeof context?.status === "number") tags.http_status = String(context.status);
  return tags;
}

/**
 * Captures a client-side exception with correlation tags. Returns the
 * Sentry event id (usable as a user-facing "Support ID"), or `null` when
 * Sentry is disabled. `captureException` returns a fresh random id even then
 * (no client, or `enabled: false` without a DSN), and that id names no event
 * anywhere, so it is dropped here (F-110).
 */
export function captureClientError(error: unknown, context?: ClientErrorContext): string | null {
  const eventId = Sentry.captureException(error, { tags: tagsFor(context) });
  return Sentry.isEnabled() ? eventId || null : null;
}

/** Reads the correlation id off a Response (header is the source of truth). */
export function requestIdFromResponse(response: Response): string | null {
  return response.headers.get("x-request-id");
}
