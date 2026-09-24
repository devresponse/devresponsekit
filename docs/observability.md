---
title: Observability
description: What signals the app emits, how to correlate them in an incident, and what's on the roadmap.
group: General
order: 100
---

# Observability

_Audience: operators and on-call engineers. What signals the app emits today, how to
correlate them during an incident, and what is deliberately still on the roadmap._

---

## 1. What ships today

| Signal | Source | Notes |
| --- | --- | --- |
| **Structured logs** | `src/lib/observability/logger.server.ts` | Pino, JSON to stdout. Ships regardless of whether Sentry is configured — your platform's log drain is the primary sink. |
| **Server-error logging** | `logServerError(...)` + `onRequestError` (`src/instrumentation.ts`) | Every uncaught 5xx is logged with its `x-request-id`; also forwarded to Sentry when enabled. |
| **Request-id correlation** | `src/lib/request-id.ts` (`normalizeInboundRequestId`) + `src/lib/admin/request-id.server.ts` (`getOrCreateRequestId`) | Accepts an inbound `x-request-id` only as a UUID and only with a forwarded chain present (a weak bar — see [§4](#4-correlating-an-incident)); otherwise mints one. Echoed on every admin (`adminErrorResponse`) and RFC 7807 (`problemResponse`) error response. |
| **Audit events** | `src/lib/audit.server.ts` → `app_audit_events` | Durable record of security-relevant actions (auth, admin mutations, SSO, token mint/revoke, exports), each stamped with the request id. Append-only; retention is an ops concern — see the note below. Written only for a caller something has verified (session, credential, signed SSO token); `user_agent` is capped at 512 characters. |
| **Pre-auth refusals** | `logPreAuthRefusal` (`src/lib/observability/pre-auth-refusal.server.ts`) | A request refused **before** its caller is authenticated — the CSRF origin guard on every cookie surface, an SSO consume without a verifiable token, a signed-out SSO launch — writes **no audit row** (an anonymous loop must not grow the append-only table, F-15). It logs one `kind: "pre_auth_refusal"` line (event type, reason, request id, capped `User-Agent`, method, path — no client IP, which the log stream never carries; `warn` for `denied`, `error` for `failure`) and increments `devresponsekit_pre_auth_refusals_total` ([§5](#5-metrics)). The full list is in [admin-manager.md §12](./admin-manager.md#12-audit-model). |
| **CSP violation sink** | `POST /api/security/csp-report` | The enforcing CSP (`src/proxy.ts`) reports blocks here; rate-limited + aggregated per directive. |
| **Metrics (opt-in)** | `GET /api/metrics`, `src/lib/observability/metrics.server.ts` | Prometheus text exposition: Node process defaults (heap, RSS, event-loop lag, GC, CPU) + the `…_rate_limit_denials_total{scope}` and `…_pre_auth_refusals_total{event_type}` business counters. Token-guarded (`METRICS_TOKEN`), **fails closed**. First increment — see [§5 Metrics](#5-metrics). |
| **Error monitoring (opt-in)** | `src/sentry.{server,edge}.config.ts`, `src/instrumentation-client.ts` (browser init), `src/lib/observability/sentry-shared.ts` | Sentry engages only when `NEXT_PUBLIC_SENTRY_DSN` is set. Errors, transactions, spans, breadcrumbs and Session Replay are all scrubbed (cookies, query strings, emails, tokens, secret-like values) before they leave the process — see [§3](#3-redaction--scrubbing-policy). |
| **Liveness / readiness** | `GET /api/health`, `GET /api/health/ready` | Unauthenticated, `no-store`. `/ready` returns `200` when the environment passes its schema, the database is reachable, the ledger holds every core migration the build needs **and** Better Auth's own schema check finds every table and column it writes (F-26); `503` with `reason: config_invalid`, `database_unreachable` or `schema_behind` otherwise (invalid variable names, missing ids and missing Better Auth tables go to the log under `kind: "config-invalid"`, `"schema-behind"` and `"auth-schema-behind"`, never the body). Wire both to your orchestrator probes (see [deployment.md §4](./deployment.md#4-deploy--post-deploy-verification) and [docker.md §7](./docker.md)). |
| **Process-fault handlers** | `src/lib/process-errors.server.ts` | `unhandledRejection` / `uncaughtException` are logged + captured to Sentry (not swallowed) so a fault that escaped every request boundary is visible in the log stream. They do **not** exit — Next 16 treats both as non-fatal — unless `PROCESS_FATAL_ON_UNCAUGHT=1` opts uncaught exceptions into `exit(1)` (review #23; see [configuration.md](./configuration.md)). |

> **Retention is an ops concern.** `app_audit_events` and `app_outbox` grow
> without bound. Schedule **`pnpm db:prune`** (`scripts/prune-retention.ts`) to
> apply the configured windows (`AUDIT_RETENTION_DAYS`, default 365;
> `OUTBOX_RETENTION_DAYS`, default 90) and prune expired token revocations — see
> [Deployment](./deployment.md).

## 2. Configuration

All observability is **opt-in and env-driven**; a default build emits structured logs and
nothing else. The full Sentry variable set lives in the Observability section of
[configuration.md](./configuration.md). The essentials:

- `NEXT_PUBLIC_SENTRY_DSN` — **presence enables** client + server monitoring and the
  build-time plugin.
- `SENTRY_DSN` — server DSN (defaults to the public DSN).
- `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` — **build/CI only**, for source-map
  upload. Never expose `SENTRY_AUTH_TOKEN` to the client.

## 3. Redaction & scrubbing policy

Two layers, both fail-safe (redact-by-default):

- **Logs** — the Pino logger redacts any `password`, `token`, `secret`, `authorization`, or
  `cookie` field (and their nested `*.` variants) to `[redacted]` before serialization —
  covering session tokens, API-key secrets, and the Better Auth secret. Never log a
  plaintext credential; the audit log records **metadata only**.
- **Sentry** — `sentry-shared.ts` strips cookies, query strings, URL fragments, request
  bodies, the `referer` header, emails, bearer/API tokens, and secret-like values from
  **every channel an event leaves by**:
  - **error events** (`beforeSend`): the request, user, message, exception values,
    breadcrumbs, the transaction name, and every context value whose key ends in `path` or
    `url`. The last one matters because the `onRequestError` hook records the raw request
    path, query included, as `contexts.nextjs.request_path` (F-23);
  - sampled **transactions** (`beforeSendTransaction`) and their **spans**
    (`beforeSendSpan`), including the root-span attributes in `contexts.trace.data`, each
    `spans[].data` (`url.full`, `url.query`, `http.request.header.*`, …), span
    descriptions, and the transaction name;
  - **breadcrumbs** (`beforeBreadcrumb`), as they are recorded. The URL loses its query,
    and the `http.query` / `http.fragment` keys are dropped: the SDK's outgoing-request
    breadcrumbs on the server copy both verbatim;
  - **Session Replay** (browser only, F-23), which none of the hooks above reach. The
    `replay_event` (`urls`, `request.url`, the `Referer` header) goes through an event
    processor. The SDK's own recording frames (navigation, request and asset spans; click
    and hydration-error breadcrumbs) go through `beforeAddRecordingEvent`. rrweb's DOM
    events (the page URL each snapshot starts with, each element's `href` / `src` /
    `action`, and any other attribute value holding a token or an email) go through an
    rrweb plugin. Text and typed inputs stay masked, media stays blocked, and hidden inputs
    are masked as well. The plugin is installed through a private SDK field. If an SDK
    upgrade removes that field, the app leaves Session Replay out instead of recording
    unscrubbed. If an upgrade keeps the field but stops using it,
    `tests/unit/sentry-replay.test.ts` fails, because it runs the real SDK and rrweb.

  The **client IP** is treated as user info and never sent: the IP-bearing proxy headers
  (`x-forwarded-for`, `x-real-ip`, the app-derived `x-drk-client-ip` that Better Auth's
  limiter keys on — review #35 — `cf-connecting-ip`, `true-client-ip`,
  `x-vercel-forwarded-for`, `forwarded`, `via`, …) are denied at write time and dropped by
  the hooks, as are the `http.client_ip` / `user.ip_address` / `client.address` span
  attributes the Node HTTP instrumentation sets. The deny list is a set of names plus any
  header whose name contains `forwarded`, `-ip`, `remote-`, `via` or `-user`. On the server
  and edge runtimes it also holds the header `CLIENT_IP_SOURCE` names, read at startup,
  because that header can match none of those rules (Azure Front Door's `x-azure-clientip`
  has no `-ip`). The browser never sees it: the edge adds it on the way in.

  **One-time tokens in a URL are never sent.** Every URL- or path-valued field on the
  channels above loses its query string and fragment. The only secret the app carries as a
  **path segment**, Better Auth's `/reset-password/<token>`, is redacted by that route. It
  is matched by route, not by shape: every other route parameter is a record id, a locale,
  an org slug, an export name, a docs path or a provider id. Two tests fail when a new
  parameterised route appears, even one that reuses a parameter name such as `[id]`: the
  Better Auth endpoint classification, which lists each route path, and the `src/app` scan
  in `tests/unit/sentry-server-scrub.test.ts`, which lists each dynamic directory by its
  path.

  The SDK is also told not to _record_ cookies, query parameters, bodies, or user info in the first
  place (`dataCollection` in all three `Sentry.init` calls — this **replaces** the
  deprecated `sendDefaultPii: false` bridge, so every deny list it used to apply is spelled
  out explicitly); the hooks are the backstop (review #22). Because `dataCollection` builds
  on the SDK's own **permissive** defaults rather than the bridge's, the categories that
  default to _on_ are closed by name too — GraphQL documents/variables, database query
  values (`databaseQueryData`, which the bridge mapped to `false`), and stack-frame local
  variables. They are inert until the matching integration is enabled; spelling them out is
  what keeps enabling one from silently opening a channel. `tests/unit/sentry-scrub.test.ts`
  asserts the policy **as the SDK resolves it**, so an upstream rename or default flip fails
  the build instead of leaking.
- **Email outbox** — `src/lib/email/outbox-secrets.ts` redacts one-time links (the
  `/reset-password/<token>` path segment and every `token=` query value → `[redacted]`) from
  the `app_outbox` columns the administrator API can read (`subject`, `body_html`,
  `body_text`, `variables`) **at insert time**. The unredacted message exists only in memory
  for the inline delivery and, for retries, in the DB-only `delivery_payload` column, which
  the drain worker nulls once a row is terminal (`sent` / `failed`) and which no admin route
  selects (review #21).

When adding a field that could carry user data or a secret, extend the redaction list in the
same change.

## 4. Correlating an incident

`x-request-id` is the join key across every surface:

1. The client (or your edge/CDN) receives `x-request-id` on the error response
   (admin envelope or RFC 7807 `problem+json`).
2. Grep the **log stream** for that id to find the structured server log + stack.
3. Query **`app_audit_events`** by the same id to see the actor, tenant, and outcome of the
   action that triggered it. A request refused before authentication (a CSRF origin
   refusal, an unverifiable SSO token, a signed-out launch) has **no** row by design — its
   `pre_auth_refusal` log line from step 2 is the whole record.
4. If Sentry is enabled, the event carries the id as a tag for a fourth view with breadcrumbs.

An inbound `x-request-id` is preserved end-to-end when it is a UUID and the request
carries a forwarded chain (`TRUSTED_PROXY_COUNT` entries in `X-Forwarded-For`);
otherwise the server mints its own (`src/lib/request-id.ts`, review #99/#224). So an
edge/CDN trace id flows straight into server logs and audit rows.

**Do not read that as a trust boundary.** The UUID check is the load-bearing half:
it is what keeps control characters, markup and oversized junk out of the log line
and the Sentry tag (`instrumentation.ts` previously applied no validation at all).
The forwarded-chain half is client-supplied — any caller passes it by sending one
extra header, and behind a real edge it is true for every request — so it rejects
only callers that send no chain (a direct request to a non-proxied origin, local
development) and does nothing against a deliberate forger. A client can still pin
one id across many requests or reuse someone else's, and `app_audit_events.request_id`
is not unique. **Treat a request id as a correlation aid, never as proof that two
records belong to one request**, and never authorize or de-duplicate on it.

## 5. Metrics

A Prometheus scrape endpoint ships at **`GET /api/metrics`** (`src/lib/observability/metrics.server.ts`).
This is the **first increment** of the metrics roadmap (§6) — process health plus the first
business counter — not the full target set.

**What it exposes (Prometheus text exposition format):**

- **Node/process defaults** (prefix `devresponsekit_`): heap, RSS, event-loop lag, GC, CPU,
  active handles — the highest signal-per-effort view for catching leaks and saturation, with
  zero application instrumentation.
- **`devresponsekit_rate_limit_denials_total{scope}`** — a counter incremented on **every**
  rate-limit denial (HTTP 429), labelled by limiter scope. Unlike the sampled denial *audit*
  (which is flood-gated), this counts all denials, so a spike is the canonical abuse signal.
- **`devresponsekit_rate_limit_shared_fallbacks_total{scope}`** — incremented each time the
  Postgres-backed pre-auth limiter (review #98) could not reach `app_rate_limits` and fell back
  to the in-process bucket for one cool-down. Non-zero means the deployment-wide floors are
  per-instance right now: the database is unhealthy or migration `0006` is not applied; the
  paired `warn` log line carries the error.
- **`devresponsekit_pre_auth_refusals_total{event_type}`** — incremented for every request
  refused before its caller is authenticated (F-15): `administrator.access.denied`,
  `api.access.denied`, `account.access.denied` and `invitation.access.denied` for the CSRF
  origin guard, `sso.consume.failure` for a consume without a verifiable token or a cross-site
  confirm, `sso.launch.failure` for a signed-out launch. These refusals are not in
  `app_audit_events`, so a spike here (with the paired `pre_auth_refusal` log lines) is where a
  cross-origin probe or a garbage-token flood shows up.

**Security model:**

- **Token-guarded, fails closed.** The endpoint requires `Authorization: Bearer <METRICS_TOKEN>`,
  compared in constant time. With `METRICS_TOKEN` unset the route returns `401` and exposes
  nothing — a deployment that forgets to configure it never leaks metric names, route labels,
  or counts. The response is always `no-store`.
- Treat `METRICS_TOKEN` as a secret (scraper-side only) and keep `/api/metrics` reachable only
  from your monitoring network, not the public internet.

**Scraping:** point Prometheus at the route with a bearer credential, e.g.

```yaml
scrape_configs:
  - job_name: devresponsekit
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: "<METRICS_TOKEN>"
    static_configs:
      - targets: ["your-app-host:443"]
```

**Topology note:** counters are **per-process** (like the in-memory rate limiter). Under the
single-instance 1.0 topology that is the whole picture; a multi-instance deployment scrapes each
target independently and aggregates at the Prometheus layer.

## 6. Roadmap — not yet shipped

The signals above cover **logs, errors, audit, health, and a first metrics increment**. The
following are deliberately **not** implemented in 1.0 and are tracked as a post-1.0
observability epic:

- **Metrics — remaining surface.** The endpoint exists (§5) but still lacks the application
  signals: request latency + status by route, database latency, auth failures, outbox
  delivery, and audit-write failures.
- **Distributed tracing** — no OpenTelemetry spans / trace propagation across request → DB →
  external provider.
- **Dashboards & alerting** — no shipped dashboards or alert rules; wire your platform's
  tooling to the log/Sentry streams in the interim.
- **SLOs** — availability, latency, error-rate, auth-failure, and (if email is
  production-critical) delivery-latency objectives are not yet defined.

Until these land, incident detection relies on the log stream, `app_audit_events`, optional
Sentry, and the health probes — see the [troubleshooting runbook](./troubleshooting.md)
for the triage flow and playbooks built on exactly those signals.

---

_Next: [Configuration](./configuration.md) · [Deployment](./deployment.md) · [Troubleshooting](./troubleshooting.md)_
