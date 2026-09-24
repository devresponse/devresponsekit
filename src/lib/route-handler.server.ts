import "server-only";
import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { REQUEST_ID_HEADER, getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { problemResponse } from "@/lib/api-auth/problem";

/**
 * The request-id chokepoint for route handlers (F-29).
 *
 * Every admin, first-party and `/api/v1` response is supposed to carry an
 * `x-request-id` that matches the audit rows its request wrote and the log line
 * of any error it raised (docs/observability.md §4). That used to be enforced
 * per call site: `adminErrorResponse`, `problemResponse` and the two JSON
 * helpers stamp the header, but most admin success paths return a bare
 * `NextResponse.json(...)`, and a handler that THROWS (the review counted 21
 * `throw err` rethrows across 15 admin route files, and any unexpected fault
 * lands the same way) produced Next's own empty 500: no header, no envelope,
 * and an `onRequestError` log line whose `requestId` was `undefined` unless the
 * client had sent one. An audit row written earlier in that request carried a
 * server-minted id that nothing else referenced.
 *
 * `withAdminRoute` / `withV1Route` wrap an exported handler and:
 *
 *   1. mint (or honour) the request id BEFORE the handler runs. The id is
 *      memoised on the request object and its `Headers`, so every
 *      `getOrCreateRequestId(request)` the handler makes — the permission
 *      guard's grant, `auditEvent`, the error helpers — reads this value;
 *   2. stamp `x-request-id` on whatever the handler returns, unless the
 *      handler already set it (it did so from the same memoised id);
 *   3. turn a throw into the surface's 500 envelope — `internal_error` in the
 *      admin `{ error, message, requestId }` shape or as RFC 7807
 *      problem+json — carrying the same id in the body and the header. The
 *      envelope helper logs it (`admin.internal_error` / `v1.internal_error`,
 *      OPS-OBS-2) and captures the cause to Sentry tagged `request_id` (D4).
 *
 * Next's own control-flow throws (`redirect()`, `notFound()`, dynamic-usage
 * bailouts) are re-thrown untouched via `unstable_rethrow`, so wrapping never
 * changes how the framework handles them.
 *
 * Why route wrappers and not the proxy: the proxy could forward a minted id on
 * the request and set it on the response, but (a) a thrown handler would still
 * answer Next's bodiless 500 rather than the documented envelope; (b) at a
 * `TRUSTED_PROXY_COUNT` above the chain length the handler re-validates the
 * forwarded id, rejects it and mints another, while the proxy's response header
 * wins (Next skips a handler header the proxy already set), so the header
 * would silently disagree with the audit rows; and (c) the merge of proxy
 * response headers onto a route response is platform behaviour (self-hosted
 * `next start` vs Vercel's routing middleware) that no test here can pin.
 *
 * Coverage is enforced by enumeration, not by memory:
 * `tests/unit/route-request-id-invariant.test.ts` walks every
 * `src/app/api/**` route file and fails on an exported handler that is not
 * wrapped with the wrapper for its surface, unless the file carries a
 * reasoned exemption there (the Better Auth catch-all, public cacheable
 * documents, probes and machine sinks).
 */

type RequestCarrier = { headers: Headers };

/**
 * The first handler argument, when it looks like a request. Next always passes
 * the `NextRequest`; tests pass `{ headers, nextUrl, json }` stand-ins, which
 * work identically because the memo is keyed on the object itself.
 */
function requestCarrier(value: unknown): RequestCarrier | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const headers = (value as { headers?: unknown }).headers;
  return typeof (headers as Headers | undefined)?.get === "function"
    ? (value as RequestCarrier)
    : undefined;
}

/**
 * Sets `x-request-id` on `response` unless it is already there.
 *
 * A header the handler set wins: it came from the same memoised id (the
 * envelope helpers and `guard.requestId` all read `getOrCreateRequestId`), and
 * it is the value the handler's audit rows carry. A `Response.redirect()` or a
 * proxied `fetch()` response has immutable headers, so it is copied instead.
 */
function stampRequestId<R extends Response>(response: R, requestId: string): R | NextResponse {
  if (response.headers.has(REQUEST_ID_HEADER)) return response;
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function wrapRoute<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
  renderThrow: (
    request: RequestCarrier | undefined,
    requestId: string,
    cause: unknown,
  ) => NextResponse,
): (...args: Args) => Promise<R | NextResponse> {
  return async (...args: Args): Promise<R | NextResponse> => {
    const request = requestCarrier(args[0]);
    const requestId = getOrCreateRequestId(request);
    let response: R;
    try {
      response = await handler(...args);
    } catch (err) {
      unstable_rethrow(err);
      return renderThrow(request, requestId, err);
    }
    return stampRequestId(response, requestId);
  };
}

/**
 * Wraps a handler on a surface that speaks the admin envelope: the
 * administrator console and the first-party JSON routes (`/api/account/*`,
 * `/api/preferences/*`, `/api/invitations/*`, `/api/navigation/*`, the SSO
 * launch/consume pair). A throw answers `500 internal_error`.
 */
export function withAdminRoute<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return wrapRoute(handler, (request, requestId, cause) =>
    adminErrorResponse("internal_error", 500, request, { requestId, cause }),
  );
}

/**
 * Wraps an `/api/v1` handler: a throw answers an RFC 7807 problem+json
 * `500 internal_error` (`problemResponse`, design §8.1).
 */
export function withV1Route<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return wrapRoute(handler, (request, requestId, cause) =>
    problemResponse("internal_error", 500, request, { requestId, cause }),
  );
}
