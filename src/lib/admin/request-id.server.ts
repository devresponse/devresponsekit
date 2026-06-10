import "server-only";

/**
 * Request-id correlation (docs/admin-manager.md §12).
 *
 * Every administrator request is tagged with a stable identifier so
 * audit rows, server logs, and error envelopes can be correlated by
 * operators ("who ran the export at 11:42, what request id, was that
 * the same request that 502'd?").
 *
 * Contract:
 *   - If the caller already supplied an `x-request-id` header (e.g. a
 *     load balancer or front-door tagged it), we honour it. We do NOT
 *     trust arbitrary user-supplied values for security decisions, but
 *     they are safe for correlation.
 *   - Otherwise we generate a v4 UUID.
 *   - The same id MUST be echoed back via the `x-request-id` response
 *     header AND included in the JSON error body so a UI can surface
 *     it next to a "contact support" link.
 *   - Calls are memoised per-request (WeakMap keyed on the carrier),
 *     so a handler that calls audit + error + JSON helpers all share
 *     the same id without explicit threading.
 */
const HEADER = "x-request-id";

// RFC 4122 UUID (any version) — the canonical hex/dash form. Anything
// else is treated as untrusted and replaced. We deliberately reject
// inbound values that don't look like a UUID so a typo or hostile
// header (`x-request-id: <script>`) cannot poison logs or response
// headers.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const inbound = headers?.get(HEADER)?.trim();
  const id = inbound && UUID_RE.test(inbound) ? inbound.toLowerCase() : crypto.randomUUID();

  requestIds.set(request as object, id);
  requestIds.set(headers, id);
  return id;
}

export const REQUEST_ID_HEADER = HEADER;
