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
type ReplayOptions = NonNullable<Parameters<typeof Sentry.replayIntegration>[0]>;
/** A Session Replay recording frame, as `beforeAddRecordingEvent` receives it. */
export type ReplayFrameEvent = Parameters<NonNullable<ReplayOptions["beforeAddRecordingEvent"]>>[0];

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
 * (`ipHeaderNames` in `@sentry/core`, not exported) reads exactly these. The
 * app's rate limiter reads `x-forwarded-for` / `x-real-ip` by default, but an
 * operator can point it at ANY one header with `CLIENT_IP_SOURCE`, and this
 * module (shared with the browser bundle) cannot read that setting: the server
 * configs add it through {@link createSentryScrubbers} (F-23). The old
 * `sendDefaultPii: false` bridge filtered these by name; a `dataCollection`
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
 * Extra header names (lower-case, `-` spelling) one runtime denies on top of
 * the static rules: the server configs' `CLIENT_IP_SOURCE` header (F-23).
 */
type ExtraHeaders = ReadonlySet<string>;
const NO_EXTRA_HEADERS: ExtraHeaders = new Set();

/**
 * Whether a header (event-level spelling `X-Forwarded-For`, or the SDK's
 * span-attribute spelling `x_forwarded_for` — `@sentry/core` rewrites `-`
 * to `_` in attribute keys) must never leave the process.
 */
function isSensitiveHeaderName(name: string, extra: ExtraHeaders = NO_EXTRA_HEADERS): boolean {
  const lower = name.toLowerCase().replace(/_/g, "-");
  return (
    SENSITIVE_HEADERS.has(lower) ||
    IP_HEADERS.has(lower) ||
    extra.has(lower) ||
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
  // Sentry 10.74 renamed `queryParams` to `urlQueryParams` and DEFAULTS THE NEW
  // ONE TO `true`, dropping the old key from the resolved policy entirely
  // (`ResolvedDataCollection` omits `queryParams`). Setting only the
  // deprecated name would therefore have silently started shipping
  // query strings — which on this app carry one-time reset and invite tokens.
  // Both are set: the new name is what the SDK reads, the old one keeps the
  // policy correct if a dependency pins an older SDK. `tests/unit/
  // sentry-scrub.test.ts` pins this against the real SDK so the next rename
  // fails the build instead of leaking.
  queryParams: false,
  urlQueryParams: false,
  httpBodies: [],
  // Sentry 10.75 widened `httpHeaders` from `{ request?, response? }` to
  // `CollectBehavior | HttpHeadersCollection`, so a bare `{ deny: [...] }` is
  // now accepted and fanned out to both directions (`resolveHttpHeaders`,
  // @sentry/core build/cjs/utils/data-collection/
  // resolveDataCollectionOptions.js:20-31). We deliberately
  // keep the explicit per-direction form: it resolves identically on 10.75 and
  // is still correct on 10.74, whereas the bare form on a <10.75 SDK would fall
  // through to the `{ request: true, response: true }` default and collect every
  // header with an EMPTY deny list. Same reasoning as the two query-param keys
  // above — the policy must not depend on which SDK actually gets installed.
  // The resolved-policy test pins the direction key set, so an SDK that adds a
  // third direction (which would default to `true`) fails the build.
  httpHeaders: {
    request: { deny: HEADER_DENY_LIST },
    response: { deny: HEADER_DENY_LIST },
  },
  genAI: { inputs: false, outputs: false },
  // The three categories below are inert in this app today — `graphQL` needs a
  // GraphQL integration, `databaseQueryData` is read only by the Supabase
  // integration, and `stackFrameVariables` is read only after
  // `includeLocalVariables` is enabled — but all three DEFAULT TO `true` under
  // `dataCollection` (resolveDataCollectionOptions.js:5-16), so leaving them
  // unset would make the header comment's "every category is spelled out" claim
  // false and would silently open a channel the day one of those integrations
  // is added. `databaseQueryData` is also a regression the switch to
  // `dataCollection` introduced on its own: the old `sendDefaultPii: false`
  // bridge mapped it to `false` (defaultPiiToCollectionOptions.js:30) while the
  // `dataCollection` defaults map it to `true` — and DB query values on this app
  // are hashed credentials, emails and session tokens.
  graphQL: { document: false, variables: false },
  databaseQueryData: false,
  stackFrameVariables: false,
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
 *
 * It is matched by route rather than by guessing which segments look secret
 * (F-23): it is the only secret-bearing path parameter the app serves. Every
 * other Better Auth route parameter is `/callback/:id` (a provider id), and
 * every dynamic segment under `src/app` is a record id, a locale, an org slug,
 * an export name or a docs path, which an incident needs and which grant
 * nothing. A generic "long random segment" rule would strip those ids and
 * still miss a short token. Two tests fail when a new parameterised route
 * appears, so this is revisited: the Better Auth endpoint classification
 * (tests/security/), keyed on each route path, and the `src/app` scan in
 * tests/unit/sentry-server-scrub.test.ts, keyed on each dynamic directory's
 * path, so a new route that reuses a segment name such as `[id]` fails too.
 */
const RESET_PATH_TOKEN_RE = /(\/reset-password\/)[^/?#\s"'<>]+/gi;

/** Redacts emails and token-like strings from free text. */
export function redactText(value: string): string {
  return value.replace(EMAIL_RE, "[redacted-email]").replace(TOKEN_RE, "[redacted-token]");
}

/**
 * Strips the query string AND fragment from a URL (either may carry tokens,
 * emails, `returnTo`) and redacts a reset-token path segment.
 *
 * Exported for the CSP violation sink (review #77): a browser reports
 * `document-uri` verbatim, so a violation raised while the user is on
 * `/en/reset-password?token=…` or `/en/invite?token=…` would otherwise write
 * that one-time token into the log stream. The fragment is cut for the same
 * reason `url.fragment` is dropped from span data — an implicit-flow token or
 * a `returnTo` can ride there, and a `document-uri` (unlike a server-side
 * `request.url`) really can carry one.
 */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  return base.replace(RESET_PATH_TOKEN_RE, "$1[redacted-token]");
}

/** A URL / path as it may leave the process: redacted, then query- and fragment-stripped. */
function scrubUrl(url: string): string {
  return stripQuery(redactText(url));
}

/**
 * Span-attribute and breadcrumb-data keys that are always dropped:
 *   - raw query strings (server `RequestData` writes `url.query`;
 *     OTel / Next.js / browser fetch and the server's outgoing-request
 *     breadcrumbs write `http.query`)
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
export function scrubSpanData(
  data: Record<string, unknown> | undefined,
  extra: ExtraHeaders = NO_EXTRA_HEADERS,
): void {
  if (!data || typeof data !== "object") return;
  for (const key of Object.keys(data)) {
    const value = data[key];
    if (DROPPED_DATA_KEYS.has(key)) {
      delete data[key];
      continue;
    }
    const header = HEADER_DATA_RE.exec(key)?.[1];
    if (header && isSensitiveHeaderName(header, extra)) {
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
 * Context keys whose value is a URL or a path (F-23). The one that leaked is
 * `contexts.nextjs.request_path`: `captureRequestError` (the `onRequestError`
 * hook) copies Next's `request.path` into it verbatim, and that is the path
 * WITH its query string (`/en/invite?token=…`) or the Better Auth reset path
 * (`/api/auth/reset-password/<token>`). It is set on the scope, so neither the
 * `dataCollection` policy nor the `request.url` scrub ever saw it. Matched by
 * key suffix rather than by that one name, so `router_path` and whatever an
 * integration adds next (`*_url`, `*Path`) get the same treatment.
 */
const URL_CONTEXT_KEY_RE = /(?:path|url)$/i;

function scrubContextsInPlace(contexts: NonNullable<Event["contexts"]>): void {
  for (const context of Object.values(contexts)) {
    if (!context || typeof context !== "object") continue;
    const bag = context as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      const value = bag[key];
      if (typeof value === "string" && URL_CONTEXT_KEY_RE.test(key)) bag[key] = scrubUrl(value);
    }
  }
}

/**
 * Strips the request / user / message / exception / breadcrumb / context
 * channels and the transaction name, shared by error, transaction **and**
 * Session Replay events.
 */
function scrubEventInPlace(event: Event, extra: ExtraHeaders = NO_EXTRA_HEADERS): void {
  const request = event.request;
  if (request) {
    delete request.cookies;
    delete request.query_string;
    delete request.data;
    if (typeof request.url === "string") request.url = scrubUrl(request.url);
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        if (isSensitiveHeaderName(key, extra)) {
          delete (request.headers as Record<string, unknown>)[key];
        }
      }
    }
  }
  // Next parameterises route names, but a transaction named from the URL (the
  // span source is `url` when no route matched) would ship it verbatim.
  if (typeof event.transaction === "string") {
    event.transaction = scrubUrl(event.transaction);
  }
  if (event.contexts) scrubContextsInPlace(event.contexts);
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
 *   - URL- and path-valued **contexts** (`contexts.nextjs.request_path`,
 *     which the `onRequestError` hook fills with the raw path and query) and
 *     the transaction name → query stripped + redacted (F-23)
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
  scrubTransactionInPlace(event, NO_EXTRA_HEADERS);
  return event;
}

function scrubTransactionInPlace(event: TransactionEvent, extra: ExtraHeaders): void {
  scrubEventInPlace(event, extra);
  const trace = event.contexts?.trace;
  if (trace) {
    scrubSpanData(trace.data as Record<string, unknown> | undefined, extra);
  }
  if (event.spans) {
    for (const span of event.spans) scrubSpanJsonInPlace(span, extra);
  }
}

function scrubSpanJsonInPlace(span: SpanJSON, extra: ExtraHeaders = NO_EXTRA_HEADERS): void {
  scrubSpanData(span.data as Record<string, unknown> | undefined, extra);
  if (typeof span.description === "string") {
    span.description = scrubUrl(span.description);
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

/** The write-time policy and the four `before*` hooks, as one runtime passes them to `Sentry.init`. */
export interface SentryScrubbers {
  readonly dataCollection: DataCollection;
  readonly beforeSend: typeof scrubEvent;
  readonly beforeSendTransaction: typeof scrubTransaction;
  readonly beforeSendSpan: typeof scrubSpan;
  readonly beforeBreadcrumb: typeof scrubBreadcrumb;
}

/**
 * The policy and hooks for a runtime that denies more headers than the shared
 * rules do (F-23, folded from F-17). `CLIENT_IP_SOURCE` can name any one
 * header as the client IP, and a name such as Azure Front Door's
 * `x-azure-clientip` matches no entry and no fragment above (`-ip` needs the
 * dash), so every server event and sampled transaction shipped the user's IP
 * in it. This module is also the browser's and cannot read server env, so the
 * server and edge configs pass the configured header in. A name the shared
 * rules already deny adds nothing, and with nothing to add this returns the
 * shared {@link SENTRY_DATA_COLLECTION} and `scrub*` hooks themselves.
 */
export function createSentryScrubbers(extraSensitiveHeaders: readonly string[]): SentryScrubbers {
  const names = extraSensitiveHeaders
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "" && !isSensitiveHeaderName(name));
  if (names.length === 0) {
    return {
      dataCollection: SENTRY_DATA_COLLECTION,
      beforeSend: scrubEvent,
      beforeSendTransaction: scrubTransaction,
      beforeSendSpan: scrubSpan,
      beforeBreadcrumb: scrubBreadcrumb,
    };
  }
  // The SDK matches its deny list against the header as sent; the hooks match
  // either spelling (`isSensitiveHeaderName` folds `_` into `-`).
  const deny = [...HEADER_DENY_LIST, ...names];
  const extra: ExtraHeaders = new Set(names.map((name) => name.replace(/_/g, "-")));
  return {
    dataCollection: {
      ...SENTRY_DATA_COLLECTION,
      httpHeaders: { request: { deny }, response: { deny } },
    },
    beforeSend: (event) => {
      scrubEventInPlace(event, extra);
      return event;
    },
    beforeSendTransaction: (event) => {
      scrubTransactionInPlace(event, extra);
      return event;
    },
    beforeSendSpan: (span) => {
      scrubSpanJsonInPlace(span, extra);
      return span;
    },
    // Breadcrumbs carry no request headers.
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

function scrubBreadcrumbInPlace(crumb: Breadcrumb): void {
  if (typeof crumb.message === "string") crumb.message = redactText(crumb.message);
  if (crumb.data && typeof crumb.data === "object") {
    const data = crumb.data as Record<string, unknown>;
    // The server SDK's outgoing-request breadcrumbs (node:http and fetch)
    // sanitize `url` but copy its query and fragment into `http.query` /
    // `http.fragment` verbatim, whatever `dataCollection` says (F-23).
    for (const key of Object.keys(data)) {
      if (DROPPED_DATA_KEYS.has(key)) delete data[key];
    }
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

// ---------------------------------------------------------------------------
// Session Replay (F-23)
//
// A replay reaches Sentry on three channels, and none of the `before*` hooks
// above runs on any of them:
//
//   1. the `replay_event` envelope item, which `@sentry/replay` builds with
//      `prepareReplayEvent`: event processors run, `beforeSend` does not;
//   2. the recording's own frames (`performanceSpan` / `breadcrumb`), which
//      pass through `beforeAddRecordingEvent` only;
//   3. rrweb's DOM events, which reach neither hook.
//
// Each carried the page URL verbatim, query included, so an error on
// `/en/invite?token=…` or `/en/sso/confirm?token=<handoff JWT>` shipped the
// live token to anyone with Sentry project access.
// ---------------------------------------------------------------------------

/**
 * Event processor for the `replay_event` (channel 1), registered with
 * `Sentry.addEventProcessor`. The event names every page the buffered minute
 * visited in `urls`, and the HttpContext integration adds the current page
 * as `request.url` and the previous one as a `Referer` header. All of it goes
 * through the same scrubber as error events, and `urls` / `segment_names`
 * (span names, which can be URLs) through {@link stripQuery}. Every other
 * event kind is returned untouched: the `before*` hooks scrub those.
 */
export function scrubReplayEvent(event: Event): Event {
  if (event.type !== "replay_event") return event;
  scrubEventInPlace(event);
  const replay = event as Event & Record<"urls" | "segment_names", unknown>;
  for (const key of ["urls", "segment_names"] as const) {
    const list = replay[key];
    if (Array.isArray(list)) {
      replay[key] = list.map((item: unknown) => (typeof item === "string" ? scrubUrl(item) : item));
    }
  }
  return event;
}

/**
 * Keys of a recording frame's `data` that hold a URL: `previous` (the page a
 * `navigation.push` left), `url` (the page a slow click, a multi-click or a
 * hydration error happened on), `from` / `to` (navigation breadcrumbs) and
 * `route` (the active span's name, which can be a URL).
 */
const RECORDING_URL_KEYS = ["url", "previous", "from", "to", "route"] as const;

/**
 * `beforeAddRecordingEvent` hook (channel 2). The SDK calls it for the frames
 * it adds to the recording itself, before they are buffered. A
 * `performanceSpan` names a URL in `description`: `navigation.navigate` the
 * whole document URL, `navigation.push` the page an App Router navigation
 * went to, `resource.fetch` / `resource.xhr` the request (an RSC fetch is
 * `/en/invite?token=…&_rsc=…`), `resource.*` each asset. A `breadcrumb` frame
 * redacts its `message` as `beforeBreadcrumb` does. Frames that name no URL
 * (web vitals, memory, the options frame) pass through unchanged. It always
 * returns the frame: returning null would drop it from the replay.
 */
export function scrubReplayRecordingEvent(event: ReplayFrameEvent): ReplayFrameEvent {
  const frame = event.data?.payload as unknown as Record<string, unknown> | undefined;
  if (!frame || typeof frame !== "object") return event;
  if (typeof frame.description === "string") frame.description = scrubUrl(frame.description);
  if (typeof frame.message === "string") frame.message = redactText(frame.message);
  const data = frame.data;
  if (data && typeof data === "object") {
    const bag = data as Record<string, unknown>;
    for (const key of RECORDING_URL_KEYS) {
      const value = bag[key];
      if (typeof value === "string") bag[key] = scrubUrl(value);
    }
  }
  return event;
}

/** rrweb's `EventType`, `IncrementalSource` and `NodeType` values that {@link scrubRrwebEvent} reads. */
const RRWEB_FULL_SNAPSHOT = 2;
const RRWEB_INCREMENTAL_SNAPSHOT = 3;
const RRWEB_META = 4;
const RRWEB_SOURCE_MUTATION = 0;
const RRWEB_ELEMENT_NODE = 2;

/**
 * Element attributes whose value is a URL. rrweb makes `href` / `src`
 * absolute against the page URL, query included (so even `href="#main"`
 * records `…/invite?token=…#main`), and it does so before the SDK's
 * `maskAttributes` runs, which therefore cannot mask them.
 */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "action",
  "formaction",
  "xlink:href",
  "poster",
  "data",
  "cite",
  "background",
  "ping",
]);

/**
 * Scrubs one element's recorded attributes: URL attributes query-stripped and
 * redacted, every other string redacted (a JWT or an email in a `value` or a
 * `data-*` attribute). Skipped: `style` and rrweb's own bookkeeping (`_cssText`
 * holds inlined stylesheets, `rr_*` sizes and scroll offsets), which carry no
 * page data and which the player needs intact, and a fragment-only reference
 * (`<use href="#icon">`), which rrweb leaves relative.
 */
function scrubRrwebAttributes(attributes: Record<string, unknown>): void {
  for (const name of Object.keys(attributes)) {
    const value = attributes[name];
    if (typeof value !== "string" || value.startsWith("#")) continue;
    if (name === "style" || name.startsWith("_") || name.startsWith("rr_")) continue;
    attributes[name] = URL_ATTRIBUTES.has(name.toLowerCase()) ? scrubUrl(value) : redactText(value);
  }
}

/** Scrubs the attributes of every element in a serialized rrweb node tree. */
function scrubRrwebNode(root: unknown): void {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop() as { type?: unknown; attributes?: unknown; childNodes?: unknown };
    if (!node || typeof node !== "object") continue;
    if (
      node.type === RRWEB_ELEMENT_NODE &&
      node.attributes &&
      typeof node.attributes === "object"
    ) {
      scrubRrwebAttributes(node.attributes as Record<string, unknown>);
    }
    if (Array.isArray(node.childNodes)) pending.push(...(node.childNodes as unknown[]));
  }
}

/**
 * Scrubs one rrweb event (channel 3): the page URL every snapshot opens with
 * (`Meta.href`, `window.location.href`), the attributes of each element in a
 * full snapshot, and the added nodes and changed attributes of a DOM
 * mutation. Text is not touched: `maskAllText` / `maskAllInputs` already
 * replace it. Runs as an rrweb record plugin (see
 * {@link installReplayRecordingScrubber}), so it sees each event before the
 * SDK buffers it, and must return it.
 */
export function scrubRrwebEvent<T>(event: T): T {
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (!data || typeof data !== "object") return event;
  const bag = data as Record<string, unknown>;
  if (type === RRWEB_META) {
    if (typeof bag.href === "string") bag.href = scrubUrl(bag.href);
  } else if (type === RRWEB_FULL_SNAPSHOT) {
    scrubRrwebNode(bag.node);
  } else if (type === RRWEB_INCREMENTAL_SNAPSHOT && bag.source === RRWEB_SOURCE_MUTATION) {
    if (Array.isArray(bag.adds)) {
      for (const add of bag.adds as { node?: unknown }[]) scrubRrwebNode(add?.node);
    }
    if (Array.isArray(bag.attributes)) {
      for (const change of bag.attributes as { attributes?: unknown }[]) {
        const attributes = change?.attributes;
        if (attributes && typeof attributes === "object") {
          scrubRrwebAttributes(attributes as Record<string, unknown>);
        }
      }
    }
  }
  return event;
}

/** An rrweb record plugin: rrweb runs `eventProcessor` on every event before emitting it. */
const RRWEB_SCRUB_PLUGIN = { name: "devresponsekit/url-scrub", eventProcessor: scrubRrwebEvent };

/**
 * Installs {@link scrubRrwebEvent} on a `replayIntegration()` instance and
 * reports whether it could. rrweb's events never reach
 * `beforeAddRecordingEvent` (the SDK applies it to its custom frames only,
 * `maybeApplyCallback` → `isCustomEvent`), and the SDK exposes no option for
 * rrweb plugins. It does pass the integration's `_recordingOptions` to
 * `record()` as they are (`ReplayContainer#startRecording` spreads them), so
 * the plugin goes in there. That field is private: when a future SDK drops
 * it this returns false and the caller leaves Session Replay out, rather than
 * record URLs nothing scrubs. `tests/unit/sentry-replay.test.ts` drives the
 * real SDK and rrweb, so a version that keeps the field but stops using it
 * fails there.
 */
export function installReplayRecordingScrubber(integration: object): boolean {
  const options = (integration as { _recordingOptions?: unknown })._recordingOptions;
  if (!options || typeof options !== "object") return false;
  const recording = options as { plugins?: unknown };
  const plugins = Array.isArray(recording.plugins) ? (recording.plugins as unknown[]) : [];
  recording.plugins = [...plugins, RRWEB_SCRUB_PLUGIN];
  return true;
}
