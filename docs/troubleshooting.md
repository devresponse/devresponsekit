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
   process is up. `GET /api/health/ready` → `200` means its environment is
   valid, it can reach the database, the schema carries every core migration
   this build needs **and** Better Auth's own schema check passes; `503`
   carries a `reason`: `config_invalid`, `database_unreachable` or
   `schema_behind` (a build went live ahead of its migration — see §4). A
   500 from both probes on a fresh deployment is an invalid environment: the
   boot hook refused it (§4, Config invalid). Both are unauthenticated and
   `no-store`, so a curl from anywhere works.
2. **Get a correlation id.** Reproduce the failure (or take one from a user
   report) and capture the `x-request-id` response header. It is the join key
   across logs, audit rows, and Sentry — see [observability.md §4](./observability.md#4-correlating-an-incident).
   Every admin, `/api/v1` and first-party API response carries it: successes,
   error envelopes, and the `500 internal_error` a failing handler answers
   (the body's `requestId` is the same value). A page render does not; for a
   page error the user can quote the Support ID instead, which is the Sentry
   event id when the browser SDK is enabled (`NEXT_PUBLIC_SENTRY_DSN` set;
   otherwise Next's error digest), not a request id. A digest is in the log
   stream: the `route.unhandled_error` line carries it as `err.digest` (F-110).
3. **Scope the blast radius.** One route, one tenant, one actor — or everything?
   The audit table and the log stream answer this fast (queries below).
4. **Recent change?** Check the last deploy and the last migration. Most SEV1/2
   incidents correlate with a release.

## 3. Triage by signal

- **Logs (structured, stdout):** grep the log stream for the `x-request-id` (or,
  for a page error, the digest) to get the server-side stack + fields.
  Redaction is automatic (no secrets in logs).
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
- **Refusals before sign-in are in the logs, not the table.** A request refused
  before its caller is authenticated — a cross-site cookie mutation
  (`untrusted_origin` / `missing_origin`), an SSO consume with no token or one
  that fails verification, a signed-out SSO launch, a failed email/password
  sign-in (`auth.sign_in.failed`, F-55) — writes no audit row (F-15).
  Grep the log stream for `"kind":"pre_auth_refusal"` (the `eventType` and
  `reason` fields match what the row used to carry); a handoff token that
  verified but was refused afterwards (`target_application_mismatch`,
  `nonce_replay`, `nonce_expired`, `nonce_unknown`) is still audited.
- **Metrics (if `METRICS_TOKEN` is set):** `devresponsekit_rate_limit_denials_total{scope}`
  is the canonical abuse signal, and `devresponsekit_pre_auth_refusals_total{event_type}`
  counts the pre-authentication refusals above — see [observability.md §5](./observability.md#5-metrics).

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

### Schema behind (`/api/health/ready` → 503 `schema_behind`)
- The server log says which half is behind; the response deliberately says
  neither.
- **`kind: "schema-behind"`** — the running build depends on a core migration
  the database has not recorded in `app_schema_migrations` (the log lists the
  ids). Symptoms before anyone looks at the probe: 500s confined to the
  routes that touch the new column/table — e.g. every `/api/v1` call bearing
  an OAuth-client JWT and admin secret rotation when migration 0004
  (`0004-oauth-client-secret-rotated-at.sql`, now a section of
  `0002-release.sql`) is missing (review #43). Fix
  forward, not back: run `pnpm db:app:migrate` against the production
  `DATABASE_URL` (migrations are additive and idempotent), then re-curl
  `/api/health/ready` for `200`. Rolling the app back also works (the older
  build does not read the column) but leaves the gap for the next deploy.
  A database migrated before the 2026-09-30 consolidation is not behind for
  lacking the `0002-release.sql` row: readiness counts its rows `0002-…`
  through `0008-…` as that file. With only some of those rows it is behind,
  and the log names `0002-release.sql`: bring it to `0008` from commit
  `79b4803` first ([deployment.md](./deployment.md#upgrading-a-database-from-before-the-consolidation)).
- **`kind: "auth-schema-behind"`** (F-26) — Better Auth's own schema check
  found a table or column its configuration writes missing (the log's
  `findings` list them, e.g. `{"kind":"missing-table","table":"rateLimit"}`).
  Symptoms: a 500 on **every**
  `/api/auth/*` call and every page or route that reads the session, because
  Better Auth refuses all of them until the schema matches. Run
  `pnpm db:auth:migrate` against the production `DATABASE_URL`, then
  **redeploy or restart**: Better Auth keeps its "mismatch" verdict for the
  life of the process, so an instance that already saw the gap keeps failing
  auth, and keeps answering `schema_behind`, after the database is fixed. New
  instances start clean. Re-curl `/api/health/ready` for `200`.
- Root cause is the deploy path: see [deployment.md §1.1](./deployment.md#11-the-live-path-vercel-git-integration-automated-migrations-schema-gate)
  — Vercel's git integration builds every push to `main` and cannot migrate,
  so a migration must be applied to production before its build goes live:
  by `migrate-production.yml` on the same push, or by hand while that is not
  configured. That includes a change to
  `src/db/migrations/better-auth-schema.sql`. Since
  DEP1 every production build runs a schema gate that holds such a build back
  instead ([Production build failed at `[deploy-gate]`](#production-build-failed-at-deploy-gate)),
  so this 503 means a deployment reached production without a passing gate:
  a preview deployment promoted to production, a build from before the gate,
  or a host with no gate (the Docker image).

### Config invalid (`/api/health/ready` → 503 `config_invalid`, or 500 everywhere)
- F-26: the environment is validated when the server starts. On `next start`
  and the Docker image the process exits with code 1 and the log reads
  `An error occurred while loading instrumentation hook: Invalid server
  environment variables: NAME (rule); …`. On Vercel the same line is in the
  function log and every server-rendered page and API route answers 500,
  both health probes included.
- Where the server did start, readiness answers `503 config_invalid` and
  logs only the variable names (`kind: "config-invalid"`). The same reason
  covers a Better Auth that refused its configuration at initialisation
  (logged with its error).
- Fix the named variables (rules: [Configuration §1](./configuration.md#1-how-configuration-is-loaded)),
  then redeploy — on Vercel a changed variable reaches only new deployments.

### Elevated 5xx
- Server faults are logged and, if enabled, sent to Sentry. On the admin, `/api/v1`
  and first-party API routes a handler that throws is logged as
  `admin.internal_error` / `v1.internal_error` under the `x-request-id` its
  `500` response carries (F-29); on the MCP transport and registration,
  `mcp.internal_error` / `mcp.register.internal_error` (A-12). A fault outside them (a page render, a server
  action, an exempt route) goes through `onRequestError` → `logServerError`,
  tagged with a request id only when the caller sent one that was honoured.
  That `route.unhandled_error` line names the failing route's file pattern
  and type (`routePath`, `routeType`) and, for a render error, Next's digest
  (`err.digest`), so group by `routePath` to see which pages fail (F-110).
  Pull a few and find the common stack.
- If it started at a deploy, **roll back first, debug second** (§5).
- **Every** route 5xx-ing at once, with `Invalid server environment variables:`
  in the log, is a variable `getServerEnv()` refuses. Since F-26 the boot hook
  refuses it at startup, so the line is prefixed with `An error occurred while
  loading instrumentation hook:` (see Config invalid above). Each variable is
  listed with the rule it broke. An origin rule, such as a scheme typo or `http://` in
  production, is covered under "Boot fails on an origin-valued variable" in
  Part 2 (Setup & install). `Invalid server environment variables:
  API_JWT_ISSUER (must be unset or identical to BETTER_AUTH_URL …)` is the MCP discovery gate (review #57):
  `MCP_ENABLED` is on and `API_JWT_ISSUER` is not the same identifier as
  `BETTER_AUTH_URL`, so the deployment fails at startup. Unset
  `API_JWT_ISSUER` (or set it equal to `BETTER_AUTH_URL`), or clear
  `MCP_ENABLED` if the gateway is not in use, then redeploy. See
  [Deployment §3](./deployment.md#3-vercel-project--environment) for the
  pre-deploy check that prevents it.

### Sign-in failing for many
- Credential **failures** are not written to `app_audit_events` (only successful
  session creation is, as `auth.session.created`): the caller is unverified, so
  an anonymous loop must not grow the append-only table (F-15). Each failed
  `/api/auth/sign-in/email` logs one `"kind":"pre_auth_refusal"` line with
  `"eventType":"auth.sign_in.failed"` instead (F-55), counted in
  `devresponsekit_pre_auth_refusals_total{event_type="auth.sign_in.failed"}`.
  Its `reason` is Better Auth's code: `INVALID_EMAIL_OR_PASSWORD` (wrong
  password or unknown address), `INVALID_EMAIL` (not an email address),
  `EMAIL_NOT_VERIFIED`, `BANNED_USER`, `VALIDATION_ERROR` (a malformed body),
  or `rate_limited` for the per-account budget below. A
  spike of `INVALID_EMAIL_OR_PASSWORD` across many `emailHash` values is
  credential stuffing; many on one `emailHash` is a run against one account.
- The line never carries the address or the client IP. `metadata.emailHash` is
  HMAC-SHA256 keyed with `BETTER_AUTH_SECRET` over `sign-in-email:` plus the
  lower-cased address, so only someone holding the secret can tie it to an
  account. To find one user's failures, compute it on a machine that has the
  secret and grep for the result:
  `node -e 'const c=require("crypto");console.log(c.createHmac("sha256",process.env.BETTER_AUTH_SECRET).update("sign-in-email:"+process.argv[1].toLowerCase()).digest("hex"))' user@example.com`.
  Rotating the secret changes every digest. The source IP is in the edge's
  access log, matched by time and path.
- Common causes: `BETTER_AUTH_URL` not matching the public origin (cookies
  rejected), a rotated `BETTER_AUTH_SECRET` (invalidates all sessions — expected
  after rotation), or the DB being unreachable.

### Email not delivering
- Search the log stream for `kind: "email_delivery"` (F-27). Every failed
  delivery, inline or retried, logs one line with its `outcome`, `reason`,
  `template`, `provider`, `providerStatus` and `outboxId`: `error` level when
  it will never be delivered, `warn` when the worker will retry it. The
  line has the status, not the provider's reason: look the row up by
  `outboxId` and read its sanitized `error`, which holds the provider's
  own response and tells the causes below apart. With Resend, a
  `provider_rejected` 403 on every template is either `EMAIL_FROM` on a
  domain Resend has not verified or an invalid API key; 401 is a missing or
  restricted key; 422 is a request Resend refused as malformed (a malformed
  `EMAIL_FROM` is one).
  `devresponsekit_outbox_delivery_total` counts the same outcomes if you
  scrape `/api/metrics`, except the drain worker's when it runs as
  `pnpm outbox:drain`: that is a separate process, so read its log lines and
  its `[outbox] … expired=…` summary instead (see
  [observability.md §5](./observability.md#5-metrics)).
- `select status, count(*) from app_outbox group by status;` — `failed` rows
  carry a short sanitized `error`. `logged` means no `EMAIL_PROVIDER` is set
  (expected in dev).
- On serverless there is no long-running worker, so retries depend on the cron
  hitting `GET /api/internal/outbox-drain` (gated by `CRON_SECRET`, **fails
  closed** when unset). The bundled `vercel.json` declares a daily Vercel Cron;
  confirm it is firing and the secret is set. On a long-running host, run the
  `pnpm outbox:drain` worker instead.

### Agents console full of stale pending registrations
- The reaper has not run: on Vercel confirm the daily
  `GET /api/internal/mcp-registration-reap` cron in `vercel.json` is firing and
  `CRON_SECRET` is set (the route **fails closed** without it); elsewhere
  schedule `pnpm mcp:reap`. `MCP_REGISTRATION_PENDING_TTL_DAYS=0` disables the
  sweep. Expired agents move to the **Revoked** filter; the **Pending** filter
  (and its badge) shows only what still needs a decision.
- The backlog is bigger than one tick: the cron route stops starting batches
  after 40 seconds and logs `drained: false`, and the next daily tick continues
  (F-75). To clear it at once, run `pnpm mcp:reap`, which has no time limit;
  it is safe beside a running tick, since each pass skips the rows the other
  has locked and takes the next ones.
- Each expired agent has an `mcp.client.expired` audit row (no actor, `reason`
  `mcp_registration_expired`), which tells an expiry apart from an admin's
  `admin.mcp_agent.revoked` (F-79).

### Abuse / rate-limit storm
- Rate-limit denials return `429` + `Retry-After` and are recorded (flood-safely,
  ≈1/min/actor/scope) as `administrator.rate_limited` (outcome `denied`) — query
  by `actor_better_auth_user_id` / `ip_address` to find the source. Every denial
  also increments `devresponsekit_rate_limit_denials_total{scope}` (unsampled).
- Which store a 429 came from depends on the route. The pre-auth floors and the
  admin mail budgets keep one budget in Postgres across every instance and
  restart; only the authenticated per-actor and per-credential buckets (admin
  mutations, the v1, account and preference self-service routes, MCP tool calls;
  `src/lib/http/rate-limit.server.ts`) are in-memory per instance and reset on
  restart. Multi-instance (Vercel) is a supported topology: see
  [deployment.md §5](./deployment.md#5-operations--gotchas), the one statement of
  which limiter lives where (F-107).
- Sign-in / password-reset floods hit Better Auth's built-in limiter (3 req / 10 s
  and 3 req / 60 s per client IP) on `/api/auth/*`. It keys on the same client IP
  as the app's limiters — the app-derived `x-drk-client-ip`, read from the header
  `CLIENT_IP_SOURCE` names (by default `TRUSTED_PROXY_COUNT` hops from the right of
  `X-Forwarded-For`), stamped by the proxy and re-derived in the route handler
  (review #35), with an IPv6 client grouped by its /64 in both (F-16). A client
  can neither inject that header nor pick another user's bucket, **provided the
  edge overwrites the header the source names**. With no proxy in front, or behind
  a proxy that only sets `X-Real-IP` while `CLIENT_IP_SOURCE` is still `xff`, a
  client sends its own `X-Forwarded-For` and gets a fresh bucket per request, so
  the sign-in limiter stops nothing (F-17). A flood of sign-ins whose sessions or
  audit rows each show a different address is the sign; fix the edge as in
  [Choosing the client-IP source](./configuration.md#choosing-the-client-ip-source).
  **If every user is rate-limited at once**, your edge is
  misconfigured: `TRUSTED_PROXY_COUNT` is too shallow (one inner-proxy IP for
  everyone), the edge sets no `X-Forwarded-For` / `X-Real-IP` at all, or
  `CLIENT_IP_SOURCE` names a header the edge does not set (shared
  `no-trusted-ip` bucket) — see [Deployment issues](#deployment-issues); do not
  disable the limiter (`AUTH_RATE_LIMIT_DISABLED` is refused in production).
- Email/password sign-in also has a **per-account** budget (F-55): 10 attempts
  per address per 15 minutes, a token back every 90 s, whatever IP they come
  from, in the shared `app_rate_limits` table (scope `auth.signin.email`, keyed
  on the same `emailHash` as the log line). Its 429 is identical to Better
  Auth's per-IP one, counted in
  `devresponsekit_rate_limit_denials_total{scope="auth.signin.email"}` and
  logged as `auth.sign_in.failed` with reason `rate_limited`. It is a throttle,
  not a lockout: nothing needs unlocking, and an account under attack gets its
  full budget back within 15 minutes of the attack stopping. While a run is
  under way its owner may see "Too many requests" too; the fix is the source
  (block it at the edge), not the limit. It follows the same switch as Better
  Auth's limiter.
- CSP violations report to `POST /api/security/csp-report` (rate-limited +
  aggregated); a spike can indicate an injection attempt or a broken third-party
  asset.

### Suspected security incident (auth bypass / cross-tenant / secret exposure)
- Treat as **SEV1**. Preserve evidence — do **not** truncate `app_audit_events`
  (it is append-only). Capture the relevant `request_id`s and IPs.
- If a secret may be exposed, rotate it (`BETTER_AUTH_SECRET`,
  `SSO_HANDOFF_PRIVATE_KEY`, `API_JWT_PRIVATE_KEY`, provider keys) — rotating the
  auth secret signs everyone out, which is acceptable under a breach. Full
  per-secret steps in [Deployment](./deployment.md).
- **`SSO_HANDOFF_PRIVATE_KEY` (Ed25519 JWK) — dual-key rotation, issuer only.**
  Same mechanics as the API key below via `SSO_HANDOFF_PREVIOUS_PRIVATE_KEY`;
  satellites hold no key and need no change (they refetch
  `/api/sso/jwks.json` on an unknown `kid`). The overlap only needs to cover
  the ≤60s token lifetime.
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
  deployment → "Promote to Production", or `vercel promote <deployment>`).
  Prefer that to `vercel rollback`: after an Instant Rollback Vercel stops
  assigning production domains to new deployments until one is promoted, so
  the next merge is built and never goes live. `drk-deploy deploy` and `up`
  record the deployment to promote before they release, and promote it back
  themselves under `--rollback-on-fail` (the default under `--yes`). Migrations
  always land *before* the build that needs them goes live — the schema gate
  holds a build back until they have
  ([deployment.md §1.1](./deployment.md#11-the-live-path-vercel-git-integration-automated-migrations-schema-gate))
  — so a rollback needs no DB change.
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

**Node version errors.** Use Node 24 (what CI, the Docker image and Vercel run, and what `.nvmrc` +
`package.json` `engines` pin — `engines.node` is `24.x`, an exact major, so Vercel cannot move
production to a newer Node before CI and the image do). Point your version manager at `.nvmrc`.

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
- `BETTER_AUTH_SECRET` must be set (≥32 chars).
- `SSO_HANDOFF_PRIVATE_KEY`, when set, must be a valid Ed25519 private JWK JSON
  (`kty: OKP`, `crv: Ed25519`, with `d`) and must differ from `API_JWT_PRIVATE_KEY`.
- If `API_JWT_ENABLED=1`, `API_JWT_PRIVATE_KEY` must be a valid Ed25519 JWK JSON.
- Every one of those keys, and the `*_PREVIOUS_PRIVATE_KEY` rotation keys, is
  checked at boot (F-22). The env schema rejects a truncated `d` or a stray
  quote (`x` and `d` must each be 43 unpadded base64url characters), and the
  Node boot hook imports the key and rejects an `x` that is not `d`'s public
  half, failing startup with `Invalid Ed25519 signing keys at boot: …`.
- If `EMAIL_PROVIDER` is set, its credentials must be present. In production it
  also needs a real `EMAIL_FROM`: the `no-reply@localhost` default, another
  reserved domain (`*.local`, `example.com`, …), an IP address or a single-label
  host fails boot with `EMAIL_FROM (must …)`, and with Mailgun the sender must
  share `MAILGUN_DOMAIN`'s registrable domain (F-27, see
  [configuration.md](./configuration.md#email)).

**Boot fails on an origin-valued variable** (F-22). The error names the
variable and the rule, e.g. `SSO_HANDOFF_ISSUER (must use the http: or https:
scheme, not "httsp:")`. `BETTER_AUTH_URL`, `SSO_HANDOFF_ISSUER`,
`API_JWT_ISSUER`, `MCP_DISPATCH_BASE_URL`, `MAILGUN_BASE_URL` and each
`ADMIN_TRUSTED_ORIGINS` entry must be an http(s) origin with no path. In
production they must be `https://` unless the host is `localhost`, `127.0.0.1`
or `[::1]`. The two issuers must also have no trailing slash. `COOKIE_DOMAIN`
must be `BETTER_AUTH_URL`'s host or a parent of it, must not be a public
suffix, and must be written as `example.com` or `.example.com` (no trailing
dot). See [Configuration §1](./configuration.md#1-how-configuration-is-loaded).

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
and resets on restart; across multiple instances it's best-effort. The admin
actions that send mail are the exception (F-64): the test email (10 an hour per
admin), an invitation resend or an admin's reset email to the same recipient
within 10 minutes, and an organization past 200 admin-sent mails in 24 hours are
refused from Postgres, so a restart does not reset them and `Retry-After` can be
hours for the daily budget. See
[Admin Manager §2.5](./admin-manager.md#25-rate-limiting-of-admin-mutations).

**Locale parity test or a missing translation.** Every text key must exist in all
eight locale files. Add the key to `en.json` first, then `fr`/`es`/`uk`/`pt`/`zh`/`hi`/`ja`.

**Email not being delivered.** With no `EMAIL_PROVIDER`, messages are recorded as
`logged` and never sent — expected in dev. Set a provider, its credentials and an
`EMAIL_FROM` on a domain the provider has verified to deliver; check the
`email_delivery` log lines and `app_outbox` for `failed` rows and the recorded
error (see the incident playbook in Part 1 §4 for the serverless drain cron).

**The reset / invite link in the outbox reads `[redacted]`.** By design (review
#21): the administrator outbox stores a redacted body so an org admin can never
lift a co-member's live one-time link. Locally, read the DB-only
`app_outbox.delivery_payload` column instead — see
[Developer onboarding §9.4](./developer-onboarding.md#94-email-in-dev).

**SSO handoff fails.**
- The token is single-use and valid ≤60s (the signer clamps any larger
  `SSO_HANDOFF_TTL_SECONDS` down to 60) — a reused or expired token is rejected.
- `SSO_HANDOFF_ISSUER` and `SSO_HANDOFF_AUDIENCE_PREFIX` must match between hub
  and receiver; the receiver's `SSO_HANDOFF_APPLICATION_ID` must match the
  audience. There is no shared secret: the receiver verifies against the hub's
  `${SSO_HANDOFF_ISSUER}/api/sso/jwks.json`, so the issuer must be the hub's
  reachable origin URL and that endpoint must return the hub's key (`{ "keys":
  [] }` means the hub has no `SSO_HANDOFF_PRIVATE_KEY`).
- Launch answers `503 sso_not_configured` (audit reason
  `signing_key_not_configured`): the hub has no `SSO_HANDOFF_PRIVATE_KEY`.
  Audit reason `not_the_issuer`: the key is set, but `SSO_HANDOFF_ISSUER` is
  not this deployment's own origin. Such a deployment fails to boot (F-80).
- The token is rejected as too old even though `exp` is in the future: the
  receiver enforces `maxTokenAge` 60s from `iat` — check the clocks on both
  hosts (5s tolerance).
- The destination origin must fall under `SSO_ALLOWED_ORIGIN_SUFFIXES`. In
  production that variable is **required** for registration (unset ⇒ every
  origin is `origin_not_allowed` and a boot warning is logged), and each entry
  must be a registrable domain — a bare `com` / `co.uk` / `github.io` fails boot.

**Machine API returns 401/403.**
- Is the path enabled? `API_KEYS_ENABLED` / `API_JWT_ENABLED` are **off by default**.
- Is the credential's scope sufficient, and within the owner's permissions? A
  credential can't exceed its creator.
- For JWTs, is the token unexpired and verifiable against `/api/v1/jwks.json`?

## Test failures

**Spurious "… is not a function" from Vitest.** Use the sharded runner `pnpm test`,
not a single `vitest run` — see [Testing → sharded runner](./testing.md#why-the-sharded-runner).

**Coverage gate fails though all tests pass.** New untested code dropped coverage
below the ratchet: globally, or for one floored file (every route file under
`src/app`, and the security modules), which the `ERROR` line names. Add tests;
reproduce locally with `pnpm test:coverage` (the sharded `pnpm test` does **not**
compute coverage). [Testing §4](./testing.md#4-coverage-the-ratchet) says how the
floors are set.

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
idempotent (ledgered in `app_schema_migrations`) and safe to re-run. An
instance that started while a Better Auth table was missing keeps refusing
auth until it restarts, so restart or redeploy after `db:auth:migrate` (§4,
Schema behind). Always use
the **direct** (non-pooled) endpoint, as the role that owns the schema: the
migrate workflow does (deployment.md §1.2), and so must a hand run before the
merge while the workflow is not configured
([deployment.md §1.1](./deployment.md#11-the-live-path-vercel-git-integration-automated-migrations-schema-gate))
and `drk-deploy` (deployment.md §1.3).

**`[migrate] checksum mismatch for applied migration "…"`.** The runner hashes
every applied file — comments stripped and whitespace collapsed, so a re-flowed
comment never trips it — and compares it with the ledger (review #86); an
applied file changed in what it _does_. Restore the file from `main` — applied
migrations are frozen and the change belongs in a new numbered file. Only if
the edit was deliberate, already applied by hand to that database, and landed
with an updated pin in `tests/unit/migration-checksums.test.ts`, update the
ledger row on purpose with the `update … set checksum = …` statement the error
prints.

**`[migrate] FAILED` / `[auth:migrate] FAILED` with `canceling statement due to
lock timeout` (SQLSTATE `55P03`).** A statement waited longer than
`DB_MIGRATE_LOCK_TIMEOUT_MS` (default 5 s) for a lock another session holds:
usually a long export or report reading the same table, or a transaction left
open (F-94). The migrator gives up rather than queue every query on that table
behind its request. The application runner rolls the file back whole and
ledgers nothing. Find the blocker with `select pid, now() - xact_start as age,
state, query from pg_stat_activity where xact_start is not null order by age
desc`, let it finish or end it, and re-run. Raise the timeout only when
queueing that table's traffic behind the migration is acceptable. `canceling
statement due to statement timeout` is the other ceiling,
`DB_MIGRATE_STATEMENT_TIMEOUT_MS` (default 10 minutes); raise it for a file
that legitimately runs longer ([deployment.md §5](./deployment.md#5-operations--gotchas)).
Each Better Auth statement commits on its own, so after either timeout from
`[auth:migrate]` a re-run redoes a failed `create table` or `alter table`, but
not a `create index` whose column already committed: Better Auth plans a
column's index only in the run that adds the column or its table, so the
re-run plans nothing, and readiness does not notice a missing index. After the
re-run, compare the `create index` lines in
`src/db/migrations/better-auth-schema.sql` with `select indexname from
pg_indexes where schemaname = 'auth'` (your `DB_SCHEMA`), and create any
missing index by hand, `concurrently` on a large table.

**`[migrate] "0002-release.sql" consolidates …, and this database has applied
only some of them (missing: …)`.** The database was migrated before 0002…0008
were consolidated into `0002-release.sql`, and stopped part-way through them.
The runner cannot apply part of the file and will not re-run the part already
applied, so it refused before writing anything. Bring the database to `0008`
from commit `79b4803` (the last with the individual files), then run
`pnpm db:app:migrate` from this build, which records `0002-release.sql`
([deployment.md, Upgrading a database from before the consolidation](./deployment.md#upgrading-a-database-from-before-the-consolidation)).

**`[migrate] cannot record "0002-release.sql": the ledger has … for "000N-…"`.**
One of the seven folded files was ledgered under another checksum than the
one folded into `0002-release.sql`: that database applied a different version
of it (a local edit run against it, say). Nothing was recorded. Compare the
database with that file's section of `0002-release.sql`, and only once they
match, correct the row with the `update … set checksum = …` statement the error
prints.

**`[0005] refusing to apply: N row group(s) violate a constraint`.** Migration
0005 (a section of `0002-release.sql`, which rolls back whole when it refuses)
adds CHECK/uniqueness constraints and first lists every row that would
violate them (`table.column = value (count)`), changing nothing. Correct or
remove those rows (e.g. an enterprise app still in the removed `degraded`
status, two apps sharing an `sso_audience`, a group bundling a role from
another organization) and re-run `pnpm db:app:migrate`.

**HSTS/headers not present or mixed-content warnings.** Terminate TLS upstream;
HSTS is inert over plain HTTP. Confirm the proxy forwards the headers emitted by
`next.config.mjs`.

**Wrong client IP in rate limiting / logs behind a CDN.** If your CDN or proxy
sets a header of its own (`CF-Connecting-IP`, `X-Real-IP`) rather than appending
to `X-Forwarded-For`, name it in `CLIENT_IP_SOURCE` and the rest of this entry does
not apply ([Choosing the client-IP source](./configuration.md#choosing-the-client-ip-source)).
Otherwise set `TRUSTED_PROXY_COUNT` to your actual proxy depth so the client IP is read
correctly from `X-Forwarded-For`. The same setting drives Better Auth's sign-in /
reset limiter and the `ipAddress` recorded on sessions: the app derives the IP
once (`src/proxy.ts` and, at every server-side `auth.api.*` call site,
`withTrustedClientIp`) and overwrites the `x-drk-client-ip` request header that
Better Auth reads (review #35), so a wrong depth is visible on session rows:

- **Too shallow** (fewer than the real number of proxies): the selected entry is
  the IP of an _inner_ proxy, so every session records that one real address and
  every sign-in shares a single bucket — one real IP, not `no-trusted-ip`.
- **Too deep** (more than the chain length): the selection runs off the left
  end and the **leftmost, client-supplied** entry is taken — a spoofable IP, so a
  client can rotate buckets and forge the recorded address. Refusing a short chain
  instead would not help: a client pads its header until the chain is long
  enough, while every honest client would land in the one shared bucket. So the
  leftmost entry is kept on purpose (F-17), and the fix is the right count.
- **Addresses a client chose** (a burst of sign-ins from one source, each row
  showing a different address): nothing in front of the app overwrites
  `X-Forwarded-For` (the app is exposed directly, or the proxy only sets
  `X-Real-IP`), so each client's own header is trusted. Put an overwriting proxy
  in front, or set `CLIENT_IP_SOURCE` to the header your proxy sets (F-17).
- **`no-trusted-ip` / empty `ip_address`** means no usable address reached the
  app: either the proxy in front sets neither `X-Forwarded-For` nor `X-Real-IP`,
  `CLIENT_IP_SOURCE` names a header the proxy does not set, or the selected value
  is not an IP address (a hostname, `unknown`, garbage). A port suffix
  (`203.0.113.5:51234`, `[2001:db8::1]:443`) is stripped, not rejected (F-16).

Check the `ipAddress` on a fresh session row against the real client address,
and compare it with the `ip_address` of the matching `sso.consume.success` /
`auth` audit row. Both derive from the same rule and must agree: identical for
IPv4, while for IPv6 the session holds the client's /64 (the prefix Better Auth
keys on, written out in full) and the audit row the full address.

**Rate limits behave inconsistently across instances.** The **per-actor** admin
guard (mutations, bulk, export, a signed-in SSO launch) is in-process per
instance, so under horizontal scaling its budget multiplies by the instance
count — expected, and best-effort by design. The **pre-auth floors** (token
endpoint, the MCP endpoint and MCP registration, CSP sink, SSO consume, a
signed-out SSO launch, invitation acceptance) and Better Auth's sign-in limiter are Postgres-backed and
MUST be consistent; if they are not, check the log stream for
`shared rate-limit backend unavailable` and
`devresponsekit_rate_limit_shared_fallbacks_total` on `/api/metrics` (on Vercel
trust the log line: a scrape reaches one function instance, so a zero there
proves nothing about the others) — the app floors fall back to
per-instance buckets when `app_rate_limits` is missing (migration `0006` not
applied) or the database is unreachable. See
[deployment.md §5](./deployment.md#5-operations--gotchas).

**Audit / outbox tables growing without bound.** The retention prune applies
`AUDIT_RETENTION_DAYS` (default 365) and `OUTBOX_RETENTION_DAYS` (default 90)
and prunes expired token revocations and SSO handoff nonces. On Vercel it runs
inside the daily `GET /api/internal/outbox-drain` cron (F-96), so confirm that
cron is firing and `CRON_SECRET` is set. Each tick logs a `kind: "retention"`
line with its counts, or `retention prune tick failed` with the error. A
`[retention] … stopped at the time budget` line means a backlog larger than one
tick can clear: later ticks finish it. If every table stops `after 0 rows`, the
outbox drain used up the tick's budget before retention started: check its
`kind: "outbox-drain"` line and the email provider. On any other host, schedule
**`pnpm db:prune`** (`scripts/prune-retention.ts`). See
[Deployment](./deployment.md).

### Production build failed at `[deploy-gate]`

Every Vercel production build ends with the schema gate (DEP1,
[deployment.md §1.1](./deployment.md#11-the-live-path-vercel-git-integration-automated-migrations-schema-gate)).
A failed one was **not promoted**: the previous deployment is still serving, so
this is never an outage. The build log's last `[deploy-gate]` line says why;
the `target …` line above it names the database, schema and login it checked.
Once fixed, **Redeploy** the failed deployment from Vercel's Deployments page,
or push again.

- **`FAIL behind: the ledger lacks <ids>`** — the commit needs a migration
  production has not applied. First look at that commit's **Migrate
  production database** run ([below](#migrate-production-database-run-failed)):
  red, skipped (`not automated`), or never started. Then apply it, by re-running
  the workflow or against the **direct** endpoint by hand:
  `pnpm db:app:migrate` (and `pnpm db:auth:migrate` for a Better Auth change),
  or `drk-deploy migrate`, then redeploy. Within the gate's wait
  (`DEPLOY_GATE_WAIT_MS`, default 10 minutes) the build would have passed by
  itself. `Better Auth table(s)/column(s)/index(es) missing` is the same with
  `pnpm db:auth:migrate`. `search_path resolves to X, not DB_SCHEMA Y` means
  the schema does not exist yet (run both migrators), or, on a pooled
  endpoint with `DB_SEARCH_PATH_VIA_OPTIONS=0`, the login's role-level
  `search_path` default is missing or wrong
  ([deployment.md §5](./deployment.md#5-operations--gotchas)). `no migration
  ledger` is a database never migrated; `the runtime role cannot read the
  ledger` means the login lacks `SELECT` on `app_schema_migrations`.
- **`FAIL fatal: the database holds a different version of <id> than this
  build`** — an applied migration file was changed in what it does (the same
  check as `[migrate] checksum mismatch`, above). Waiting cannot fix it, so the
  gate stops at once. Restore the file: applied migrations are frozen, and the
  change belongs in a new numbered file. `FAIL fatal: Better Auth: …` is a
  better-auth upgrade whose schema change Better Auth itself calls unsafe (a
  required column with no default on a populated table) or a column the
  database requires that Better Auth does not know: review the upgrade against
  [Compatibility: expand, then contract](./deployment.md#compatibility-expand-then-contract).
  `FAIL fatal: the server environment is invalid (<keys>)` names production
  variables the app refuses at boot: fix them in Vercel (Configuration). Any
  other `fatal` carries the database's own error, such as a failed password.
- **`FAIL behind: the runtime login lacks …` or `… holds …, which the
  privilege manifest forbids`** (DEP3) — the app connects as a least-privilege
  login whose privileges differ from `src/db/runtime-privileges.ts`. The
  migrate run's line before `[migrate] done` says what its reconcile did
  (`[migrate] runtime role auth_runtime: …`); if that run failed or never ran,
  re-run it (or `pnpm db:app:migrate` against the direct endpoint) and
  redeploy. A forbidden `CREATE on schema public` or `CREATE on the database`
  is not a table grant, so the reconcile leaves it: revoke it as the owner.
- **`FAIL fatal: the runtime login has the forbidden attribute(s) …` or `is a
  member of …`** — the login bypasses its grants, typically because it was
  made in the Neon Console, which adds `neon_superuser`. Create a login with
  `pnpm db:runtime-login`, point `DATABASE_URL` at it and redeploy
  ([deployment.md §8.3](./deployment.md#83-pnpm-dbruntime-login-creating-rotating-and-adopting-a-login)).
- **`FAIL fatal: a least-privilege login (…) exists for this schema but this
  build connects as the owner …`** — the ratchet: production's `DATABASE_URL`
  is the owner's although a login exists. Point it back at the login, or, if
  going back to the owner is deliberate, follow the break-glass steps in
  [deployment.md §8.5](./deployment.md#85-the-gates-privilege-check-the-ratchet-and-break-glass).
- **`FAIL unreachable: <error>`** — no check reached the database before the
  deadline (a cold start or a blip is retried every 10 seconds). Check the
  provider's status, and that production's `DATABASE_URL` is right, then
  redeploy.
- **`FAIL timeout`** — a check hung past every connection and query timeout,
  and the gate cut it off a minute after its wait. Treat it as `unreachable`.
- **`REFUSE …`** — the gate would not check at all: `DATABASE_URL is not set`
  (or not a postgres URL) for the production environment;
  `VERCEL_ENV is missing on a Vercel build` (enable **Automatically expose
  System Environment Variables** under Project → Settings → Environment
  Variables); `DEPLOY_GATE_PREBUILT_AFTER_MIGRATE is not honoured on Vercel
  build infrastructure` (delete that variable from the project: only
  `drk-deploy` sets it, for its own local build); or a
  malformed `DEPLOY_GATE_WAIT_MS`. A **local** `vercel build --prod` refused
  with `DATABASE_URL is [SENSITIVE]` was run without migrating first: drop
  `--skip-migrations` from `drk-deploy`.

There is no switch to turn the gate off. If the gate itself is wrong, revert
the commit that added it; that revert's build runs no gate.

### Migrate production database run failed

`migrate-production.yml`
([deployment.md §1.2](./deployment.md#12-automated-migrations-migrate-productionyml))
applies each push's migrations while Vercel builds it. A red run means they
did not all land, so that build fails at its schema gate and is **not
promoted**: production keeps serving the previous deployment. The failed
step's log ends with `[auth:migrate] FAILED` or `[migrate] FAILED` and the
reason. Once it is fixed, **Re-run** the job (or `gh workflow run
migrate-production.yml --ref main`), then **Redeploy** the failed build in
Vercel. A green run whose summary says `Skipped: migrations are not automated`
is not a failure: the workflow has no secret yet (deployment.md §3), and the
migrations are applied by hand. Nor is a **cancelled** run ("a higher
priority waiting request … exists") for a commit that more pushes followed:
GitHub keeps one waiting run per concurrency group, and a newer push's run
took its place, applying the same migrations and more. Look at that newer
run instead. If the cancelled commit's build failed at its gate meanwhile,
there is nothing to redeploy: the newer commit's build is the one that ships.

- **A migration file failed** (an SQL error, `[0005] refusing to apply`, a
  lock timeout: the entries under [Deployment issues](#deployment-issues)) —
  that file rolled back and is not ledgered; the files before it stay
  applied. Fix it in a new commit: a file production never ledgered may
  still be edited.
- **`another session holds the migration lock: gave up after
  DB_MIGRATE_LOCK_WAIT_MS=300000ms`** — something else held the runners'
  advisory lock for five minutes: a hand `db:app:migrate` still running,
  `drk-deploy`, or a session left holding it. Find it with `select a.pid,
  a.usename, a.application_name, a.state, a.backend_start, a.query from
  pg_locks l join pg_stat_activity a using (pid) where l.locktype =
  'advisory' and l.granted`. Let it finish, or end an abandoned session with
  `select pg_terminate_backend(<pid>)`, then re-run the workflow and
  redeploy. Another run of the workflow is never the holder: its
  concurrency group runs one at a time.
- **`DATABASE_URL looks pooled: …`** or **`re-points the connection with …`**
  — the secret is a pooled URL (a `-pooler` or `.pooler.` host, port 6543,
  `pgbouncer=true`), or carries `host`, `hostaddr`, `port`, `dbname`,
  `database` or `user` in its query. Refused before connecting; nothing was
  attempted. Store Neon's **direct** owner URL, with user, host, port and
  database in the URL itself (deployment.md §3). The same refusal from a hand
  run, `db:provision` or the Docker init step means the same thing.
- **`the session's search_path resolves to X, not DB_SCHEMA Y`** — the
  session would have created the ledger and the tables in `X`. The secret's
  role has a `search_path` default naming another schema, or
  `DB_SEARCH_PATH_VIA_OPTIONS=0` reached the runner (it is for a pooled
  runtime: never set it for migrations). Check the repository variable
  `DB_SCHEMA` against production's too. Nothing was created there.
- **`permission denied for database <name>`** — the URL logs in as a role
  that may not create schemas in the database, usually the least-privilege
  runtime login of
  [deployment.md §8](./deployment.md#8-least-privilege-runtime-role-optional-recommended)
  (`auth_app`). Both runners run `create schema if not exists` before
  they create anything, and Postgres checks `CREATE` on the database even
  when the schema exists, so the run stops there. Store the owner's URL (on
  Neon usually `neondb_owner`). Nothing was changed.
- **`<schema>.app_schema_migrations is owned by A, but this session migrates
  as B`** — the URL logs in as a role other than the schema's owner (on Neon
  usually `neondb_owner`) that may create schemas, such as a superuser or
  another admin role. Tables another role creates get no runtime grants and
  break the audit trigger's owner rule, so the runner refuses instead of
  migrating as `B`. Store the owner's URL. Nothing was changed.
- **`runtime role auth_runtime: privileges outside the manifest that no grant
  to auth_runtime explains`** (DEP3) — the run's last step, the reconcile of
  [deployment.md §8.2](./deployment.md#82-the-reconcile-at-the-end-of-every-dbappmigrate),
  found a privilege it cannot revoke, because it comes from `PUBLIC` or from a
  role `auth_runtime` belongs to; the message names which, and what to
  revoke. Every migration file was already applied and ledgered; only the
  reconcile changed nothing. Revoke it as the owner and re-run.
- **`runtime role auth_runtime: still out of line after the repair`** — the
  reconcile's grants or revokes did not take, which Postgres reports only as
  a warning: the migrating role does not own the table, function or schema
  named. Migrate as the owner of every object in the schema (the Better Auth
  tables included), or transfer them to it, and re-run.
- **The run is green, but the build still failed `behind`** — the secret
  points at another database or schema than production's runtime
  `DATABASE_URL` and `DB_SCHEMA`, and the migrations landed there. Compare it
  with the gate's `[deploy-gate] target host=… database=… schema=…` line, fix
  the secret or the variable, re-run and redeploy.
- **The run started too late** (GitHub Actions delayed past the gate's ten
  minutes) — the build failed while the run may be green. Redeploy the build
  in Vercel, after `gh workflow run migrate-production.yml --ref main` if the
  run never started.

### `drk-deploy db:runtime-login` refused or failed

The operator command that moves production onto a least-privilege login (DEP4,
[deployment.md §8.3](./deployment.md#83-pnpm-dbruntime-login-creating-rotating-and-adopting-a-login)).
**Exit 2** is a refusal: nothing was created or written, so fix the cause and
rerun.

- **`is for the kit's own production`** — the config is a satellite's. Satellites
  keep connecting as their owner for now
  ([integration-satellite-apps.md](./integration-satellite-apps.md)).
- **`No owner URL`**, **`That looks like a POOLED connection
  string`** or **`re-points the connection with …`** — export
  `PRODUCTION_DIRECT_DATABASE_URL` (or name a `--from-env` file holding it) as
  production's DIRECT owner URL, with user, host, port and database in the URL
  itself. `DATABASE_URL` is never read.
- **`has no pnpm db:runtime-login script`** — the kit checkout predates DEP3:
  update it to origin's default branch.
- **`Refusing: the kit checkout has N uncommitted change(s)`, `… is not pushed`
  or `… HEAD … is not origin/main`** — the kit command reconciles the runtime
  role to the manifest in that checkout, so it must be the reviewed one. Commit
  and push, or check out what origin's default branch holds (`git pull
  --ff-only`).
- **`serves no deployment`** — production has never been deployed: deploy it
  first.
- **`the owner URL is not the database production uses`** — the host (with
  Neon's `-pooler` removed), port or database of `PRODUCTION_DIRECT_DATABASE_URL`
  differs from the serving deployment's `[deploy-gate] target …` line, both
  printed. Point the variable at production's direct endpoint. There is no
  override.
- **`production's schema gate checked schema X`** — pass `--schema X`.
- **`has no [deploy-gate] target line`** — the serving deployment's build did
  not run the schema gate on Vercel: it was built before the gate, or
  `drk-deploy deploy`/`up` built it on your machine and promoted it prebuilt
  (the gate skips there, and that build log never reaches Vercel). A production
  build by Vercel's git integration prints the line: push to the production
  branch, and rerun once that build serves production. Or, having checked the
  printed host and database yourself, rerun with `--allow-unverified-target`
  and type the database name when asked (`the name typed is not the owner URL's
  database` means it did not match). Over a prebuilt deployment, leave out
  `--redeploy` and push instead: the command proves the switch from the
  redeploy's gate line, and a redeploy of prebuilt output may not run a build,
  so it may print none.
- **`production already connects as <login>, the name this run would mint`** —
  logins are named by the minute: wait for the next one.
- **`The pooled host of <host> cannot be derived`**, **`The owner URL is
  already pooled`** or **`--pooled-host … is not a host name`** — only Neon's
  pooled host is derived; elsewhere pass `--pooled-host <host>` (a host name
  alone), or `--endpoint direct`.
- **`N DATABASE_URL entries cover Production`** or **`also covers
  Development`** — keep one entry per key for Production, and give Development
  its own: Vercel stores no `sensitive` value for Development.
- **`Refusing to retire every login but X: production connects as Y`** —
  `--retire-except` must name the login the serving deployment's gate line
  names (`user=`): retiring that one would cut production off. When `Y` is the
  owner, no rotated login is in use and `--retire-except` cannot name the owner
  (**`is not a kit login name`**): run `--retire-all`. **`Refusing to retire
  every rotated login: production connects as X, a kit login`** — retiring `X`
  cuts production off. If a deployment built before the first switch (it
  connects as the owner) is recent enough to serve, roll back to it and rerun.
  Otherwise, as after a rotation, a rollback lands on another login and the
  refusal stands: set `DATABASE_URL` to the owner's URL, rerun with `--force`
  (production is cut off until the next step is live) and redeploy at once,
  since a build that connects as the owner fails the ratchet while any rotated
  login exists (deployment.md §8.5). `--force` overrides either refusal,
  deliberately.
- **`--force applies only to …`** or **`cannot be combined with a retire
  mode`** — a retire run takes only `--force`, `--schema`, `--from-env`,
  `--allow-unverified-target`, `--dry-run` and `--yes`.

**Exit 1, `pnpm db:runtime-login exited N: nothing was written to Vercel`** —
the kit command's own `[db:runtime-login] FAILED …` line above says why:
`may not grant <runtime>` (run the printed `grant … with admin option`), a
refused SCRAM verifier (rerun with `--plaintext-password`), a verification that
found `CREATE on schema public` or `CREATE on the database` (as the owner,
`revoke create on database <db> from public`: an operator decision, since it
changes what every role may do), or a pooler that refuses the login. Then
rerun: a new login is minted. A verification failure (`<login> exists but
failed verification`) leaves that login behind, unused, and the hint says what
it does to production. While production connects as the owner, every
production build that connects as the owner fails the gate's ratchet (`a
least-privilege login … exists`), pushes to main included, until a rerun
succeeds or `drk-deploy db:runtime-login --retire-all` drops the login
(`--retire-except` cannot name the owner). While production connects as a kit
login, the stray one harms nothing, and `--retire-except <that login>` drops
it. In a retire run, **`kept <login>: N open session(s)`** is a pooler's idle
connection: rerun later, or pass `--force`.

**Exit 3** means something was written: the message says the way back.
`Writing <key> failed` leaves production as it was, because a deployment keeps
the environment it was built with: rerun. The new login exists: when the
`DATABASE_URL` write failed, it is a stray as above (with production on the
owner, owner builds fail the ratchet until a rerun succeeds or `--retire-all`
drops it); when a later write failed, `DATABASE_URL` already names it, so do
not retire it, rerun. `The redeploy failed` is a build that
failed its gate and was not promoted: production still serves the previous
deployment, but new production builds read the new login and fail the same way
until you fix the cause from the build's `[deploy-gate]` lines and rerun, or
follow the break-glass in deployment.md §8.5. `still serves …` means Vercel did
not assign the domain to the redeploy: promote it once its gate line names the
login. `is not healthy` or `its schema gate shows …` means production serves
the redeploy and it is wrong: run the printed `vercel promote` (Instant
Rollback), then investigate.

## Known risks & missing information

- **Per-process rate limiting and metrics** — the authenticated per-actor and
  per-credential buckets (admin mutations, the v1, account and preference
  self-service routes, MCP tool calls) and the Prometheus counters live in each
  process's memory, so neither is shared across instances; the pre-auth floors
  are shared in Postgres. Multi-instance (Vercel) is supported: those buckets are
  a best-effort UX limit there, and a scrape of `/api/metrics` sees one instance (see
  [deployment.md §5](./deployment.md#5-operations--gotchas) and
  [Observability §5](./observability.md#5-metrics)).
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
