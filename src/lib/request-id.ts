import { isFromTrustedProxy } from "@/lib/client-ip";

/**
 * The correlation id every sink agrees on (review #99, #224).
 *
 * A request id ties together: the user-facing "Support ID" rendered by the
 * error boundaries, the `x-request-id` response header, the Sentry issue tag,
 * the stdout log line, and `app_audit_events.request_id`. Because those sinks
 * are read by operators AND because the audit column is not unique, the id has
 * to be something the SERVER chose — otherwise a client can:
 *
 *   - pick an id already used by someone else's request, so a support lookup
 *     returns two unrelated stories and the audit trail stops being a trail;
 *   - replay one id across thousands of requests to make a specific incident
 *     unfindable;
 *   - hand a non-UUID string to a downstream sink (a raw `x-request-id` used
 *     to reach Sentry and stdout un-validated), injecting control characters
 *     or markup into a log line.
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
 * TWO conditions, both required (review #224):
 *
 *  1. **Provenance.** The request must have arrived through the trusted proxy
 *     layer the deployment is configured for — `TRUSTED_PROXY_COUNT` hops,
 *     the same model `getClientIp` uses for rate-limit keys. A front door /
 *     load balancer that tags requests is the only reason to honour an
 *     inbound id at all; a client talking to the origin directly gets a
 *     server-minted one. With the default of one proxy this means "the
 *     forwarded chain is non-empty", which is false for a direct call and
 *     for local development.
 *  2. **Format.** The value must be a UUID. This bound existed for the admin
 *     helper already and is repeated here because it is the half that keeps
 *     `<script>`, a newline, or a 4 KB blob out of a log line — and because
 *     `instrumentation.ts` previously applied NO validation at all (#99).
 *
 * The provenance check is a bar, not a proof (see {@link isFromTrustedProxy}):
 * behind a real proxy an attacker can still supply a well-formed UUID and have
 * it honoured. That is acceptable for a correlation id and ONLY for a
 * correlation id — nothing may authorize, authenticate, or rate-limit on this
 * value. Callers that need a guaranteed-unique id per request must mint one.
 */
export function normalizeInboundRequestId(
  rawRequestId: unknown,
  xForwardedFor: string | null | undefined,
): string | undefined {
  if (typeof rawRequestId !== "string") return undefined;
  const candidate = rawRequestId.trim();
  if (!isValidRequestId(candidate)) return undefined;
  if (!isFromTrustedProxy(xForwardedFor)) return undefined;
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
