import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";

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

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Credential shapes this app mints, so a stray token in a log line never
 * ships: API keys (`drk_live_…`), OAuth client ids/secrets (`drkc_…` /
 * `drkcsec_…`), and any JWT (`eyJ….….…` — SSO handoff + access tokens).
 */
const TOKEN_RE =
  /\b(?:drkcsec_[A-Za-z0-9]+|drkc?_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;

/** Redacts emails and token-like strings from free text. */
export function redactText(value: string): string {
  return value.replace(EMAIL_RE, "[redacted-email]").replace(TOKEN_RE, "[redacted-token]");
}

/** Strips the query string from a URL (may carry tokens, emails, returnTo). */
function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * `beforeSend` PII scrubber. This is a first-party auth / multi-tenant
 * app, so we strip everything that could carry a credential or personal
 * data before an event leaves the process — even though `sendDefaultPii`
 * is already `false`. Mirrors the audit layer's "no secrets in logs"
 * rule (setup-better-auth.md §7).
 *
 *   - request cookies + auth/cookie headers → dropped
 *   - query string (may carry tokens, emails, SSO handoff JWTs) → dropped
 *   - user email / ip / username → dropped (we keep only an opaque id)
 *   - the error **message** and every **exception value** → emails/tokens
 *     redacted (e.g. a provider error like `resend 4xx: <body>`)
 *   - **breadcrumbs** → URL query strings stripped + messages redacted
 *     (breadcrumbs are on by default and would otherwise leak fetch URLs
 *     like `/sign-in?returnTo=…&email=…`)
 */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.query_string;
    if (typeof request.url === "string") request.url = stripQuery(request.url);
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
  if (typeof event.message === "string") {
    event.message = redactText(event.message);
  }
  if (event.exception?.values) {
    for (const value of event.exception.values) {
      if (typeof value.value === "string") value.value = redactText(value.value);
    }
  }
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) scrubBreadcrumbInPlace(crumb);
  }
  return event;
}

function scrubBreadcrumbInPlace(crumb: Breadcrumb): void {
  if (typeof crumb.message === "string") crumb.message = redactText(crumb.message);
  if (crumb.data && typeof crumb.data === "object") {
    const data = crumb.data as Record<string, unknown>;
    if (typeof data.url === "string") data.url = stripQuery(redactText(data.url));
    if (typeof data.from === "string") data.from = stripQuery(data.from);
    if (typeof data.to === "string") data.to = stripQuery(data.to);
  }
}

/**
 * `beforeBreadcrumb` hook. Breadcrumbs are recorded continuously (fetch,
 * navigation, console) and are the easiest place for a credential or email
 * to slip into an event — scrub each one as it is added, before it is ever
 * attached to an event.
 */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  scrubBreadcrumbInPlace(crumb);
  return crumb;
}
