import "server-only";
import { NextResponse } from "next/server";
import { REQUEST_ID_HEADER, getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { captureServerError } from "@/lib/observability/server";

/**
 * Standard administrator error envelope (docs/admin-manager.md §5.1,
 * §12). Every admin route handler MUST return errors via this helper
 * so the wire contract is consistent and includes:
 *
 *   - `error`     — machine-readable code (snake_case).
 *   - `message`   — i18n key for the localized message
 *                   (`errors.<code>`). Frontend looks this up via
 *                   `useTranslations("errors")`.
 *   - `requestId` — UUID correlating with `x-request-id` and audit rows.
 *
 * The response also sets the `x-request-id` header so logging
 * middleware / proxies can read it without parsing the body.
 *
 * Threat / contract:
 *   - Never include backend exception messages in `message`. The i18n
 *     key is the only user-visible text. Internal details belong in
 *     audit metadata (server-side only).
 *   - Pass the originating `request` so we honour an inbound
 *     `x-request-id`; pass `requestId` directly only when continuing a
 *     correlation (e.g. inside a streaming response).
 */
export interface AdminErrorOptions {
  /** Extra non-secret fields surfaced to the client (e.g. retryAfter). */
  extra?: Record<string, unknown>;
  /** Pre-computed request id when the caller already minted one. */
  requestId?: string;
  /** Additional response headers. */
  headers?: Record<string, string>;
  /**
   * The originating exception, for a 5xx. When set on a `status >= 500`
   * response it is captured to Sentry, tagged with `request_id` (D4) — so a
   * swallowed-then-audited server error still surfaces in observability.
   * Ignored for 4xx (those are expected client errors, not incidents).
   */
  cause?: unknown;
}

export function adminErrorResponse(
  code: string,
  status: number,
  request: { headers: Headers } | Headers | undefined,
  options: AdminErrorOptions = {},
): NextResponse {
  const requestId = options.requestId ?? getOrCreateRequestId(request);
  if (status >= 500 && options.cause !== undefined) {
    captureServerError(options.cause, { requestId, status });
  }
  const body = {
    error: code,
    message: `errors.${code}`,
    requestId,
    ...(options.extra ?? {}),
  };
  return NextResponse.json(body, {
    status,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...(options.headers ?? {}),
    },
  });
}

/**
 * Convenience for success responses that should still echo the request
 * id header for correlation. Body is unchanged.
 */
export function adminJsonResponse<T extends Record<string, unknown> | unknown[]>(
  body: T,
  request: { headers: Headers } | Headers | undefined,
  init: { status?: number; requestId?: string; headers?: Record<string, string> } = {},
): NextResponse {
  const requestId = init.requestId ?? getOrCreateRequestId(request);
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: {
      [REQUEST_ID_HEADER]: requestId,
      ...(init.headers ?? {}),
    },
  });
}
