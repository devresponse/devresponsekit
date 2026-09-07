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
 *   - An inbound `x-request-id` is honoured only when it is a well-formed
 *     UUID and arrives with a forwarded chain — see
 *     {@link normalizeInboundRequestId}, which spells out how little the
 *     second half buys: it rejects non-forwarding callers only, so a caller
 *     that sends `x-forwarded-for` (and every caller behind a real edge) can
 *     still choose the id. Review #224's replay/collision of Support IDs is
 *     therefore NOT closed — the id correlates sinks, it does not identify a
 *     request.
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
