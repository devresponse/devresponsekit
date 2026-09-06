import "server-only";
import { REQUEST_ID_HEADER, normalizeInboundRequestId } from "@/lib/request-id";

/**
 * Request-id correlation (docs/admin-manager.md §12).
 *
 * Every administrator request is tagged with a stable identifier so
 * audit rows, server logs, and error envelopes can be correlated by
 * operators ("who ran the export at 11:42, what request id, was that
 * the same request that 502'd?").
 *
 * Contract:
 *   - An inbound `x-request-id` is honoured ONLY when it came through the
 *     deployment's trusted proxy hops AND is a well-formed UUID — see
 *     {@link normalizeInboundRequestId} (review #224). Honouring it from any
 *     client let a caller replay or collide the Support IDs operators search
 *     by (the audit column is not unique), so an id from a direct caller is
 *     now discarded, not trusted.
 *   - Otherwise we generate a v4 UUID.
 *   - The same id MUST be echoed back via the `x-request-id` response
 *     header AND included in the JSON error body so a UI can surface
 *     it next to a "contact support" link.
 *   - Calls are memoised per-request (WeakMap keyed on the carrier),
 *     so a handler that calls audit + error + JSON helpers all share
 *     the same id without explicit threading.
 */
const HEADER = REQUEST_ID_HEADER;

/**
 * Per-request memoisation. We key on the carrier object (NextRequest
 * or `{ headers }`), and fall back to keying on the underlying
 * `Headers` instance when the carrier varies between calls. A
 * `WeakMap` lets the entries be garbage-collected with the request.
 */
const requestIds = new WeakMap<object, string>();

export function getOrCreateRequestId(request: { headers: Headers } | Headers | undefined): string {
  if (!request) return crypto.randomUUID();

  const headers = request instanceof Headers ? request : request.headers;

  // Memoised value wins so every call inside a single request handler
  // (audit row, error envelope, response header) shares the same id.
  const cachedByCarrier = requestIds.get(request as object);
  if (cachedByCarrier) return cachedByCarrier;
  const cachedByHeaders = requestIds.get(headers);
  if (cachedByHeaders) {
    requestIds.set(request as object, cachedByHeaders);
    return cachedByHeaders;
  }

  const id =
    normalizeInboundRequestId(headers?.get(HEADER), headers?.get("x-forwarded-for")) ??
    crypto.randomUUID();

  requestIds.set(request as object, id);
  requestIds.set(headers, id);
  return id;
}

export { REQUEST_ID_HEADER };
