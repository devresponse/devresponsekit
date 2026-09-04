---
title: Troubleshooting
description: An incident runbook plus a catalog of common setup, build, runtime, and deploy fixes.
group: General
order: 110
---

# Troubleshooting & incident response

_Audience: all technical users and on-call engineers. Two halves: an **incident
runbook** (triage, mitigate, and close out a production incident) and a catalog
of **common failures & fixes** (setup, build, runtime, deployment). For what the
signals *are* and how to wire monitoring (Sentry, metrics, logging), see
[observability.md](./observability.md) — this doc links to it rather than
repeating it._

---

# Part 1 — Incident response runbook

## 1. Severity

| Sev | Meaning | Examples |
| --- | --- | --- |
| **SEV1** | Hard outage / data-integrity / security breach | App down, database unreachable, auth bypass, cross-tenant leak, secret exposure. |
| **SEV2** | Major degradation, no full outage | Elevated 5xx, sign-in failing for many, email not delivering, a deploy that broke a workspace. |
| **SEV3** | Minor / contained | One endpoint erroring, a single tenant affected, abuse from one actor. |

Declare the highest plausible severity first; downgrade once scoped. SEV1/SEV2
warrant a comms channel and an owner before deep debugging.

## 2. First five minutes

1. **Liveness / readiness.** `GET /api/health` → `200 {"status":"ok"}` means the
   process is up. `GET /api/health/ready` → `200` means it can reach the
   database; `503` means it cannot. Both are unauthenticated and `no-store`, so
   a curl from anywhere works.
2. **Get a correlation id.** Reproduce the failure (or take one from a user
   report) and capture the `x-request-id` response header. It is the join key
   across logs, audit rows, and Sentry — see [observability.md §4](./observability.md#4-correlating-an-incident).
3. **Scope the blast radius.** One route, one tenant, one actor — or everything?
   The audit table and the log stream answer this fast (queries below).
4. **Recent change?** Check the last deploy and the last migration. Most SEV1/2
   incidents correlate with a release.

## 3. Triage by signal

- **Logs (structured, stdout):** grep the log stream for the `x-request-id` to
  get the server-side stack + fields. Redaction is automatic (no secrets in logs).
- **`app_audit_events`:** the durable, append-only record of security-relevant
  actions. Outcomes are `success` / `denied` / `error` (`failure` is a
  deprecated alias). Useful event types: `auth.session.created` (a login),
  `administrator.access.denied`, `api.access.denied`, `administrator.rate_limited`.
  ```sql
  -- everything tied to one request
  select created_at, event_type, outcome, actor_better_auth_user_id,
         organization_id, reason, ip_address
  from app_audit_events where request_id = '<x-request-id>' order by created_at;

  -- recent denials/errors, newest first
  select created_at, event_type, outcome, reason, ip_address
  from app_audit_events
  where outcome in ('denied','error','failure') and created_at > now() - interval '1 hour'
  order by created_at desc limit 200;
  ```
- **Sentry (if `NEXT_PUBLIC_SENTRY_DSN` is set):** the same `x-request-id` is a
  tag; events are scrubbed before they leave the app. See [observability.md §3](./observability.md#3-redaction--scrubbing-policy).
- **`app_outbox`:** email delivery state (`pending` / `sent` / `failed` / `logged`).
- **Metrics (if `METRICS_TOKEN` is set):** `devresponsekit_rate_limit_denials_total{scope}`
  is the canonical abuse signal — see [observability.md §5](./observability.md#5-metrics).

## 4. Playbooks

### Database unreachable (`/api/health/ready` → 503)
- Confirm the DB is up and reachable from the app's network/region.
- On serverless, a `503` storm under load usually means **connection
  exhaustion** — verify `DATABASE_URL` points at a **pooled** endpoint and the
  pool ceiling is low. A single stuck statement can no longer pin a connection:
  `statement_timeout` and `idle_in_transaction_session_timeout` are set on the
  pool, so look for the timing-out query in the logs.
- Mitigation: scale the DB / pooler, or roll back a migration that changed a hot
  query plan (§5).

### Elevated 5xx
- Every uncaught 5xx is logged (`onRequestError` → `logServerError`) and, if
  enabled, sent to Sentry — both stamped with the `x-request-id`. Pull a few and
  find the common stack.
- If it started at a deploy, **roll back first, debug second** (§5).

### Sign-in failing for many
- Credential **failures** are not written to `app_audit_events` (only successful
  session creation is, as `auth.session.created`). Look in the **log stream**
  (and Sentry, if enabled) for the auth errors, keyed by `x-request-id`.
- Common causes: `BETTER_AUTH_URL` not matching the public origin (cookies
  rejected), a rotated `BETTER_AUTH_SECRET` (invalidates all sessions — expected
  after rotation), or the DB being unreachable.

### Email not delivering
- `select status, count(*) from app_outbox group by status;` — `failed` rows
  carry a short sanitized `error`. `logged` means no `EMAIL_PROVIDER` is set
  (expected in dev).
- On serverless there is no long-running worker, so retries depend on the cron
  hitting `GET /api/internal/outbox-drain` (gated by `CRON_SECRET`, **fails
  closed** when unset). The bundled `vercel.json` declares a daily Vercel Cron;
  confirm it is firing and the secret is set. On a long-running host, run the
  `pnpm outbox:drain` worker instead.

### Abuse / rate-limit storm
- Rate-limit denials return `429` + `Retry-After` and are recorded (flood-safely,
  ≈1/min/actor/scope) as `administrator.rate_limited` (outcome `denied`) — query
  by `actor_better_auth_user_id` / `ip_address` to find the source. Every denial
  also increments `devresponsekit_rate_limit_denials_total{scope}` (unsampled).
- The limiter is in-memory per instance (single-instance is the supported 1.0
  topology); a process restart resets buckets. A shared (Redis/Postgres) backend
  is post-1.0 — see [deployment.md §5](./deployment.md#5-operations--gotchas).
- CSP violations report to `POST /api/security/csp-report` (rate-limited +
  aggregated); a spike can indicate an injection attempt or a broken third-party
  asset.

### Suspected security incident (auth bypass / cross-tenant / secret exposure)
- Treat as **SEV1**. Preserve evidence — do **not** truncate `app_audit_events`
  (it is append-only). Capture the relevant `request_id`s and IPs.
- If a secret may be exposed, rotate it (`BETTER_AUTH_SECRET`,
  `SSO_HANDOFF_JWT_SECRET`, `API_JWT_PRIVATE_KEY`, provider keys) — rotating the
  auth secret signs everyone out, which is acceptable under a breach. Full
  per-secret steps in [Deployment](./deployment.md).
- **`API_JWT_PRIVATE_KEY` (Ed25519 JWK) — dual-key rotation.** JWKS publishes the
  current and previous public key, so tokens keep verifying during the overlap.
  (1) Move the current key to `API_JWT_PREVIOUS_PRIVATE_KEY` (+
  `API_JWT_PREVIOUS_KID` if you pin a kid). (2) Mint a new key, set it as
  `API_JWT_PRIVATE_KEY` (+ new kid if pinned), redeploy. (3) After the
  access-token TTL (`API_JWT_ACCESS_TTL_SECONDS`, ≤ 1h), drop the previous-key
  vars and redeploy. Under an active breach skip the overlap — rotate and drop the
  previous key at once to invalidate leaked tokens.
  ```bash
  node -e "import('jose').then(async (j) => { const { privateKey } = await j.generateKeyPair('EdDSA', { extractable: true }); process.stdout.write(JSON.stringify(await j.exportJWK(privateKey))) })"
  ```
- Follow the private disclosure process in [SECURITY.md](../SECURITY.md).

## 5. Rollback

Migrations are additive / backward-compatible by contract, so the **previous
build is safe to re-promote against the current schema**. Roll back the **app
build** and leave the additive migrations ahead — **never auto-down-migrate**
(there are no down-migrations, and reverting schema risks data loss).

- **Vercel:** promote the last-known-good deployment (dashboard → previous
  deployment → "Promote to Production", or `vercel rollback`). The deploy
  pipeline ([deployment.md §7](./deployment.md#7-ci)) runs migrations
  *before* promotion, so a rollback needs no DB change.
- **Container:** redeploy the previous (digest-pinned) image tag; keep the prior
  tag available.
- A migration that must be reverted is a separate **forward** migration — never
  edit an applied one.
- Bad **data** (vs. a bad deploy) is recovered via the provider's PITR / snapshot,
  not by reverting schema — see [Deployment](./deployment.md).

## 6. After the incident

- Confirm recovery against the [§4 post-deployment checklist](./deployment.md#4-deploy--post-deploy-verification)
  (health, auth, a DB-backed admin list, an audit row with a matching `x-request-id`).
- The audit log + the correlated `x-request-id`s are the post-incident record;
  write the timeline from them.
- File follow-ups for any missing signal — a metric or trace that didn't exist
  during triage is itself an action item (roadmap in [observability.md §6](./observability.md#6-roadmap--not-yet-shipped)).

---

# Part 2 — Common failures & fixes

_Where to look first: the `pnpm dev` / `pnpm start` terminal (server-component &
route-handler errors, boot validation), browser devtools (client errors and the
`/api/**` status + error envelope), and CI logs for build/test failures. For
production signals — `app_audit_events`, `app_outbox`, `x-request-id`, Sentry —
see Part 1 §3._

## Setup & install

**`pnpm install` fails or uses the wrong pnpm.** Enable Corepack so the pinned
version is used: `corepack enable`, then `pnpm install`. The project pins
`pnpm@10.33.2`.

**`pnpm install` integrity/lockfile errors.** Use `pnpm install --frozen-lockfile`
(as CI does). If the lockfile is genuinely out of date, update dependencies in a
dedicated change.

**Node version errors.** Use Node 22 (what CI runs and what `.nvmrc` +
`package.json` `engines` pin). Point your version manager at `.nvmrc`.

**Postgres won't start / port conflict.** `pnpm db:up` maps host port **5444**
(not 5432). If 5444 is taken, stop the conflicting service or change the mapping
in `docker-compose.yml` and `DATABASE_URL` together.

**App can't connect to the database.**
- Is `pnpm db:up` running and healthy? (`docker compose ps`)
- Does `DATABASE_URL` point at port 5444 with the right credentials (`devresponse:devresponse`)?
- Did you run the migrations (`pnpm db:auth:migrate && pnpm db:app:migrate`)?

**`psql` shows no tables / "relation does not exist".** All tables live in the
**`auth`** schema (default; set by `DB_SCHEMA`), not `public`. A plain `psql`
session defaults to `public` and sees nothing — list with `\dt auth.*` or run
`SET search_path = auth, public;` first. The app sets this via the connection
`search_path`; don't add `?schema=…` to `DATABASE_URL` (it's ignored). Behind a
transaction-pooling pooler the session `search_path` can be dropped — set it as a
role default (`ALTER ROLE <app> SET search_path = auth, public;`).

**Boot fails with a secret/JWK error.** A required secret is missing or malformed:
- `BETTER_AUTH_SECRET` and `SSO_HANDOFF_JWT_SECRET` must be set (and distinct).
- If `API_JWT_ENABLED=1`, `API_JWT_PRIVATE_KEY` must be a valid Ed25519 JWK JSON.
- If `EMAIL_PROVIDER` is set, its credentials must be present.

**Seed does nothing / "already exists".** Seeds are idempotent. To start clean
locally: `pnpm db:reset:reload`.

**`pnpm db:reset` "didn't reset anything".** By design it is a **dry run** (lists
what it would drop). Use `pnpm db:reset:reload` (or `pnpm db:reset --yes`) to
actually drop. It refuses to run against non-local hosts without `--force`.

## Build errors

**Type errors during `pnpm build` / `pnpm typecheck`.** Strict TypeScript with
`noUncheckedIndexedAccess` — indexed access yields `T | undefined`. Guard or
assert. Fix all errors; the build must be clean.

**`format:check` fails in CI but the code "looks fine".** Run `pnpm format` to
auto-fix, then commit. Bracketed glob paths (e.g. `src/app/[locale]/**`) can
silently match nothing in some shells — let `prettier .` / `pnpm format` handle
the whole tree.

**Build log looks truncated / build seems to hang.** Don't pipe `pnpm build`
through `head`/`Select -First` — truncating its stdout can break the run.
Redirect to a file: `pnpm build > build.log 2>&1`.

**Sentry-related build differences.** The Sentry plugin engages only when
`NEXT_PUBLIC_SENTRY_DSN` is set; source-map upload also needs `SENTRY_AUTH_TOKEN`.
A build without these is unchanged — see [observability.md §2](./observability.md#2-configuration).

## Runtime errors

**Redirected to sign-in unexpectedly.** The edge proxy redirects when no session
cookie is present. Confirm `BETTER_AUTH_URL` matches the origin you're browsing
and that the session cookie is set (devtools → Application → Cookies).

**Stuck on "pending approval".** Under the platform-default sign-up policy,
self-registered users start `pending_approval`; an admin must approve them
(Administrator → Users), or seed an already-active account. Alternatively the
organization's **Authentication** tab can switch to auto-active or auto-approve
verified email domains (re-evaluated at the user's next sign-in), or you can
**invite** the user — an accepted invitation activates the account outright. See
[Sign-up Policy](./auth-signup-policy.md).

**`403` / `404` on an admin action you expected to succeed.** Tenant scoping: a
non-super-admin only sees their own organization, and **out-of-scope resources
return 404 by design** (not 403). Confirm the actor's tier and the resource's
organization.

**`429 Too Many Requests`.** The per-actor rate limiter tripped (admin mutations,
bulk ops, or export). Respect the `Retry-After` header. The limiter is in-memory
and resets on restart; across multiple instances it's best-effort.

**Locale parity test or a missing translation.** Every text key must exist in all
eight locale files. Add the key to `en.json` first, then `fr`/`es`/`uk`/`pt`/`zh`/`hi`/`ja`.

**Email not being delivered.** With no `EMAIL_PROVIDER`, messages are recorded as
`logged` and never sent — expected in dev. Set a provider and its credentials to
deliver; check `app_outbox` for `failed` rows and the recorded error (see the
incident playbook in Part 1 §4 for the serverless drain cron).

**The reset / invite link in the outbox reads `[redacted]`.** By design (review
#21): the administrator outbox stores a redacted body so an org admin can never
lift a co-member's live one-time link. Locally, read the DB-only
`app_outbox.delivery_payload` column instead — see
[Developer onboarding §9.4](./developer-onboarding.md#94-email-in-dev).

**SSO handoff fails.**
- The token is single-use and valid ≤60s (the signer clamps any larger
  `SSO_HANDOFF_TTL_SECONDS` down to 60) — a reused or expired token is rejected.
- `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_AUDIENCE_PREFIX`, and `SSO_HANDOFF_JWT_SECRET`
  must match between hub and receiver; the receiver's `SSO_HANDOFF_APPLICATION_ID`
  must match the audience.
- The destination origin must fall under `SSO_ALLOWED_ORIGIN_SUFFIXES`.

**Machine API returns 401/403.**
- Is the path enabled? `API_KEYS_ENABLED` / `API_JWT_ENABLED` are **off by default**.
- Is the credential's scope sufficient, and within the owner's permissions? A
  credential can't exceed its creator.
- For JWTs, is the token unexpired and verifiable against `/api/v1/jwks.json`?

## Test failures

**Spurious "… is not a function" from Vitest.** Use the sharded runner `pnpm test`,
not a single `vitest run` — see [Testing → sharded runner](./testing.md#why-the-sharded-runner).

**Coverage gate fails though all tests pass.** New untested code dropped global
coverage below the ratchet. Add tests; reproduce locally with `pnpm test:coverage`
(the sharded `pnpm test` does **not** compute coverage).

**Playwright suites fail to start.** They need a built, running, seeded app and
installed browsers: `pnpm playwright install --with-deps`, migrate + seed,
`pnpm build && pnpm start`, then `pnpm test:e2e`. CI also sets
`AUTH_RATE_LIMIT_DISABLED=1`.

## Deployment issues

**App up but every DB call fails on a serverless host.** Use a **pooled** Postgres
endpoint in `DATABASE_URL`; a direct connection can exhaust connections under
serverless concurrency.

**Migrations not applied / schema missing.** Run `pnpm db:auth:migrate && pnpm
db:app:migrate` against the target **before** routing traffic. The migrate step
**creates the `auth` schema** (or whatever `DB_SCHEMA` is) automatically and
provisions every table — you don't create the schema by hand. Migrations are
idempotent (ledgered in `app_schema_migrations`) and safe to re-run; the deploy
pipeline applies them against the **direct** (non-pooled) endpoint before
promotion.

**HSTS/headers not present or mixed-content warnings.** Terminate TLS upstream;
HSTS is inert over plain HTTP. Confirm the proxy forwards the headers emitted by
`next.config.mjs`.

**Wrong client IP in rate limiting / logs behind a CDN.** Set
`TRUSTED_PROXY_COUNT` to your actual proxy depth so the client IP is read
correctly from `X-Forwarded-For`.

**Rate limits behave inconsistently across instances.** The limiter is in-process
per instance, so the **supported 1.0 topology is a single application instance**
(see [deployment.md §5](./deployment.md#5-operations--gotchas)). Multi-instance still
runs, but the limit is best-effort per instance until a shared (Redis/Postgres)
backend lands post-1.0.

**Audit / outbox tables growing without bound.** Schedule **`pnpm db:prune`**
(`scripts/prune-retention.ts`) to apply `AUDIT_RETENTION_DAYS` (default 365) and
`OUTBOX_RETENTION_DAYS` (default 90) and prune expired token revocations — see
[Deployment](./deployment.md).

## Known risks & missing information

- **In-memory rate limiting / metrics** — neither is shared across instances; the
  supported 1.0 topology is a single application instance. A shared backend for
  horizontal scale is planned post-1.0 (see [deployment.md §5](./deployment.md#5-operations--gotchas)).
- **CSP is enforcing** (nonce-based, minted per request in `src/proxy.ts`).
  `script-src` allows only `'self' 'nonce-…' 'strict-dynamic'` — an injected
  inline `<script>` is blocked, not just reported. `style-src` keeps
  `'unsafe-inline'` (a nonce can't cover React's inline `style` attributes).
- **`pgvector`/`vector` extension** is enabled locally; confirm whether production
  needs it (`pg_trgm` definitely is required).
- Some API request/response shapes were summarized from structure — verify against
  handlers or `/api/v1/openapi.json` (see [API → source of truth](./api.md#10-source-of-truth--keeping-clients-in-sync)).

If a problem isn't covered here, capture the `x-request-id` from the failing
response and correlate it across the server logs, `app_audit_events`, and Sentry.

---

_Related: [Observability](./observability.md) · [Deployment](./deployment.md) · back to the [documentation index](./README.md)._
