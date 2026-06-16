# Setup Guide — From Checkout to a Deployed Instance

**Start here.** This is the canonical, do-this-then-that runbook for taking
**devresponsekit** from a fresh `git clone` to a running local instance and
then to a fully functional production deployment. It is deliberately linear:
follow it top to bottom the first time.

> New to the codebase architecture? Read this guide first to get an instance
> running, then read [get-started.md](get-started.md) for the developer
> orientation (auth boundary, routing model, shell composition). This guide
> answers _"how do I stand it up?"_; that one answers _"how is it built?"_.

All paths and commands below correspond to real artifacts in this repo. When
a step has more depth than fits here, it links to the dedicated guide.

---

## Table of contents

1. [What you will end up with](#1-what-you-will-end-up-with)
2. [Prerequisites](#2-prerequisites)
3. [Part A — Run it locally (checkout → running)](#3-part-a--run-it-locally-checkout--running)
4. [Part B — Configuration reference](#4-part-b--configuration-reference)
5. [Part C — Production build](#5-part-c--production-build)
6. [Part D — Deploy a fully functional instance](#6-part-d--deploy-a-fully-functional-instance)
7. [Part E — Verify the deployment (smoke test)](#7-part-e--verify-the-deployment-smoke-test)
8. [Troubleshooting](#8-troubleshooting)
9. [Where to go next](#9-where-to-go-next)

---

## 1. What you will end up with

- **Locally (Part A):** the app on `http://localhost:3000`, a Dockerized
  PostgreSQL, the full schema applied, and a seeded administrator you can sign
  in with — about 10 minutes.
- **In production (Parts C–D):** a production build served over HTTPS against a
  managed/pooled PostgreSQL, with the required secrets configured, migrations
  applied, and a real administrator account.

The same four commands provision the database in every environment:
`db:auth:migrate` → `db:app:migrate` → (optionally) `db:seed`, after `db:up`
locally or a managed Postgres elsewhere.

---

## 2. Prerequisites

| Tool       | Version           | Notes                                                                 |
| ---------- | ----------------- | --------------------------------------------------------------------- |
| **Node**   | 22+               | CI runs on Node 22. Use [nvm](https://github.com/nvm-sh/nvm) or [fnm]. |
| **pnpm**   | 10.x (`10.33.2`)  | Pinned via `packageManager` in [`package.json`](../package.json). Easiest install: `corepack enable`. |
| **Docker** | any recent        | Only for the local PostgreSQL ([`docker-compose.yml`](../docker-compose.yml)). Not needed if you point `DATABASE_URL` at an existing Postgres. |
| **git**    | any               | To clone the repository.                                              |
| **openssl**| any               | To generate secrets (Part B). Built in on macOS/Linux; on Windows use Git Bash or WSL. |

[fnm]: https://github.com/Schniz/fnm

`pnpm` is pinned. With [Corepack](https://nodejs.org/api/corepack.html) (ships
with Node) you do not install pnpm manually — it resolves `10.33.2`
automatically:

```bash
corepack enable
```

---

## 3. Part A — Run it locally (checkout → running)

Run these in order from a terminal.

```bash
# 1. Checkout
git clone https://github.com/devresponse/devresponsekit.git
cd devresponsekit

# 2. Install dependencies (uses the pinned pnpm 10.33.2 via corepack)
pnpm install

# 3. Create your local env file. The defaults in .env.example are wired for
#    the Dockerized Postgres below and a working local admin — no edits are
#    required to get running locally.
cp .env.example .env

# 4. Start PostgreSQL (pgvector/pgvector:pg17) on host port 5444
pnpm db:up

# 5. Provision the database — ORDER MATTERS (see the note below)
pnpm db:auth:migrate   # Better Auth (vendor) tables: user/session/account/verification
pnpm db:app:migrate    # the complete application schema (single 0001-initial-schema.sql)
pnpm db:seed           # default org, baseline roles + permissions, placeholder apps, admin user

# 6. Start the dev server
pnpm dev               # http://localhost:3000
```

Open **http://localhost:3000** — you land on the localized marketing page
(`/en`). Go to **http://localhost:3000/en/sign-in** and sign in with the seeded
administrator:

| Field    | Value                                   |
| -------- | --------------------------------------- |
| Email    | `admin@devresponse.local`               |
| Password | `ChangeMe-LocalOnly-123!`               |

These come from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env` — override
them before seeding to change the login. After signing in you reach the secure
shell; the seeded admin holds the `superuser` and platform-administrator roles,
so the **Administrator** console (users, roles, organizations, audit, email,
API keys) is available.

> **Why the migration order matters.** The application schema and seed link to
> Better Auth's `user` table by id, so Better Auth's tables must exist first.
> `db:auth:migrate` → `db:app:migrate` → `db:seed` is the required order. If you
> see `relation "user" does not exist` during seeding, you skipped
> `db:auth:migrate` — run it and re-seed (the seed is idempotent).

**New self-registered users start as `pending_approval`** and cannot enter the
secure shell until an administrator approves them under
**Administrator → Users**. This is by design — authentication is independent
from authorization.

### Useful local commands

| Command          | Purpose                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm db:up`     | Start the Postgres container (maps container `5432` → host `5444`). |
| `pnpm db:down`   | Stop the container (keeps the `postgres17-data` volume).            |
| `pnpm db:seed`   | Re-run the idempotent seed.                                         |
| `pnpm db:seed:dev` | Optional: load 3 orgs × 7 users for testing (see below).          |
| `pnpm db:reset`  | **Dry run**: list every table a reset would drop (changes nothing). |
| `pnpm db:reset:reload` | **Destructive**: drop all tables, then re-run the migrations + seed. |
| `pnpm dev`       | Dev server with hot reload.                                         |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | The pre-PR quality gates.              |

### Resetting the database

To wipe the database and rebuild it from scratch — the fastest way to re-test
the initial-setup path — use the reset script. It drops **every** table in the
`public` schema (the `app_*` tables, the Better Auth `user`/`session`/
`account`/`verification` tables, and the `app_schema_migrations` ledger), so
the next migration runs as if it were a first-time install.

```bash
pnpm db:reset           # DRY RUN — lists the tables it would drop, changes nothing
pnpm db:reset --yes     # drop + recreate an empty public schema (data + tables gone)
pnpm db:reset:reload    # the above, then db:auth:migrate + db:app:migrate + db:seed
```

`pnpm db:reset:reload` is the one-shot "blank slate → fully seeded" command. It
runs the rebuild steps **in-process** (the reset script orchestrates them with
`spawnSync`) rather than chaining shell commands with `&&`, so it behaves
identically across cmd, PowerShell, and bash — on Windows the old `&&` chain
could stop early and leave only the Better Auth tables.

**Safety rails** (the reset is irreversible): it refuses any non-local
`DATABASE_URL` host unless you pass `--force`, and the bare `pnpm db:reset` does
nothing without `--yes` (it prints the target host + database and a dry-run list
first). `db:reset:reload` passes `--yes` for you.

For a deeper reset that also discards the Postgres data volume, use
`docker compose down -v` and re-run the migrate + seed steps. Deep dive on the
database and Docker topology:
[setup-better-auth.md §4](setup-better-auth.md#4-postgresql-with-docker-local).

### Optional: load multi-organization test data

`pnpm db:seed` creates a single local admin. To exercise multi-organization
and multi-role scenarios, an **optional** development seed loads a richer
fixture (run it after the migrate steps above):

```bash
pnpm db:seed:dev
```

It creates **three organizations** (ORG A / B / C), each with **seven
accounts** — one superuser, one organization admin, and five regular users
(21 accounts in total):

| Account                      | Role (per org)   | Access                                             |
| ---------------------------- | ---------------- | -------------------------------------------------- |
| `superuser@org{a,b,c}.local` | `superuser`      | Cross-organization superadmin (holds `superuser`). |
| `orgadmin@org{a,b,c}.local`  | `admin.platform` | Full `admin.*`, scoped to its own org (ADR-0001).  |
| `user1..5@org{a,b,c}.local`  | `member`         | `shell.view` only — a plain user.                  |

All accounts share one password — **`DevPassword123!`** by default (override
with `DEV_SEED_PASSWORD`). Sign in at `/<locale>/sign-in`, e.g. as
`superuser@orga.local`. Every account is **pre-approved** (`active`) in its
assigned organization, so none sit in the `pending_approval` queue.

The script is **idempotent** (safe to run repeatedly — it reconciles existing
accounts rather than duplicating them) and **refuses to run under
`NODE_ENV=production`** unless `DEV_SEED_ALLOW_PROD=1` is set, since it creates
known-password accounts. Source:
[`src/db/seeds/dev-init.ts`](../src/db/seeds/dev-init.ts).

---

## 4. Part B — Configuration reference

Configuration is environment variables, read from `.env` locally and from your
platform's secret store in production. The full annotated list lives in
[`.env.example`](../.env.example); the schema that validates them at boot is
[`src/lib/env.ts`](../src/lib/env.ts).

### 4.1 Required everywhere

Server boot fails fast without these (they are the set validated by `env.ts`):

| Variable                      | Example                                  | Notes                                                                 |
| ----------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`          | _(32+ random bytes)_                     | ≥ 16 chars enforced; use 32+ in production. Rotating invalidates all sessions. |
| `BETTER_AUTH_URL`             | `https://app.example.com`                | Public origin where `/api/auth/*` is reachable.                       |
| `DATABASE_URL`                | `postgresql://user:pass@host:5432/db`    | Postgres connection string. **Use a pooled endpoint on serverless.**  |
| `SSO_HANDOFF_ISSUER`          | `https://app.example.com`                | `iss` for the cross-subdomain SSO handoff JWTs.                       |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | `devresponse-app`                        | Validates the handoff JWT audience.                                   |
| `SSO_HANDOFF_JWT_SECRET`      | _(32+ random bytes)_                     | ≥ 16 chars enforced. **Must be separate from `BETTER_AUTH_SECRET`.**  |

Also set **`NEXT_PUBLIC_APP_URL`** to your public origin — it is inlined at
build time and used as a trusted origin by [`src/lib/auth.ts`](../src/lib/auth.ts).

Generate each secret with strong entropy:

```bash
openssl rand -base64 48
```

> **`SSO_HANDOFF_APPLICATION_ID`** is optional at boot but the SSO **consumer**
> returns `500 audience_not_configured` without it. Set it per deployment
> (e.g. `portal`) so the audience check cannot be spoofed via the `Host` header.

### 4.2 Optional features (off by default)

Everything below is dark until you opt in. Enable only what you need:

| Feature                | Turn on with                                  | Guide                                                                 |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| **Social login**       | `GOOGLE_*` / `MICROSOFT_*` / `GITHUB_*`       | [setup-better-auth.md §6](setup-better-auth.md#6-social-login-providers) — register redirect URIs `{BETTER_AUTH_URL}/api/auth/callback/{provider}`. |
| **Outbound email**     | `EMAIL_PROVIDER` (`resend`/`mailgun`) + keys  | [setup-email.md](setup-email.md). Unset = outbox-only (rendered + recorded, never sent). |
| **Machine API (`/api/v1`)** | `API_KEYS_ENABLED` / `API_JWT_ENABLED`   | [api-and-cli-guide.md](api-and-cli-guide.md), [design-api-keys-and-tokens.md](design-api-keys-and-tokens.md). `API_JWT_ENABLED` requires `API_JWT_PRIVATE_KEY`. |
| **Multi-app SSO**      | `SSO_*` (required set already covers handoff) | [setup-sso-multi-app.md](setup-sso-multi-app.md).                     |
| **Observability (Sentry)** | `NEXT_PUBLIC_SENTRY_DSN`                  | [observability.md](observability.md). No DSN = no-op, build unchanged. |

A misconfigured _enabled_ feature fails at **boot**, not at first use — e.g.
`EMAIL_PROVIDER=resend` without `RESEND_API_KEY`, or `API_JWT_ENABLED` without
`API_JWT_PRIVATE_KEY`. This is intentional.

---

## 5. Part C — Production build

```bash
pnpm build      # next build (production)
pnpm start      # serves the build on PORT (default 3000)
```

What to know about the build:

- **`next build` does not need real secrets.** During the build phase the env
  schema substitutes placeholders, so page-data collection succeeds on a CI
  runner with no production secrets. The strict validation re-runs at real
  server start — so a missing required var (§4.1) surfaces as a terse
  `Invalid server environment variables: …` error when `pnpm start` boots, not
  during the build. For non-Next build harnesses (e.g. a Docker image build),
  set `SKIP_ENV_VALIDATION=1` to get the same behavior explicitly.
- **`pnpm start` needs the full required set** from §4.1 present in the
  environment.
- **Recommended pre-deploy gate** (also what CI runs):

  ```bash
  pnpm typecheck && pnpm lint && pnpm format:check && pnpm test:coverage
  ```

  End-to-end and accessibility suites (`pnpm test:e2e`, `pnpm test:a11y`) run
  against a production build in CI and are optional locally.

---

## 6. Part D — Deploy a fully functional instance

A complete deployment is five steps: **provision DB → set env → migrate →
deploy app → bootstrap the first admin.** Run them in that order; never let app
traffic reach an un-migrated database.

### 6.1 Provision a production database

- Use a **managed PostgreSQL** (Neon, Supabase, RDS, Cloud SQL). PostgreSQL 17
  is the tested baseline; the schema needs the `pg_trgm` extension (the
  initial schema runs `create extension if not exists pg_trgm`).
- On **serverless** runtimes (e.g. Vercel) point `DATABASE_URL` at a **pooled**
  endpoint (PgBouncer / Neon pooler / Supabase pooler / RDS Proxy). A direct
  connection will exhaust the database under function fan-out.
- Best practice: a **DDL role** for migrations (used only in your pipeline) and
  a lower-privilege **DML role** for the running app.

### 6.2 Set environment variables on the platform

Set the §4.1 required set (plus any §4.2 features you enabled) in your
platform's secret store, scoped per environment. Mark them sensitive; never
commit them — only `.env.example` is tracked.

### 6.3 Run migrations (as a separate stage, before serving)

From CI or a one-shot job/initContainer, against the **production**
`DATABASE_URL`:

```bash
pnpm db:auth:migrate
pnpm db:app:migrate
```

Do **not** run migrations from every app instance on startup — under rolling
deploys that races and can produce a partial schema. Run them once per release,
before the new build serves traffic.

### 6.4 Deploy the app

- **Vercel (primary target).** Import the repo, framework preset **Next.js**,
  default build command. Add the env vars from §6.2, add your production domain,
  and gate migrations (§6.3) ahead of promotion. Full walkthrough incl. preview
  deployments and cookies:
  [setup-better-auth.md §8.1](setup-better-auth.md#81-vercel).
- **Docker / self-hosted.** The same Next.js process serves the UI and the
  Better Auth route. Build with `pnpm build`, run with `pnpm start` behind a
  TLS-terminating reverse proxy, inject secrets from your secret manager, and
  run §6.3 as an init job. Topology and hardening:
  [setup-better-auth.md §8.2](setup-better-auth.md#82-docker--self-hosted).
- **CI/CD pipeline.** A canonical _verify → migrate → deploy_ GitHub Actions
  topology (with a `production` environment, required reviewers, and a
  migrations-only DB role) is in
  [setup-better-auth.md §8.3](setup-better-auth.md#83-github-actions).

### 6.5 Bootstrap the first administrator

A fresh production database has the schema and baseline roles but **no admin
user** (the seed is the supported way to create one). Two options:

1. **Run the seed once (recommended).** Set strong `SEED_ADMIN_EMAIL` and
   `SEED_ADMIN_PASSWORD` in the environment and run `pnpm db:seed` against the
   production database. It is idempotent (`on conflict do nothing`/`update`),
   creates the default organization, baseline roles/permissions, and an active
   administrator with the `superuser` + platform-admin roles. Sign in and
   change the password immediately.
2. **Self-register, then promote.** Register through the UI (the account starts
   `pending_approval`) and flip the first user to `active` with the admin roles
   directly in the database.

> The seed also inserts three **placeholder** enterprise applications
> (`portal`, `analytics`, `docs` at `*.devresponse.com`). These are examples —
> edit or remove them under **Administrator → Applications** for your
> deployment. Never reuse the local `devresponse:devresponse` database
> credentials anywhere shared or public.

---

## 7. Part E — Verify the deployment (smoke test)

Confirm the instance is genuinely functional:

- [ ] `pnpm start` boots with **no** `Invalid server environment variables` error.
- [ ] The marketing page renders at `https://<your-domain>/en`.
- [ ] You can sign in as the bootstrapped admin at `/en/sign-in`.
- [ ] The **Administrator** console loads (Users, Roles, Organizations, Audit, Email).
- [ ] A brand-new self-registration appears as `pending_approval` and becomes
      usable only after you approve it.
- [ ] If you enabled social login: the provider button completes a round-trip
      and the OAuth redirect URI matches `{BETTER_AUTH_URL}/api/auth/callback/{provider}`.
- [ ] If you enabled email: a password-reset request creates a row in
      **Administrator → Email** (and is delivered when a provider is configured).
- [ ] An action you take is recorded in the audit log (**Administrator → Audit**).

---

## 8. Troubleshooting

| Symptom                                                       | Cause                                                                 | Fix                                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `relation "user" does not exist` during `pnpm db:seed`        | Better Auth tables not created yet                                    | Run `pnpm db:auth:migrate` before `pnpm db:app:migrate` and `pnpm db:seed`.                          |
| `Invalid server environment variables: …` at start            | A §4.1 required var is missing/invalid at real boot                   | Set all required vars in the runtime environment (note: `next build` passes with placeholders).      |
| Port `5444` already in use / can't connect to Postgres        | Another Postgres is bound to the host port                            | Stop the conflicting container, or change the host port in `docker-compose.yml` and `DATABASE_URL`.  |
| Postgres "too many connections" in production                 | Direct (non-pooled) `DATABASE_URL` under serverless                   | Point `DATABASE_URL` at a pooler endpoint (§6.1).                                                     |
| OAuth callback `redirect_uri_mismatch`                        | `BETTER_AUTH_URL` ≠ the redirect URI registered with the IdP          | Align both exactly, including `/api/auth/callback/{provider}`.                                        |
| Sign-in works but the user is stuck on "pending approval"     | New accounts start `pending_approval` by design                       | Approve them under **Administrator → Users** (or sign in as the seeded admin).                        |
| `500 audience_not_configured` on SSO consume                  | `SSO_HANDOFF_APPLICATION_ID` not set                                  | Set it per deployment (§4.1).                                                                         |
| Seeded admin login fails locally                              | `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` changed after seeding, or seed skipped | Re-run `pnpm db:seed` with the values you expect (it is idempotent).                     |

More auth-specific symptoms:
[setup-better-auth.md §10](setup-better-auth.md#10-troubleshooting).

---

## 9. Where to go next

- [get-started.md](get-started.md) — developer orientation: the auth boundary,
  routing model, and shell composition patterns.
- [setup-better-auth.md](setup-better-auth.md) — deep dive on schema,
  migrations, social providers, secrets, and per-platform deployment (§8).
- [setup-email.md](setup-email.md) — outbound email + provider integration.
- [setup-sso-multi-app.md](setup-sso-multi-app.md) — cross-subdomain SSO across
  two or more apps.
- [api-and-cli-guide.md](api-and-cli-guide.md) /
  [design-api-keys-and-tokens.md](design-api-keys-and-tokens.md) — the `/api/v1`
  machine API.
- [database-schema.md](database-schema.md) — the `app_*` table reference.
- [observability.md](observability.md) — optional Sentry integration.
- [`.env.example`](../.env.example) — every configuration variable, annotated.
</content>
</invoke>
