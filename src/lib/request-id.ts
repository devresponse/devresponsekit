import { hasForwardedHops } from "@/lib/client-ip";

/**
 * The correlation id every sink agrees on (review #99, #224).
 *
 * A request id ties together: the user-facing "Support ID" rendered by the
 * error boundaries, the `x-request-id` response header, the Sentry issue tag,
 * the stdout log line, and `app_audit_events.request_id`. Because those sinks
 * are read by operators AND because the audit column is not unique, honouring
 * a client-supplied id lets a client:
 *
 *   1. pick an id already used by someone else's request, so a support lookup
 *      returns two unrelated stories and the audit trail stops being a trail;
 *   2. replay one id across thousands of requests to make a specific incident
 *      unfindable;
 *   3. hand a non-UUID string to a downstream sink (a raw `x-request-id` used
 *      to reach Sentry and stdout un-validated), injecting control characters
 *      or markup into a log line.
 *
 * This module closes (3) — everywhere, including `instrumentation.ts`, which
 * validated nothing (#99). It does NOT close (1) or (2): honouring an inbound
 * id is a deliberate trade for edge↔app correlation, and the bar it puts in
 * front of that is weak by construction. See
 * {@link normalizeInboundRequestId} for exactly how weak, and treat every
 * request id as a correlation aid rather than an identity.
 *
 * This module is deliberately framework-free — no `server-only`, no DB, no
 * `next/*` — so both the App Router helper (`lib/admin/request-id.server.ts`)
 * and `instrumentation.ts` (which also runs on the EDGE runtime) use one
 * implementation, and there is exactly one answer to "is this id trustworthy".
 */

/** The inbound / outbound correlation header. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * RFC 4122 UUID (any version), canonical hex/dash form. Every id this app
 * mints is `crypto.randomUUID()`, so anything else did not come from us.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a well-formed request id (and therefore log-safe). */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * The inbound `x-request-id` to honour, or `undefined` when the caller must
 * mint its own.
 *
 * TWO conditions, both required:
 *
 *  1. **Format.** The value must be a UUID. This is the load-bearing check
 *     (review #99): it is what keeps `<script>`, a newline, or a 4 KB blob out
 *     of a log line and a Sentry tag, and `instrumentation.ts` previously
 *     applied NO validation at all there.
 *  2. **A forwarded chain is present** — at least `TRUSTED_PROXY_COUNT`
 *     entries in `X-Forwarded-For` (see {@link hasForwardedHops}).
 *
 * **What condition 2 does NOT do.** It is not a provenance proof and does not
 * close review #224. `X-Forwarded-For` is client-supplied, so ANY caller
 * satisfies it by sending one extra header, and behind a real edge (Vercel,
 * any LB) it is unconditionally true. It rejects exactly one population:
 * callers that send no chain at all — an unmodified direct request to a
 * non-proxied origin, and local development. A deliberate forger is not
 * affected in any deployment.
 *
 * **So #224's threat stands, by design.** A determined client can still pin
 * one UUID across many requests, or reuse an id it saw elsewhere, and that
 * value lands in `app_audit_events.request_id` (a non-unique column), the
 * `x-request-id` response header and the Sentry tag. A request id is a
 * CORRELATION AID and nothing else: it is not proof that two rows belong to
 * one request, and nothing may authorize, authenticate, rate-limit, or
 * de-duplicate on it. Callers that need a guaranteed-unique per-request value
 * must mint their own. Closing the forgery hole would mean never honouring an
 * inbound id (and losing edge↔app correlation) or authenticating the header
 * from the edge with a shared secret; neither is implemented.
 */
export function normalizeInboundRequestId(
  rawRequestId: unknown,
  xForwardedFor: string | null | undefined,
): string | undefined {
  if (typeof rawRequestId !== "string") return undefined;
  const candidate = rawRequestId.trim();
  if (!isValidRequestId(candidate)) return undefined;
  if (!hasForwardedHops(xForwardedFor)) return undefined;
  return candidate.toLowerCase();
}

/**
 * Reads a header from the plain object shape Next.js hands `onRequestError`
 * (`Record<string, string | string[] | undefined>`), where a repeated header
 * arrives as an array. Header names there are already lower-cased.
 */
export function headerValueFromRecord(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const raw = headers?.[name];
  if (typeof raw === "string") return raw;
  return Array.isArray(raw) ? raw[0] : undefined;
}
