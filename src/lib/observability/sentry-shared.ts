import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/**
 * Isomorphic Sentry helpers shared by the server, edge, and browser
 * configs. This module is intentionally framework-pure (no `server-only`,
 * no DB, no `getServerEnv`) so the browser bundle can import it too.
 *
 * The whole observability feature is **opt-in**: every config keys its
 * `enabled` flag off the presence of a DSN, so with no DSN configured the
 * SDK initializes as a no-op and nothing is sent.
 */

/**
 * Parses a `[0,1]` sample-rate env var, falling back when unset/invalid.
 * Kept permissive (clamps rather than throws) because a bad telemetry
 * knob must never take down a boot.
 */
export function parseSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), 1);
}

/** Header / field names that must never leave the process. */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
]);

/**
 * `beforeSend` PII scrubber. This is a first-party auth / multi-tenant
 * app, so we strip everything that could carry a credential or personal
 * data before an event leaves the process — even though `sendDefaultPii`
 * is already `false`. Mirrors the audit layer's "no secrets in logs"
 * rule (see setup-better-auth.md §7).
 *
 *   - request cookies + auth/cookie headers → dropped
 *   - query string (may carry tokens, emails, handoff JWTs) → dropped
 *   - user email / ip / username → dropped (we keep only an opaque id)
 */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.query_string;
    if (typeof request.url === "string") {
      const q = request.url.indexOf("?");
      if (q !== -1) request.url = request.url.slice(0, q);
    }
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
          delete (request.headers as Record<string, unknown>)[key];
        }
      }
    }
  }
  if (event.user) {
    delete event.user.email;
    delete event.user.ip_address;
    delete (event.user as Record<string, unknown>).username;
  }
  return event;
}
