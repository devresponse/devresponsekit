# Better Auth — Setup & Deployment Guide

This document is the canonical guide for installing, configuring, and
deploying [Better Auth](https://www.better-auth.com/) in the
**devresponsekit** project. It covers schema design, migration strategy,
local Postgres setup with Docker, Vercel deployment, social login
providers (Google, Microsoft, GitHub), secrets management, and
end-to-end deployment scenarios using Vercel, Docker, and GitHub
Actions.

All file paths and commands referenced below correspond to actual
artifacts in this repository.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Schema design](#2-schema-design)
3. [Migration strategy](#3-migration-strategy)
4. [PostgreSQL with Docker (local)](#4-postgresql-with-docker-local)
5. [Environment variables](#5-environment-variables)
6. [Social login providers](#6-social-login-providers)
   - [Google](#61-google)
   - [Microsoft (Entra ID)](#62-microsoft-entra-id)
   - [GitHub](#63-github)
7. [Secrets management — best practices](#7-secrets-management--best-practices)
8. [Deployment scenarios](#8-deployment-scenarios)
   - [Vercel](#81-vercel)
   - [Docker / self-hosted](#82-docker--self-hosted)
   - [GitHub Actions](#83-github-actions)
9. [Operational checklist](#9-operational-checklist)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture overview

Better Auth is initialized in [`src/lib/auth.ts`](../src/lib/auth.ts)
and exposes a single `auth` object. The Next.js catch-all route
[`src/app/api/auth/[...all]/route.ts`](../src/app/api/auth/[...all]/route.ts)
delegates every `/api/auth/*` request to Better Auth via
`toNextJsHandler(auth)`.

Key design choices in this repo:

- **Single database, single driver.** Better Auth uses its built-in
  Kysely-backed Postgres adapter through the same `pg` `Pool` we use
  for application tables (see [`src/db/database.ts`](../src/db/database.ts)).
  No Prisma or Drizzle is introduced.
- **Application tables are kept separate from Better Auth tables.**
  App tables are prefixed `app_` (see
  [`src/db/migrations/0001-app-core.sql`](../src/db/migrations/0001-app-core.sql))
  and link to Better Auth users by storing `better_auth_user_id`
  rather than embedding into Better Auth's own tables.
- **Cookie handling** uses Better Auth's `nextCookies()` plugin so that
  Server Actions and Route Handlers set/refresh cookies correctly under
  Next.js 16.
- **Account linking** is enabled but only across **trusted, verified**
  providers (`google`, `microsoft`, `github`) — never by unverified
  email.
- **Sessions** are 8 hours rolling, refreshed every 15 minutes of
  activity (`session.expiresIn`, `session.updateAge`).

```
Browser ──► /api/auth/[...all]  ──►  betterAuth(...)  ──►  Postgres
                                          │
                                          ├── user / account / session / verification (Better Auth tables)
                                          └── shared pg Pool (DATABASE_URL)

App code  ──►  Kysely (db)       ──►  app_users / app_organizations / ...
```

---

## 2. Schema design

The database is logically split into two layers that share one
Postgres database (and one connection pool):

### 2.1 Better Auth tables (managed by Better Auth)

Better Auth owns and migrates the following standard tables:

| Table          | Purpose                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `user`         | Canonical identity record (id, email, emailVerified, image, timestamps) |
| `account`      | One row per linked credential — email/password and per-provider OAuth   |
| `session`      | Active session rows (token, expiresAt, ipAddress, userAgent)            |
| `verification` | Short-lived verification codes (email, password reset)                  |

These names and columns are produced by Better Auth's CLI and should
**not** be hand-edited. Refer to the Better Auth release notes when
upgrading; new columns are introduced via the auth migration tooling
(see §3.2).

### 2.2 Application tables (managed by us)

Defined in [`src/db/migrations/0001-app-core.sql`](../src/db/migrations/0001-app-core.sql):

| Table                          | Purpose                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `app_organizations`            | Tenant/organization records (slug, name, status, is_default).                                            |
| `app_provider_organizations`   | Maps an external IdP organization (e.g. an Entra tenant, a GitHub org) to an internal `app_organization`. |
| `app_users`                    | Application-side user profile. Links to Better Auth via `better_auth_user_id` (unique).                  |
| `app_organization_memberships` | Membership of an `app_user` in an `app_organization`, with status and source provider.                   |
| `app_schema_migrations`        | Migration ledger used by our SQL runner.                                                                 |

Design rules:

- The Better Auth `user.id` is the **identity**; `app_users.id` is the
  **profile**. They are joined by `app_users.better_auth_user_id`.
- Application code must never `JOIN` directly into Better Auth tables
  in user-facing queries; resolve identity via
  [`src/lib/user-provisioning.server.ts`](../src/lib/user-provisioning.server.ts).
- Approval / status flow lives in `app_users.status` and
  `app_organization_memberships.status` — not in Better Auth — so that
  authentication remains independent from authorization.

### 2.3 Connection pooling

A single shared `pg.Pool` is created in
[`src/db/database.ts`](../src/db/database.ts) with `max` from
`PGPOOL_MAX` (default 10) and a 30 s idle timeout. Better Auth opens
its own `Pool` against the same `DATABASE_URL` in
[`src/lib/auth.ts`](../src/lib/auth.ts). On serverless (Vercel) you
**must** point both at a pooler endpoint (PgBouncer / Neon pooler /
Supabase pooler) — never the direct Postgres port — to survive
function fan-out.

---

## 3. Migration strategy

There are two independent migration tracks. They run in a defined
order and are wired up as `pnpm` scripts in
[`package.json`](../package.json).

### 3.1 Application migrations (us)

- **Runner:** [`src/db/migrations/run-migrations.ts`](../src/db/migrations/run-migrations.ts)
- **Command:** `pnpm db:app:migrate`
- **Pattern:** Plain `.sql` files in `src/db/migrations/`, applied in
  lexical order, each wrapped in a transaction. Applied filenames are
  recorded in `app_schema_migrations`.
- **Naming:** `NNNN-short-name.sql` (e.g. `0001-app-core.sql`,
  `0002-add-billing.sql`). Never edit a migration after it has been
  applied to any shared environment — append a new file instead.
- **Filtering:** Files starting with `better-auth` are skipped (those
  are owned by the auth track).

### 3.2 Better Auth migrations (vendor)

- **Generator:** `pnpm db:auth:generate`
  ([`run-better-auth-generate.ts`](../src/db/migrations/run-better-auth-generate.ts))
  — emits the schema/migration that matches the installed
  `better-auth` version against your Better Auth config.
- **Apply:** `pnpm db:auth:migrate`
  ([`run-better-auth-migrate.ts`](../src/db/migrations/run-better-auth-migrate.ts)).
  This wrapper invokes the programmatic API if the installed Better
  Auth version exposes it, otherwise instructs you to fall back to
  the official Better Auth CLI.

### 3.3 Recommended ordering

For a clean environment:

```bash
# 1. Bring up Postgres
pnpm db:up

# 2. Apply Better Auth's schema first so app FKs / lookups by
#    better_auth_user_id always resolve.
pnpm db:auth:migrate

# 3. Apply application migrations.
pnpm db:app:migrate

# 4. (Local only) seed the default org + admin user.
pnpm db:seed
```

In CI/CD, **always** run `db:auth:migrate` and `db:app:migrate`
**before** the new application code starts serving traffic. See
[§8.3 GitHub Actions](#83-github-actions) for the canonical pipeline.

### 3.4 Rollback policy

- Application migrations are **forward-only**. Roll forward with a new
  `NNNN-revert-...sql` if needed.
- Better Auth migrations are managed by the vendor; pin the
  `better-auth` version in [`package.json`](../package.json)
  (currently `1.6.9`) and bump it deliberately, regenerating the
  schema in a dedicated PR.

---

## 4. PostgreSQL with Docker (local)

The repository ships a ready-to-use Postgres in
[`docker-compose.yml`](../docker-compose.yml):

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    ports:
      - "5444:5432"
    environment:
      POSTGRES_USER: devresponse
      POSTGRES_PASSWORD: devresponse
      POSTGRES_DB: devresponse_db
    volumes:
      - postgres17-data:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
volumes:
  postgres17-data:
```

Local workflow:

```bash
# 1. Copy and customize env
cp .env.example .env

# 2. Start Postgres in the background
docker compose up -d postgres
# or: pnpm db:up

# 3. Verify the container is healthy / inspect logs
docker compose ps postgres
docker compose logs -f postgres

# 4. Run migrations + seed
pnpm db:auth:migrate
pnpm db:app:migrate
pnpm db:seed

# 5. Boot the app
pnpm dev
```

The default `DATABASE_URL` in `.env.example` already targets this
container on host port `5444` while Postgres continues listening on its
internal default port `5432`:

```
postgresql://devresponse:devresponse@localhost:5444/devresponse_db?schema=public
```

On first boot, Docker runs
[`docker/postgres/init/01-extensions.sql`](../docker/postgres/init/01-extensions.sql)
to enable `vector` and `pg_trgm`. `tsvector` support is built into
PostgreSQL 17, so no extra extension install is required.

The Compose file intentionally omits a fixed `container_name`, maps to
host port `5444`, and uses a new `postgres17-data` volume so it does
not collide with common local `5432` Postgres containers or reuse the
previous local data directory.

Stop the container with `docker compose down` (or `pnpm db:down`), which preserves the Compose-managed `postgres17-data` volume. To wipe the database, run `docker compose down -v`.

> **Never** use the local credentials (`devresponse:devresponse`) in
> any shared or production environment — they exist purely for
> developer convenience.

---

## 5. Environment variables

The full list of environment variables is documented in
[`.env.example`](../.env.example). The Better-Auth-related variables
are:

| Variable                       | Required | Notes                                                                       |
| ------------------------------ | -------- | --------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`           | ✅       | 32+ bytes of random entropy. Rotating invalidates all sessions.             |
| `BETTER_AUTH_URL`              | ✅       | Public origin where `/api/auth/*` is reachable (e.g. `https://app.devresponse.com`). |
| `DATABASE_URL`                 | ✅       | Postgres connection string. Use a pooled endpoint on serverless.            |
| `NEXT_PUBLIC_APP_URL`          | ✅       | Used as a trusted origin in [`src/lib/auth.ts`](../src/lib/auth.ts).        |
| `GOOGLE_CLIENT_ID` / `_SECRET` | ⛔ opt   | Required only if Google sign-in is enabled.                                 |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | ⛔ opt | Required only if Microsoft sign-in is enabled.                              |
| `GITHUB_CLIENT_ID` / `_SECRET` | ⛔ opt   | Required only if GitHub sign-in is enabled.                                 |
| `SSO_HANDOFF_JWT_SECRET`       | ✅       | Separate from `BETTER_AUTH_SECRET`. Used by the subdomain SSO handoff.      |
| `SSO_HANDOFF_AUDIENCE_PREFIX`  | ✅       | Used to validate handoff JWT audience.                                      |
| `SSO_HANDOFF_APPLICATION_ID`   | ✅       | Per-deployment audience suffix; prevents Host-header spoofing.              |

> The build itself reads `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
> `SSO_HANDOFF_JWT_SECRET`, and `SSO_HANDOFF_AUDIENCE_PREFIX` —
> `pnpm build` will fail without them.

Generate a strong secret on Linux/macOS:

```bash
openssl rand -base64 48
```

---

## 6. Social login providers

All three providers are configured in
[`src/lib/auth.ts`](../src/lib/auth.ts) under `socialProviders`. Each
provider must be registered with its IdP and have a redirect URI
that matches the deployment origin:

```
{BETTER_AUTH_URL}/api/auth/callback/{provider}
```

For example, on production:

| Provider  | Redirect URI                                               |
| --------- | ---------------------------------------------------------- |
| Google    | `https://app.devresponse.com/api/auth/callback/google`     |
| Microsoft | `https://app.devresponse.com/api/auth/callback/microsoft`  |
| GitHub    | `https://app.devresponse.com/api/auth/callback/github`     |

For local dev, register a parallel set of credentials targeting
`http://localhost:3000/api/auth/callback/{provider}`. Do **not** mix
prod and dev credentials.

### 6.1 Google

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. Add Authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://app.devresponse.com/api/auth/callback/google`
4. Configure the OAuth consent screen:
   - Scopes: `openid`, `email`, `profile` (defaults requested by Better Auth).
   - User type: **External** unless you are restricted to a Workspace tenant.
5. Copy the Client ID / Secret into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.
6. **Verification:** Google requires consent screen verification once
   you exceed 100 users, request sensitive scopes, or want a
   non-"unverified app" warning.

### 6.2 Microsoft (Entra ID)

This project uses **multi-tenant work/school accounts** — see
`tenantId: "organizations"` and `prompt: "select_account"` in
[`src/lib/auth.ts`](../src/lib/auth.ts).

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/),
   go to **Applications → App registrations → New registration**.
2. **Supported account types:** _Accounts in any organizational
   directory (Any Microsoft Entra ID tenant — Multitenant)_.
3. **Redirect URI** (Web): `https://app.devresponse.com/api/auth/callback/microsoft`
   (and a second registration or additional URI for localhost).
4. Under **Certificates & secrets**, create a **Client secret**
   (max 24 months — schedule rotation; see §7).
5. Under **API permissions**, add Microsoft Graph delegated
   permissions: `openid`, `profile`, `email`, `User.Read`. Grant
   admin consent for the home tenant.
6. Copy **Application (client) ID** → `MICROSOFT_CLIENT_ID`
   and the secret value → `MICROSOFT_CLIENT_SECRET`.
7. Tenant policies (multi-tenant): each consuming tenant's admin
   must consent the first time a user from that tenant signs in. If
   you want to restrict to a single tenant, change `tenantId` in
   [`src/lib/auth.ts`](../src/lib/auth.ts) from `"organizations"` to
   the tenant GUID.

### 6.3 GitHub

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
   For organization-wide visibility, create it under your org's
   Developer settings instead of a personal account.
2. **Homepage URL:** `https://app.devresponse.com`
3. **Authorization callback URL:** `https://app.devresponse.com/api/auth/callback/github`
   (GitHub allows only one callback URL per OAuth App, so create a
   **second** OAuth App for localhost dev with the matching URL).
4. Click **Generate a new client secret** and copy the value
   immediately — GitHub will not show it again.
5. Populate `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
6. If you need richer GitHub data (org membership, repos), prefer a
   **GitHub App** over an OAuth App; it is also subject to per-org
   approval which is desirable for enterprise contexts.

> Account linking across all three providers is enabled in
> [`src/lib/auth.ts`](../src/lib/auth.ts) only when the verified email
> matches (`allowDifferentEmails: false`). This prevents an attacker
> from claiming another user's account by registering a provider
> account with a spoofed unverified email.

---

## 7. Secrets management — best practices

Applied to every environment (local, preview, production):

1. **Never commit secrets.** `.env`, `.env.local`, `.env.*.local` are
   already in [`.gitignore`](../.gitignore). Only `.env.example`
   (placeholders) is tracked.
2. **Separate per-environment credentials.** Production OAuth client
   secrets are not reused in preview or local. Compromising a
   developer's laptop must not compromise prod.
3. **Independent secrets.** `BETTER_AUTH_SECRET` and
   `SSO_HANDOFF_JWT_SECRET` are deliberately **separate**
   (see [`src/lib/auth.ts`](../src/lib/auth.ts) and
   [`src/lib/jwt-handoff.server.ts`](../src/lib/jwt-handoff.server.ts)).
   Do not collapse them.
4. **Strong entropy.** Use `openssl rand -base64 48` (minimum 32
   bytes) for all symmetric secrets.
5. **Centralize storage.** Use exactly one source of truth per
   environment:
   - **Vercel:** _Project Settings → Environment Variables_, scoped
     per environment (Development / Preview / Production), marked
     **Sensitive** so values are not echoed back in the UI.
   - **Self-hosted:** a secret manager (AWS Secrets Manager, GCP
     Secret Manager, HashiCorp Vault, Doppler, 1Password Connect).
     Inject at container start; never bake into images.
   - **GitHub Actions:** [Encrypted secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)
     scoped to **Environments** (`production`, `preview`) with
     required-reviewer protection on `production`.
6. **Rotate on schedule and on incident.** Microsoft client secrets
   expire (max 24 months) — schedule rotation in your password
   manager. Rotate `BETTER_AUTH_SECRET` on suspected compromise; this
   invalidates all sessions, which is the desired behavior.
7. **Least privilege DB users.** Use distinct Postgres roles for the
   migration runner (DDL) and the application runtime (DML only).
   Migration credentials live only in CI.
8. **No secrets in logs.** `console.log` of `process.env` is
   prohibited. The audit logger
   ([`src/lib/audit.server.ts`](../src/lib/audit.server.ts)) must
   never receive raw secret-bearing objects.
9. **Restrict OAuth redirect URIs** at the IdP to the exact origins
   you operate. Wildcards are not permitted by Google / Microsoft and
   should not be requested.
10. **Pin and review dependencies.** Better Auth is pinned to
    `1.6.9`. Treat any auth-library bump as a security-sensitive PR.

---

## 8. Deployment scenarios

### 8.1 Vercel

Vercel is the primary deploy target for the Next.js app. Better Auth
runs inside the same project (its catch-all route is part of the
Next.js app).

**Project setup**

1. Import the GitHub repo into Vercel.
2. Framework preset: **Next.js**. Build command remains the default
   (`next build`).
3. Set Environment Variables for each scope (`Production`,
   `Preview`, `Development`):
   - `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (e.g.
     `https://app.devresponse.com` for prod, the per-deploy preview
     URL for previews — see below).
   - `DATABASE_URL` pointing to a **pooled** Postgres endpoint
     (Neon, Supabase, RDS+RDS Proxy, or PgBouncer). Direct
     connections will exhaust the database under serverless concurrency.
   - `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME`,
     `NEXT_PUBLIC_PRIMARY_HOST`, `NEXT_PUBLIC_PRODUCTION_HOST`.
   - `GOOGLE_*`, `MICROSOFT_*`, `GITHUB_*` if those providers are
     enabled.
   - `SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_AUDIENCE_PREFIX`,
     `SSO_HANDOFF_APPLICATION_ID`.
4. Add `app.devresponse.com` as a Production domain. Configure DNS to
   Vercel.
5. Run database migrations from CI **before** Vercel promotes the
   build (see [§8.3](#83-github-actions)). Vercel build steps cannot
   reliably reach a private database; treat migrations as a separate
   pipeline stage.

**Preview deployments**

Each PR gets a unique URL like
`https://devresponsekit-pr-123-devresponse.vercel.app`. Two options:

- **Shared preview origin**: set `BETTER_AUTH_URL` to a stable
  alias (e.g. `https://preview.devresponse.com`) and register that
  alias in each OAuth provider's redirect URIs. Simplest, but all
  previews share one IdP app.
- **Per-deploy origin**: set `BETTER_AUTH_URL` to
  `${VERCEL_URL}` at runtime. You must then register every preview
  domain pattern with the IdPs (Google supports a small number;
  GitHub allows only one). This is rarely worth the operational cost.

**Sessions & cookies on Vercel**

- Cookies are first-party to `BETTER_AUTH_URL`. If you serve the app
  on a subdomain (`app.devresponse.com`) and need sessions on
  `marketing.devresponse.com`, use the SSO handoff flow in
  [`src/lib/sso.server.ts`](../src/lib/sso.server.ts) — do **not**
  widen the cookie domain.

### 8.2 Docker / self-hosted

For environments where Vercel is not used (on-prem, customer cloud,
EKS, Fly.io, Railway), the same Next.js process serves both the UI
and the Better Auth catch-all route.

**Image build**

A production-grade Dockerfile (not yet in the repo) should:

1. Use `node:22-alpine` as a runtime base.
2. Install dependencies with the pinned `pnpm@10.33.2` from
   [`package.json`](../package.json).
3. Run `pnpm build` with all required build-time env vars
   (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_AUDIENCE_PREFIX`).
4. Use `output: "standalone"` from `next.config.mjs` to ship a
   minimal runtime.

**Runtime**

Run the container behind a TLS-terminating reverse proxy (Caddy,
nginx, ALB) with:

```
ENV NODE_ENV=production
ENV BETTER_AUTH_URL=https://app.devresponse.com
ENV DATABASE_URL=postgres://app_runtime:...@pgbouncer:6432/devresponse_db
ENV BETTER_AUTH_SECRET=...    # injected from secret manager
# OAuth + SSO handoff vars as in §5
```

**Database**

For self-hosted Postgres, mirror the local
[`docker-compose.yml`](../docker-compose.yml) topology but:

- Use a managed service (RDS, Cloud SQL, Neon) where possible.
- Always front Postgres with PgBouncer (transaction pooling) when
  the app runs in many small processes/pods.
- Schedule daily logical backups (`pg_dump`) plus PITR via WAL
  archiving.

**Migrations**

Run migrations as a one-shot Job/initContainer on each deploy:

```bash
pnpm db:auth:migrate
pnpm db:app:migrate
```

Do **not** run migrations from every app pod on startup — it races
and can cause partial schemas under rolling deploys.

### 8.3 GitHub Actions

The recommended CI/CD topology runs three jobs per push:

```
┌──────────────┐    ┌──────────────────┐    ┌────────────────────┐
│ 1. Verify    │ →  │ 2. Migrate DB    │ →  │ 3. Deploy app      │
│ (lint/test)  │    │ (Better Auth +   │    │ (Vercel / Docker)  │
│              │    │  app SQL)        │    │                    │
└──────────────┘    └──────────────────┘    └────────────────────┘
```

Skeleton workflow (`.github/workflows/deploy.yml`, not yet in repo):

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg17
        env:
          POSTGRES_USER: devresponse
          POSTGRES_PASSWORD: devresponse
          POSTGRES_DB: devresponse_db
        ports: ["5444:5432"]
        options: >-
          --health-cmd "pg_isready -U devresponse"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql://devresponse:devresponse@localhost:5444/devresponse_db
      BETTER_AUTH_SECRET: ci-only-not-a-real-secret
      BETTER_AUTH_URL: http://localhost:3000
      SSO_HANDOFF_JWT_SECRET: ci-only-not-a-real-secret
      SSO_HANDOFF_AUDIENCE_PREFIX: devresponse-app
      SSO_HANDOFF_APPLICATION_ID: portal
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.33.2 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:auth:migrate
      - run: pnpm db:app:migrate
      - run: pnpm test:all

  migrate-prod:
    needs: verify
    runs-on: ubuntu-latest
    environment: production   # required reviewer + secret scope
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.33.2 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:auth:migrate
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL_MIGRATIONS }}
          BETTER_AUTH_SECRET: ${{ secrets.BETTER_AUTH_SECRET }}
          BETTER_AUTH_URL: ${{ secrets.BETTER_AUTH_URL }}
      - run: pnpm db:app:migrate
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL_MIGRATIONS }}

  deploy:
    needs: migrate-prod
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      # Option A — Vercel
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
      # Option B — Docker registry + remote rollout
      # - uses: docker/build-push-action@v6
      #   with: { push: true, tags: ghcr.io/devresponse/devresponsekit:${{ github.sha }} }
```

Recommended GitHub Actions guardrails:

- Use **Environments** (`production`, `preview`) with required
  reviewers on `production` and store production secrets only in
  that environment's scope.
- Use a dedicated `PROD_DATABASE_URL_MIGRATIONS` secret bound to a
  Postgres role that has DDL rights but is **not** used by the
  application runtime. The runtime uses a separate, lower-privilege
  role.
- Pin all third-party actions by full commit SHA in production
  pipelines.
- Configure [OIDC federation](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
  to your cloud provider so that long-lived cloud credentials never
  live in GitHub Secrets.

---

## 9. Operational checklist

Before promoting a Better Auth change to production:

- [ ] `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DATABASE_URL`, and
      `SSO_HANDOFF_*` are set in the target environment.
- [ ] OAuth providers list **only** the production redirect URIs you
      actually use; stale dev URIs are removed.
- [ ] `pnpm db:auth:migrate` and `pnpm db:app:migrate` ran cleanly
      against the prod database before the new app build is promoted.
- [ ] `DATABASE_URL` for the runtime points at a **pooled** endpoint
      with a least-privilege role (no DDL).
- [ ] Account linking trust list in
      [`src/lib/auth.ts`](../src/lib/auth.ts) matches the providers
      you actually trust.
- [ ] Session lifetimes (`expiresIn`, `updateAge`) are reviewed for
      the deployment's risk profile.
- [ ] Audit log
      ([`src/lib/audit.server.ts`](../src/lib/audit.server.ts)) is
      sinking somewhere durable.

## 10. Troubleshooting

| Symptom                                                  | Likely cause                                                                                                  | Fix                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm build` fails complaining about missing env vars    | `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`/`SSO_HANDOFF_*` not set in the build environment                       | Provide all build-time vars listed in §5; on Vercel set them at the Project level.                            |
| OAuth callback returns `redirect_uri_mismatch`           | `BETTER_AUTH_URL` doesn't match the redirect URI registered with the IdP                                      | Align both, including scheme and trailing path; remember `/api/auth/callback/{provider}`.                     |
| Sessions log out after a deploy                          | `BETTER_AUTH_SECRET` changed, or different per-instance values across pods                                    | Use a single secret per environment; rotate intentionally.                                                    |
| Postgres "too many connections" on Vercel                | Direct (non-pooled) `DATABASE_URL` under serverless                                                           | Switch to a pooler endpoint (Neon/Supabase pooler, RDS Proxy, PgBouncer transaction mode).                    |
| Microsoft sign-in fails for users in other tenants       | Single-tenant app registration                                                                                | Register the app as multi-tenant and set `tenantId: "organizations"` (already configured in this repo).       |
| Account linking unexpectedly creates a new user          | Provider returned a different verified email than the existing account                                        | Expected — `allowDifferentEmails: false`. Have the user link manually from their account page.                |
| GitHub callback works locally but not in prod            | Single OAuth App registered with localhost callback URL                                                       | Create a separate OAuth App per environment; GitHub allows only one callback URL per app.                     |

---

**References**

- Better Auth docs: <https://www.better-auth.com/docs>
- This repo's auth setup: [`src/lib/auth.ts`](../src/lib/auth.ts)
- Catch-all route: [`src/app/api/auth/[...all]/route.ts`](../src/app/api/auth/[...all]/route.ts)
- Database: [`src/db/database.ts`](../src/db/database.ts)
- App schema: [`src/db/migrations/0001-app-core.sql`](../src/db/migrations/0001-app-core.sql)
- Migration runners: [`src/db/migrations/run-migrations.ts`](../src/db/migrations/run-migrations.ts), [`run-better-auth-migrate.ts`](../src/db/migrations/run-better-auth-migrate.ts)
- Local Postgres: [`docker-compose.yml`](../docker-compose.yml)
- Env template: [`.env.example`](../.env.example)
