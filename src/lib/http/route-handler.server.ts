import "server-only";
import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";
import { adminErrorResponse } from "@/lib/http/errors.server";
import { InvalidListQueryError } from "@/lib/admin/list-query.server";
import { REQUEST_ID_HEADER, getOrCreateRequestId } from "@/lib/http/request-id.server";
import { problemResponse } from "@/lib/http/problem";
import { RPC_INTERNAL_ERROR, rpcError } from "@/lib/mcp/protocol";
import { logServerError } from "@/lib/observability/logger.server";
import { captureServerError } from "@/lib/observability/server";

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
 *      The one throw that is the CLIENT's fault, a list query `parseListQuery`
 *      refuses (`InvalidListQueryError`), answers the surface's 400 instead
 *      (F-63).
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
 *
 * A-12: the MCP transport and its RFC 7591 registration endpoint were exempt,
 * because a throw rendered in the admin or v1 envelope would put a
 * non-protocol body on the wire. They have wrappers of their own now
 * ({@link withMcpRoute}, {@link withClientRegistrationRoute}): the same id
 * handling, with the throw rendered in the protocol's error shape.
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
  renderInvalidQuery?: (
    request: RequestCarrier | undefined,
    requestId: string,
    detail: string,
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
      // F-63: `parseListQuery` refuses a page past MAX_PAGE or a malformed id
      // in a uuid filter by throwing, so every list route answers the same 400
      // here instead of each handling a parse result. It is a client error:
      // no log line, no Sentry event. A surface with no list routes (MCP)
      // passes no renderer, and such a throw there is a fault like any other.
      if (renderInvalidQuery && err instanceof InvalidListQueryError) {
        return renderInvalidQuery(request, requestId, err.detail);
      }
      return renderThrow(request, requestId, err);
    }
    return stampRequestId(response, requestId);
  };
}

/**
 * The bookkeeping `adminErrorResponse` / `problemResponse` do for a thrown
 * handler, for the two protocol surfaces that cannot use them (A-12): the
 * structured log line under the response's id (OPS-OBS-2) and the Sentry event
 * tagged with it (D4).
 */
function reportThrow(event: string, requestId: string, cause: unknown): void {
  captureServerError(cause, { requestId, status: 500 });
  logServerError(event, { requestId, status: 500, code: "internal_error", err: cause });
}

/** A protocol error body as the `application/json` 500 both MCP wrappers answer. */
function protocolJson500(body: unknown, requestId: string): NextResponse {
  return NextResponse.json(body, {
    status: 500,
    headers: { "cache-control": "no-store", [REQUEST_ID_HEADER]: requestId },
  });
}

/**
 * Wraps a handler on a surface that speaks the admin envelope: the
 * administrator console and the first-party JSON routes (`/api/account/*`,
 * `/api/preferences/*`, `/api/invitations/*`, `/api/navigation/*`, the SSO
 * launch/consume pair). A throw answers `500 internal_error`, and an
 * {@link InvalidListQueryError} `400 invalid_query` with its `detail`.
 */
export function withAdminRoute<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return wrapRoute(
    handler,
    (request, requestId, cause) =>
      adminErrorResponse("internal_error", 500, request, { requestId, cause }),
    (request, requestId, detail) =>
      adminErrorResponse("invalid_query", 400, request, { requestId, extra: { detail } }),
  );
}

/**
 * Wraps an `/api/v1` handler: a throw answers an RFC 7807 problem+json
 * `500 internal_error` (`problemResponse`, design §8.1), and an
 * {@link InvalidListQueryError} the `400 invalid_request` problem every other
 * v1 query refusal is.
 */
export function withV1Route<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return wrapRoute(
    handler,
    (request, requestId, cause) =>
      problemResponse("internal_error", 500, request, { requestId, cause }),
    (request, requestId, detail) =>
      problemResponse("invalid_request", 400, request, { requestId, detail }),
  );
}

/**
 * Wraps the MCP Streamable HTTP transport (`/api/mcp`, A-12). Every response,
 * the dark 404 and a notification's 202 included, carries the id, and a throw
 * answers HTTP 500 with a JSON-RPC 2.0 error object: `-32603` "Internal
 * error" (the code JSON-RPC 2.0 reserves for it), `id: null` because the
 * request's id may not have been read, and the correlation id in
 * `data.requestId`, as the other surfaces put it in the body. Logged as
 * `mcp.internal_error`.
 */
export function withMcpRoute<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return wrapRoute(handler, (_request, requestId, cause) => {
    reportThrow("mcp.internal_error", requestId, cause);
    return protocolJson500(
      rpcError(null, RPC_INTERNAL_ERROR, "Internal error", { requestId }),
      requestId,
    );
  });
}

/**
 * Wraps RFC 7591 Dynamic Client Registration (`/api/mcp/register`, A-12). A
 * throw answers HTTP 500 with the registration error shape of RFC 7591 §3.2.2,
 * `{ error, error_description }`, where `server_error` is the OAuth 2.0 code
 * for an unexpected fault (RFC 6749 §4.1.2.1); the id rides the header only,
 * since the shape has no member for it. Logged as
 * `mcp.register.internal_error`.
 */
export function withClientRegistrationRoute<Args extends unknown[], R extends Response>(
  handler: (...args: Args) => R | Promise<R>,
): (...args: Args) => Promise<R | NextResponse> {
  return wrapRoute(handler, (_request, requestId, cause) => {
    reportThrow("mcp.register.internal_error", requestId, cause);
    return protocolJson500(
      {
        error: "server_error",
        error_description: "The registration could not be completed.",
      },
      requestId,
    );
  });
}
