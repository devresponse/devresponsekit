# Observability — Errors, Tracing & Web Vitals (Sentry)

This document describes the optional observability integration:
**Sentry** for client + server error tracking, performance tracing, Core
Web Vitals, and masked session replay — wired into the application's
existing `x-request-id` correlation id.

The whole feature is **opt-in and disabled by default**. With no DSN
configured, the Sentry SDK initializes as a no-op (nothing is captured or
sent) and the production build is byte-for-byte unchanged. You enable it
per deployment by setting environment variables — no code change.

All file paths below are real artifacts in this repository.

---

## Table of contents

1. [What it captures](#1-what-it-captures)
2. [The big idea: one correlation id end-to-end](#2-the-big-idea-one-correlation-id-end-to-end)
3. [Architecture & files](#3-architecture--files)
4. [Enabling it (environment variables)](#4-enabling-it-environment-variables)
5. [Privacy & PII posture](#5-privacy--pii-posture)
6. [Deployment notes (Vercel, Docker, source maps)](#6-deployment-notes-vercel-docker-source-maps)
7. [Verifying it works](#7-verifying-it-works)
8. [Relationship to the audit log](#8-relationship-to-the-audit-log)

---

## 1. What it captures

| Capability | Where | Notes |
| --- | --- | --- |
| **Errors (client)** | browser SDK | Unhandled exceptions, promise rejections, and React render crashes (via the error boundaries in §3). |
| **Errors (server/edge)** | `instrumentation.ts` `onRequestError` | RSC, route handlers, and server actions — tagged with `request_id`. |
| **Tracing** | client + server | Route / navigation / server spans. Sample-rate controlled. |
| **Web Vitals** | browser tracing | LCP / INP / CLS collected automatically by `browserTracingIntegration`. |
| **Masked session replay** | browser SDK | All text **and** inputs masked, media blocked. By default only sessions that hit an error are recorded. |

It is the concrete implementation of the error boundary referenced in
[admin-manager.md §12](admin-manager.md) — broadened to cover every
authenticated workspace, not only the administrator app.

## 2. The big idea: one correlation id end-to-end

The app already mints a per-request `x-request-id`
([`request-id.server.ts`](../src/lib/admin/request-id.server.ts)), echoes
it in response headers and error bodies, and stamps it into every
[`app_audit_events`](../src/db/migrations/0001-initial-schema.sql) row.
The Sentry integration threads that **same id** through telemetry, so a
single value ties four things together:

```
   Browser                         Server                        Stores
   ───────                         ──────                        ──────
 UI error boundary  ──capture──►  Sentry event (tag request_id=R)
   shows "Support ID"                    ▲
        │                                │ onRequestError stamps R
 failed fetch ──► response (x-request-id: R, body.requestId: R)
        │                                ├──►  app_audit_events.request_id = R
        └── captureClientError(tag request_id=R) ──► Sentry event
```

A user reports **Support ID `R`** → you jump straight from the Sentry
issue to the exact audit row and server logs. The id is generated whether
or not Sentry is enabled, so this costs nothing when the feature is off.

- Server errors: stamped in
  [`instrumentation.ts`](../src/instrumentation.ts) `onRequestError`.
- Client fetch failures (5xx / network): captured with the response's
  request id by
  [`captureClientError`](../src/lib/observability/client.ts), wired into
  the admin data grid
  ([`use-grid-state.ts`](../src/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-state.ts)).
  Expected 4xx (401/403/404/409) are **not** reported — they are normal
  auth/validation flow, not incidents.
- Render crashes: the error boundary surfaces the Sentry **event id** as
  the user-visible Support ID.

## 3. Architecture & files

| File | Role |
| --- | --- |
| [`src/instrumentation.ts`](../src/instrumentation.ts) | Server `register()` (loads Node/Edge config) + `onRequestError` with `request_id` tagging. |
| [`src/instrumentation-client.ts`](../src/instrumentation-client.ts) | Browser `Sentry.init` — tracing + Web Vitals + masked replay — and `onRouterTransitionStart`. |
| [`src/sentry.server.config.ts`](../src/sentry.server.config.ts) / [`sentry.edge.config.ts`](../src/sentry.edge.config.ts) | Runtime inits; opt-in via DSN. |
| [`src/lib/observability/sentry-shared.ts`](../src/lib/observability/sentry-shared.ts) | Isomorphic helpers: sample-rate parsing + the `beforeSend` PII scrubber. |
| [`src/lib/observability/client.ts`](../src/lib/observability/client.ts) | `captureClientError` / `requestIdFromResponse` for client call sites. |
| [`src/components/observability/route-error.tsx`](../src/components/observability/route-error.tsx) | Shared localized error fallback (captures + shows Support ID). |
| [`src/app/[locale]/(secure)/app/error.tsx`](../src/app/[locale]/(secure)/app/error.tsx) | Error boundary for the whole authenticated app subtree. |
| [`src/app/global-error.tsx`](../src/app/global-error.tsx) | Last-resort root boundary (outside i18n; English-only). |
| [`next.config.mjs`](../next.config.mjs) | `withSentryConfig` wrap — **only** applied when a DSN is set. |

Every `Sentry.*` call is a no-op when the SDK is disabled, so call sites
stay unconditional.

## 4. Enabling it (environment variables)

The presence of **`NEXT_PUBLIC_SENTRY_DSN`** is the master switch: it
enables the runtime SDKs *and* the build-time source-map plugin. All
variables are documented in [`.env.example`](../.env.example).

| Variable | Required | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | to enable | Client DSN; its presence turns the feature on. |
| `SENTRY_DSN` | optional | Server DSN; defaults to `NEXT_PUBLIC_SENTRY_DSN`. |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` / `SENTRY_ENVIRONMENT` | optional | Defaults to `NODE_ENV`. |
| `NEXT_PUBLIC_SENTRY_RELEASE` | optional | Release tag (e.g. the git SHA). |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` / `SENTRY_TRACES_SAMPLE_RATE` | optional | `[0,1]`, default `0.1`. Client value also governs Web Vitals. |
| `NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE` | optional | `[0,1]`, default `0` (no clean-session replays). |
| `NEXT_PUBLIC_SENTRY_REPLAYS_ERROR_SAMPLE_RATE` | optional | `[0,1]`, default `1` (replay every errored session). |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | optional | Build/CI only — enable **source-map upload** (see §6). Never expose the auth token to the client. |

Minimal production enablement:

```bash
NEXT_PUBLIC_SENTRY_DSN="https://<key>@<org>.ingest.sentry.io/<project>"
NEXT_PUBLIC_SENTRY_ENVIRONMENT="production"
# tracing/replay use sane defaults; tune the sample rates as needed
```

## 5. Privacy & PII posture

This is a first-party auth / multi-tenant app (with `uk`/`fr`/`es`
locales — i.e. GDPR users), so the integration is conservative by
default:

- `sendDefaultPii: false` on every runtime.
- A `beforeSend` scrubber
  ([`sentry-shared.ts`](../src/lib/observability/sentry-shared.ts))
  strips request cookies, `Authorization`/`Cookie`/`x-api-key` headers,
  the query string (may carry tokens, emails, SSO handoff JWTs), and any
  `user.email` / `ip_address` / `username`.
- Session replay masks **all** text and inputs and blocks media, and
  records clean sessions at `0%` by default.
- This mirrors the existing rule that secrets never reach logs
  (setup-better-auth.md §7) — extend the same discipline to any custom
  `captureMessage`/`setContext` you add.

## 6. Deployment notes (Vercel, Docker, source maps)

- **Vercel:** set the env vars in Project → Environment Variables, scoped
  per environment. Add `SENTRY_AUTH_TOKEN` (+ `SENTRY_ORG`/`SENTRY_PROJECT`)
  as a **build** secret to get readable (un-minified) stack traces.
- **Docker / self-hosted:** the same SDK works; point the DSN at Sentry
  SaaS **or** a self-hosted Sentry / GlitchTip instance. The
  `@sentry/cli` package's post-install build script is ignored by pnpm by
  default — only needed for source-map upload, so approve it
  (`pnpm approve-builds`) in the CI image if you upload maps.
- **Source maps:** without `SENTRY_AUTH_TOKEN` the build plugin still runs
  but **skips upload** (`sourcemaps.disable`), so traces remain minified —
  fine for a first rollout. Add the token when you want symbolicated
  traces. Maps are not committed (`.gitignore`).
- **No DSN:** the build skips `withSentryConfig` entirely, so CI and
  preview builds without Sentry secrets are unaffected.

## 7. Verifying it works

1. Set `NEXT_PUBLIC_SENTRY_DSN` and run `pnpm build && pnpm start`.
2. **Errors:** trigger a render error in a secure page → the localized
   fallback shows a **Support ID**, and a matching issue appears in
   Sentry tagged with `request_id`.
3. **Server errors:** a route that throws produces a Sentry issue whose
   `request_id` tag equals the `x-request-id` response header and the
   `app_audit_events.request_id` row.
4. **Web Vitals / tracing:** navigate a few pages → transactions with
   LCP/INP/CLS appear under Performance.
5. **Replay:** with an error present, a masked replay attaches to the
   issue (all text shown as blocks).
6. **Off path:** unset the DSN, rebuild — no Sentry network calls, no
   behavior change.

## 8. Relationship to the audit log

Sentry does **not** replace [`app_audit_events`](../src/lib/audit.server.ts).
They are complementary:

- **Audit log** = durable, first-party record of *who did what*
  (security/compliance). Stays in your Postgres.
- **Sentry** = operational telemetry: *what broke and how fast it runs*
  (errors, traces, Web Vitals, replay).

The shared `request_id` is the join key between them. If you need a
fully first-party alternative to Sentry, the same correlation id and the
audit pattern let you sink client events to your own endpoint instead —
at the cost of building dashboards yourself.

---

**References**

- Sentry Next.js SDK: <https://docs.sentry.io/platforms/javascript/guides/nextjs/>
- Correlation id: [`src/lib/admin/request-id.server.ts`](../src/lib/admin/request-id.server.ts)
- Audit log: [`src/lib/audit.server.ts`](../src/lib/audit.server.ts)
- Env template: [`.env.example`](../.env.example)
