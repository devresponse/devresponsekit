import type * as Sentry from "@sentry/nextjs";
import type { Breadcrumb, ErrorEvent, Event, EventHint } from "@sentry/nextjs";

/**
 * `@sentry/nextjs` re-exports only a curated subset of `@sentry/core`'s
 * types (no `TransactionEvent` / `SpanJSON` / `DataCollection`), so derive
 * them from the `init` option surface instead of reaching into the
 * transitive `@sentry/core` package.
 */
type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
export type TransactionEvent = Parameters<NonNullable<InitOptions["beforeSendTransaction"]>>[0];
export type SpanJSON = Parameters<NonNullable<InitOptions["beforeSendSpan"]>>[0];
export type DataCollection = NonNullable<InitOptions["dataCollection"]>;

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

/**
 * Header / field names that must never leave the process. `referer` /
 * `referrer` are included because the previous page's URL routinely
 * carries the exact query strings we strip elsewhere (`?token=`,
 * `?returnTo=`, `?email=`) — review #22.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization",
  "referer",
  "referrer",
]);

/**
 * Headers that carry the client's IP address — the SDK's own IP resolver
 * (`ipHeaderNames` in `@sentry/core`, not exported) reads exactly these,
 * and the app's rate limiter reads the same ones. The old
 * `sendDefaultPii: false` bridge filtered them by name; a `dataCollection`
 * policy replaces that bridge wholesale, so they must be denied here or
 * every sampled server transaction ships the user's IP (review #22).
 */
const IP_HEADERS = new Set([
  "x-client-ip",
  "x-forwarded-for",
  "fly-client-ip",
  "cf-connecting-ip",
  "fastly-client-ip",
  "true-client-ip",
  "x-real-ip",
  "x-cluster-client-ip",
  "x-forwarded",
  "forwarded-for",
  "forwarded",
  "x-vercel-forwarded-for",
  // The app's own trusted-client-IP header (`CLIENT_IP_HEADER` in
  // src/lib/client-ip.ts; a literal here because this module is shared with
  // the browser bundle, which must not import the server env module).
  "x-drk-client-ip",
]);

/**
 * Header-name fragments the SDK's `sendDefaultPii: false` bridge denied
 * (`PII_HEADER_SNIPPETS`). Its deny-list matching is substring-based, so
 * listing them keeps parity with the pre-`dataCollection` behaviour for
 * any proxy header not named above (`x-forwarded-user`, `via`,
 * `remote-addr`, `x-original-forwarded-for`, …).
 */
const PII_HEADER_SNIPPETS = ["forwarded", "-ip", "remote-", "via", "-user"];

/** The write-time header deny list: exact names + the SDK's PII snippets. */
const HEADER_DENY_LIST = [...SENSITIVE_HEADERS, ...IP_HEADERS, ...PII_HEADER_SNIPPETS];

/**
 * Whether a header (event-level spelling `X-Forwarded-For`, or the SDK's
 * span-attribute spelling `x_forwarded_for` — `@sentry/core` rewrites `-`
 * to `_` in attribute keys) must never leave the process.
 */
function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase().replace(/_/g, "-");
  return (
    SENSITIVE_HEADERS.has(lower) ||
    IP_HEADERS.has(lower) ||
    PII_HEADER_SNIPPETS.some((snippet) => lower.includes(snippet))
  );
}

/**
 * Write-time collection policy passed to every `Sentry.init`. The SDK
 * attaches request data to **transactions and spans** as well as error
 * events, and its own `sendDefaultPii: false` bridge still records query
 * strings, cookies, and headers behind a name-based deny list — so we tell
 * it not to record them at all. The `scrub*` hooks below remain the
 * backstop for anything that reaches an event by another path (review #22).
 *
 * NOTE: once `dataCollection` is set the SDK ignores `sendDefaultPii` and
 * builds on its **permissive** defaults (`userInfo: true`, header deny list
 * empty), so every category is spelled out here rather than relying on a
 * default — including the IP-bearing headers the bridge used to deny.
 */
export const SENTRY_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  queryParams: false,
  httpBodies: [],
  httpHeaders: {
    request: { deny: HEADER_DENY_LIST },
    response: { deny: HEADER_DENY_LIST },
  },
  genAI: { inputs: false, outputs: false },
  // The `sendDefaultPii: false` bridge used 7 (the ContextLines default);
  // the `dataCollection` defaults drop to 5. Keep the stack-context parity.
  frameContextLines: 7,
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Credential shapes this app mints, so a stray token in a log line never
 * ships: API keys (`drk_live_…`), OAuth client ids/secrets (`drkc_…` /
 * `drkcsec_…`), and any JWT (`eyJ….….…` — SSO handoff + access tokens).
 */
const TOKEN_RE =
  /\b(?:drkcsec_[A-Za-z0-9]+|drkc?_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g;

/**
 * The password-reset link carries its one-time token as a **path segment**
 * (`/reset-password/<token>`), so a query-only strip would leave it in
 * `request.url` / `url.full`. Same shape as `outbox-secrets.ts`.
 */
const RESET_PATH_TOKEN_RE = /(\/reset-password\/)[^/?#\s"'<>]+/gi;

/** Redacts emails and token-like strings from free text. */
export function redactText(value: string): string {
  return value.replace(EMAIL_RE, "[redacted-email]").replace(TOKEN_RE, "[redacted-token]");
}

/**
 * Strips the query string from a URL (may carry tokens, emails, returnTo)
 * and redacts a reset-token path segment.
 */
function stripQuery(url: string): string {
  const q = url.indexOf("?");
  const base = q === -1 ? url : url.slice(0, q);
  return base.replace(RESET_PATH_TOKEN_RE, "$1[redacted-token]");
}

/**
 * Span-attribute keys that are always dropped:
 *   - raw query strings (server `RequestData` writes `url.query`;
 *     OTel / Next.js / browser fetch write `http.query`)
 *   - URL fragments (`url.fragment` / `http.fragment` — a hash can carry
 *     an OAuth implicit-flow token or a `returnTo`)
 *   - the captured request body (`httpBodies: []` stops it at write time;
 *     this mirrors the event-level `delete request.data` as the backstop)
 *   - the client IP (`http.client_ip` is set **unconditionally** by the
 *     Node http-server span integration from `x-forwarded-for`;
 *     `user.ip_address` / `client.address` / `net.peer.ip` /
 *     `net.sock.peer.addr` / `network.peer.address` are the RequestData /
 *     OTel spellings) — the policy is "no user info", so no IP anywhere.
 */
const DROPPED_DATA_KEYS = new Set([
  "url.query",
  "http.query",
  "url.fragment",
  "http.fragment",
  "http.request.body.data",
  "http.client_ip",
  "user.ip_address",
  "client.address",
  "net.peer.ip",
  "net.sock.peer.addr",
  "network.peer.address",
]);

/**
 * Span-attribute keys that hold a URL which may carry a query string /
 * reset token — re-run through {@link stripQuery} + {@link redactText}.
 * The bare `url` key is what browser fetch / XHR `http.client` spans use
 * for the full request URL (query included).
 */
const URL_DATA_KEYS = new Set([
  "url",
  "url.full",
  "url.path",
  "url.original",
  "http.url",
  "http.target",
  "http.route",
  "http.request.url",
  "http.response.url",
  "next.route",
  "next.page",
]);

/**
 * Attribute keys whose *name* says "secret" (mirrors the Pino `redact`
 * paths in `logger.server.ts`): the value is replaced wholesale rather
 * than pattern-redacted, because we cannot know its shape.
 */
const SECRET_KEY_RE =
  /(?:^|[._-])(?:password|passwd|token|secret|authorization|cookie|api[._-]?key)(?:$|[._-])/i;

/**
 * `http.request.header.<name>[.<cookie>]` / `http.response.header.<name>`
 * attributes for a sensitive header (cookies are exploded one attribute
 * per cookie name, hence the optional suffix). The SDK writes `<name>`
 * with `_` in place of `-` (`x_forwarded_for`, `set_cookie`);
 * {@link isSensitiveHeaderName} normalises both spellings.
 */
const HEADER_DATA_RE = /^http\.(?:request|response)\.header\.([^.]+)(?:\.|$)/i;

/**
 * Scrubs a span-attribute bag in place: query / fragment / body / IP
 * attributes dropped, URL attributes query-stripped, sensitive-header
 * attributes (auth, cookies, referer, IP-bearing proxy headers) dropped,
 * secret-named keys replaced, and every remaining string value pattern-
 * redacted. Exported for the unit tests; callers use {@link scrubSpan} /
 * {@link scrubTransaction}.
 */
export function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data || typeof data !== "object") return;
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (DROPPED_DATA_KEYS.has(key)) {
      delete data[key];
      continue;
    }
    const header = HEADER_DATA_RE.exec(key)?.[1];
    if (header && isSensitiveHeaderName(header)) {
      delete data[key];
      continue;
    }
    if (SECRET_KEY_RE.test(key)) {
      data[key] = "[redacted]";
      continue;
    }
    if (typeof value !== "string") continue;
    data[key] = URL_DATA_KEYS.has(key) ? stripQuery(redactText(value)) : redactText(value);
  }
}

/**
 * Strips the request / user / message / exception / breadcrumb channels
 * shared by error **and** transaction events.
 */
function scrubEventInPlace(event: Event): void {
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.query_string;
    delete request.data;
    if (typeof request.url === "string") request.url = stripQuery(request.url);
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        if (isSensitiveHeaderName(key)) {
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
}

/**
 * `beforeSend` PII scrubber. This is a first-party auth / multi-tenant
 * app, so we strip everything that could carry a credential or personal
 * data before an event leaves the process — even though the SDK's own
 * collection policy ({@link SENTRY_DATA_COLLECTION}) is already closed.
 * Mirrors the logging layer's "never log a plaintext credential" rule
 * (docs/observability.md §3 "Redaction & scrubbing policy").
 *
 *   - request cookies + auth/cookie/referer headers + body → dropped
 *   - IP-bearing proxy headers (`x-forwarded-for`, `x-real-ip`, …) → dropped
 *   - query string (may carry tokens, emails, SSO handoff JWTs) → dropped;
 *     a `/reset-password/<token>` path segment → redacted
 *   - user email / ip / username → dropped (we keep only an opaque id)
 *   - the error **message** and every **exception value** → emails/tokens
 *     redacted (e.g. a provider error like `resend 4xx: <body>`)
 *   - **breadcrumbs** → URL query strings stripped + messages redacted
 *     (breadcrumbs are on by default and would otherwise leak fetch URLs
 *     like `/sign-in?returnTo=…&email=…`)
 */
export function scrubEvent(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  scrubEventInPlace(event);
  return event;
}

/**
 * `beforeSendTransaction` scrubber (review #22). Sampled transactions carry
 * the same `request` / `user` / breadcrumb channels as error events **plus**
 * the root span's attributes in `contexts.trace.data` and every child span
 * in `spans[]` — where the SDK records `url.full`, `url.query`,
 * `http.request.header.*` (cookies exploded per name) and whatever an
 * instrumentation attached. Everything goes through the same scrubber as
 * error events so there is one implementation to keep honest; the
 * transaction name itself is redacted too (Next.js parameterises routes,
 * but a raw `/reset-password/<token>` would otherwise ship verbatim).
 */
export function scrubTransaction(event: TransactionEvent, _hint: EventHint): TransactionEvent {
  scrubEventInPlace(event);
  if (typeof event.transaction === "string") {
    event.transaction = stripQuery(redactText(event.transaction));
  }
  const trace = event.contexts?.trace;
  if (trace) {
    scrubSpanData(trace.data as Record<string, unknown> | undefined);
  }
  if (event.spans) {
    for (const span of event.spans) scrubSpanJsonInPlace(span);
  }
  return event;
}

function scrubSpanJsonInPlace(span: SpanJSON): void {
  scrubSpanData(span.data as Record<string, unknown> | undefined);
  if (typeof span.description === "string") {
    span.description = stripQuery(redactText(span.description));
  }
}

/**
 * `beforeSendSpan` scrubber (review #22). Runs per span (root + children)
 * before {@link scrubTransaction} sees the assembled event, so a span that
 * is exported on its own (span streaming, standalone spans) is covered
 * too. Always returns the span — dropping one here would only orphan its
 * children.
 */
export function scrubSpan(span: SpanJSON): SpanJSON {
  scrubSpanJsonInPlace(span);
  return span;
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
