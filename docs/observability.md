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
| **Request-id correlation** | `src/lib/admin/request-id.server.ts` (`getOrCreateRequestId`) | Accepts a valid inbound `x-request-id` (UUID) or mints one. Echoed on every admin (`adminErrorResponse`) and RFC 7807 (`problemResponse`) error response. |
| **Audit events** | `src/lib/audit.server.ts` → `app_audit_events` | Durable record of security-relevant actions (auth, admin mutations, SSO, token mint/revoke, exports), each stamped with the request id. Append-only; retention is an ops concern — see the note below. |
| **CSP violation sink** | `POST /api/security/csp-report` | The enforcing CSP (`src/proxy.ts`) reports blocks here; rate-limited + aggregated per directive. |
| **Metrics (opt-in)** | `GET /api/metrics`, `src/lib/observability/metrics.server.ts` | Prometheus text exposition: Node process defaults (heap, RSS, event-loop lag, GC, CPU) + the `…_rate_limit_denials_total{scope}` business counter. Token-guarded (`METRICS_TOKEN`), **fails closed**. First increment — see [§5 Metrics](#5-metrics). |
| **Error monitoring (opt-in)** | `src/sentry.{server,edge}.config.ts`, `src/instrumentation-client.ts` (browser init), `src/lib/observability/sentry-shared.ts` | Sentry engages only when `NEXT_PUBLIC_SENTRY_DSN` is set. Errors, transactions, and spans are all scrubbed (cookies, query strings, emails, tokens, secret-like values) before they leave the process — see [§3](#3-redaction--scrubbing-policy). |
| **Liveness / readiness** | `GET /api/health`, `GET /api/health/ready` | Unauthenticated, `no-store`. `/ready` returns `200` when the database is reachable, `503` otherwise. Wire both to your orchestrator probes (see [deployment.md §4](./deployment.md#4-deploy--post-deploy-verification) and [docker.md §7](./docker.md)). |
| **Process-fault handlers** | `src/lib/process-errors.server.ts` | `unhandledRejection` / `uncaughtException` are logged (not swallowed) so a crashing worker is visible in the log stream. |

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
  **every event kind**: error events (`beforeSend`), sampled **transactions**
  (`beforeSendTransaction`), and their **spans** (`beforeSendSpan`) — including the
  root-span attributes in `contexts.trace.data` and each `spans[].data` (`url.full`,
  `url.query`, `http.request.header.*`, …), span descriptions, and the transaction name.
  The **client IP** is treated as user info and never sent: the IP-bearing proxy headers
  the app itself reads for rate limiting (`x-forwarded-for`, `x-real-ip`,
  `cf-connecting-ip`, `true-client-ip`, `x-vercel-forwarded-for`, `forwarded`, `via`, …)
  are denied at write time and dropped by the hooks, as are the `http.client_ip` /
  `user.ip_address` / `client.address` span attributes the Node HTTP instrumentation sets.
  Reset URLs (`/reset-password/<token>`) and other one-time tokens are never sent. The SDK
  is also told not to _record_ cookies, query parameters, bodies, or user info in the first
  place (`dataCollection` in all three `Sentry.init` calls — this **replaces** the
  deprecated `sendDefaultPii: false` bridge, so every deny list it used to apply is spelled
  out explicitly); the hooks are the backstop (review #22).
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
   action that triggered it.
4. If Sentry is enabled, the event carries the id as a tag for a fourth view with breadcrumbs.

If a caller supplies their own valid `x-request-id`, it is preserved end-to-end, so a
client-side trace id flows straight into server logs and audit rows.

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
