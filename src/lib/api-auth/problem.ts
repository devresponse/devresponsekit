/**
 * RFC 7807 `application/problem+json` responses for the `/api/v1` surface
 * (design docs/design-api-keys-and-tokens.md §8.1).
 *
 * The administrator surface uses its own `{ error, message, requestId }`
 * envelope (`adminErrorResponse`); the versioned REST surface instead
 * speaks the IETF standard so generic API clients and codegen tools get
 * a predictable error shape. This helper maps an internal machine code to
 * a problem document while preserving the `code` + `requestId`
 * correlation fields callers already rely on.
 */
import { NextResponse } from "next/server";
import { REQUEST_ID_HEADER, getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { captureServerError } from "@/lib/observability/server";
import { logServerError } from "@/lib/observability/logger.server";

export interface ProblemOptions {
  /** Human-readable detail (non-secret). Falls back to a generic line. */
  detail?: string;
  /** Extra non-secret members merged into the problem document. */
  extra?: Record<string, unknown>;
  /** Pre-computed correlation id. */
  requestId?: string;
  /** Additional response headers (e.g. Retry-After, WWW-Authenticate). */
  headers?: Record<string, string>;
  /**
   * The originating exception, for a 5xx. Captured to Sentry (tagged with
   * `request_id`) when `status >= 500`, so a swallowed-then-returned server
   * error still reaches observability (D4). Ignored for 4xx.
   */
  cause?: unknown;
}

/** Stable titles per machine code. Keep snake_case codes for the body. */
const TITLES: Record<string, string> = {
  unauthorized: "Authentication required",
  forbidden: "Insufficient scope or permission",
  not_found: "Resource not found",
  invalid_request: "Invalid request",
  conflict: "Conflict",
  rate_limited: "Too many requests",
  precondition_failed: "Precondition failed",
  unsupported_grant_type: "Unsupported grant type",
  invalid_client: "Invalid client",
  invalid_scope: "Invalid scope",
  internal_error: "Internal server error",
};

/**
 * Builds a problem+json `NextResponse`.
 *
 *   - `type`     — a stable URN per code (clients can switch on it).
 *   - `title`    — short human summary.
 *   - `status`   — mirrors the HTTP status.
 *   - `code`     — the internal machine code (snake_case).
 *   - `requestId`— correlates with `x-request-id` and audit rows.
 *
 * Backend exception text is NEVER placed in `detail`.
 */
export function problemResponse(
  code: string,
  status: number,
  request: { headers: Headers } | Headers | undefined,
  options: ProblemOptions = {},
): NextResponse {
  const requestId = options.requestId ?? getOrCreateRequestId(request);
  if (status >= 500) {
    // OPS-OBS-2: every v1 5xx must reach the always-on stdout stream, not just
    // Sentry — a default (no-DSN) deploy would otherwise be blind to its own
    // 500s. Sentry capture stays gated on a cause (matches D4); the structured
    // log fires for all 5xx and serializes the cause when present.
    if (options.cause !== undefined) {
      captureServerError(options.cause, { requestId, status });
    }
    logServerError(`v1.${code}`, { requestId, status, code, err: options.cause });
  }
  const body = {
    type: `https://devresponse.com/problems/${code}`,
    title: TITLES[code] ?? "Error",
    status,
    code,
    detail: options.detail,
    requestId,
    ...(options.extra ?? {}),
  };
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/problem+json",
      [REQUEST_ID_HEADER]: requestId,
      ...(options.headers ?? {}),
    },
  });
}

/** Success JSON response that still echoes the request-id header. */
export function v1JsonResponse<T>(
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
