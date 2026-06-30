# Deploying to Vercel + Neon

_Audience: DevOps / release engineers shipping this application to [Vercel](https://vercel.com) with a [Neon](https://neon.tech) serverless Postgres database. This is the platform-specific runbook; it pairs with [Configuration](configuration.md) (the authoritative list of every environment variable) and [Deployment](deployment.md) (the platform-neutral build/runtime model)._

---

## 0. How this repo deploys (read this first)

This codebase ships with an **opinionated, GitHub-Actions-driven** pipeline — it does **not** use Vercel's native "build on git push" integration. The workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs on every push to `main` (or via manual `workflow_dispatch`) and does, in order:

1. `pnpm db:app:migrate` — applies database migrations against a **direct (non-pooled)** Neon endpoint.
2. `vercel pull` → `vercel build --prod` → `vercel deploy --prebuilt --prod` — builds locally in CI and promotes the prebuilt output.

The whole point of this shape is the **migrate-first contract**: the new build only goes live **after** migrations succeed. So a few things follow:

- **Environment variables live in two places.** Runtime + build vars live in **Vercel's** env store (pulled by `vercel build`). Deploy-time secrets (Vercel token, the direct DB URL) live in **GitHub Actions** secrets.
- **Do not also enable Vercel's native Git auto-deploy.** If you connect the repo for Vercel to build on push, you will double-deploy *and* skip the migration step. Either leave the project unconnected to Git, or disable production auto-builds and rely on the workflow.
- The `output: "standalone"` setting in [`next.config.mjs`](../next.config.mjs) is for the Docker image only ([Docker guide](docker.md)); **Vercel ignores it** — no action needed.

> Prefer Vercel's native Git build instead? It's possible, but you lose the migrate-first ordering and must run migrations yourself (a Vercel build does **not** touch the database). See [§11](#11-alternative-vercels-native-git-integration).

---

## 1. Prerequisites

- A **Vercel** account and a **Neon** account.
- This repo on **GitHub** with Actions enabled (the pipeline gates on a `production` GitHub *Environment*).
- **Node 22+** and **pnpm 10+** locally (`packageManager` is pinned to `pnpm@10.33.2`) for the one-time database bootstrap in [§3](#3-one-time-database-bootstrap).
- The **Vercel CLI** (`pnpm add -g vercel`) for linking the project. CI pins `vercel@54.14.5`.

---

## 2. Provision the Neon database

1. Create a Neon **project** (Postgres 17 is fine). Pick a region close to Vercel's `iad1` (pinned in [`vercel.json`](../vercel.json)) — e.g. **AWS `us-east-1`/`us-east-2`** — to keep query latency low.
2. Neon gives you **two connection strings for the same database**:
   - **Direct / unpooled** (no `-pooler` in the host) → migrations (`PRODUCTION_DIRECT_DATABASE_URL`) **and, by default, runtime** (`DATABASE_URL`) too. The app sets its schema via a per-connection `search_path` **startup parameter**, which a transaction pooler rejects (`08P01 unsupported startup parameter`) — along with the DDL + advisory locks the migrator needs.
   - **Pooled** (the host contains `-pooler`, e.g. `…-pooler.neon.tech`) → preferred for serverless runtime **at scale**, but only after you make the app pooler-compatible: set `DB_SEARCH_PATH_VIA_OPTIONS=0` and run `ALTER ROLE <db_role> SET search_path = "auth", public;` so the schema still resolves without the rejected startup parameter (see [§12](#12-operations--gotchas)). Migrations still use the direct endpoint.
   - Keep `?sslmode=require` on both (Neon enforces TLS).
3. **Extensions and schema are handled by the migrations** — you do **not** create them by hand. Migration `0001` creates the `pgcrypto` and `pg_trgm` extensions (in `public`) and every `app_*` table. All tables land in the schema named by `DB_SCHEMA` (default **`auth`**), applied at the connection level via `search_path`; extensions stay in `public` so every schema can resolve them.

---

## 3. One-time database bootstrap

> **This is the step CI does not do, and the most common first-deploy mistake.** The deploy workflow runs **only `db:app:migrate`**. The **Better Auth** tables (`user`, `session`, `account`, `verification`) and the baseline seed are **not** created by CI — you must run them **once** against a fresh database.

This runs **on your own machine** (your laptop, or a one-off CI runner) and connects to the Neon database over the network — you do **not** run it on Neon itself, and it is **not** SQL you paste into Neon's console. You need the repo checked out plus **Node 22+ / pnpm 10+**, and the Neon **direct** (unpooled) connection string. **One command provisions everything:**

**macOS / Linux / Git Bash:**

```bash
cd /path/to/devresponsekit
pnpm install --frozen-lockfile

export DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx.us-east-1.aws.neon.tech/neondb?sslmode=require"  # DIRECT / unpooled
export DB_SCHEMA="auth"
export SEED_ADMIN_EMAIL="you@example.com"
export SEED_ADMIN_PASSWORD="<a strong password>"

pnpm db:provision
```

**Windows PowerShell** (the `export` syntax above is bash — set the variables this way instead):

```powershell
cd C:\path\to\devresponsekit
pnpm install --frozen-lockfile

$env:DATABASE_URL        = "postgresql://USER:PASSWORD@ep-xxxx.us-east-1.aws.neon.tech/neondb?sslmode=require"  # DIRECT / unpooled
$env:DB_SCHEMA           = "auth"
$env:SEED_ADMIN_EMAIL    = "you@example.com"
$env:SEED_ADMIN_PASSWORD = "<a strong password>"

pnpm db:provision
```

`pnpm db:provision` ([`src/db/provision.ts`](../src/db/provision.ts)) runs the full initial setup in order, fail-fast:

1. **`db:auth:migrate`** — Better Auth tables (`user`/`session`/`account`/`verification`). **CI never runs this.**
2. **`db:app:migrate`** — extensions (`pgcrypto`, `pg_trgm`) + the **core** app schema (`0001-initial-schema.sql` … `0005-…`, English-only), then the **localized data** under `src/db/migrations/locales/` (non-English email templates). Locales are applied by default; set `DB_MIGRATE_LOCALES=0` for an English-only database. CI re-runs this on every deploy.
3. **`db:seed`** — the default org, the `admin.*` permission catalog, baseline roles, and your first admin (from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).

(Prefer to run them yourself? The three steps still work as individual `pnpm` commands.)

Notes:

- `db:provision` and every step it runs are **idempotent and ledgered** (applied migrations are recorded in `app_schema_migrations`), so re-running it — or letting CI re-run `db:app:migrate` on each deploy — only applies new work.
- `db:seed` is safe to re-run (all writes are `on conflict do nothing`). It provisions your first admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
- **Never** run `db:seed:dev` against production — it creates 21 accounts that all share one weak password and refuses to run under `NODE_ENV=production` unless explicitly forced.
- **English-only install:** the localized migrations in `src/db/migrations/locales/` are applied by default. Set `DB_MIGRATE_LOCALES=0` (or `false`/`no`/`off`) to skip them — the non-English email-template rows are then absent and those recipients fall back to English. The core schema + English baseline (`0001 … 0005`) always apply.

---

## 4. Create and link the Vercel project

1. From the repo root: `vercel link` (or create the project in the dashboard and import the repo). Framework preset: **Next.js**.
2. Capture the project identifiers — after linking they're in `.vercel/project.json`:
   - `orgId`  → GitHub secret `VERCEL_ORG_ID`
   - `projectId` → GitHub secret `VERCEL_PROJECT_ID`
3. Create a deploy token: Vercel **Account Settings → Tokens** → GitHub secret `VERCEL_TOKEN`.
4. Because CI builds and uploads a prebuilt artifact (`vercel deploy --prebuilt`), Vercel's own build settings are largely bypassed. Leave the defaults (Install: `pnpm install`, Build: `next build`) — they only matter if you switch to native Git builds ([§11](#11-alternative-vercels-native-git-integration)).

---

## 5. Set environment variables in Vercel (Production)

Set these in **Vercel → Project → Settings → Environment Variables → Production**. `vercel build` pulls them in CI, and the deployed functions read them at runtime.

> **Validation is at runtime, not build time.** A missing required variable will **not** fail `next build` — the app will throw a 500 on the first request that needs it. Set everything below *before* sending real traffic. The full, authoritative catalog (≈60 variables) is in [Configuration](configuration.md) and [`.env.example`](../.env.example); the deployment-critical subset is here.

### Required — the app will not boot without these

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Neon **direct/unpooled** URL (`…?sslmode=require`). To use the **pooled** endpoint instead, also set `DB_SEARCH_PATH_VIA_OPTIONS` (below) + run an `ALTER ROLE` — see [§12](#12-operations--gotchas) |
| `BETTER_AUTH_SECRET` | strong random string, ≥ 16 chars |
| `BETTER_AUTH_URL` | `https://<your-domain>` |
| `SSO_HANDOFF_ISSUER` | `https://<your-domain>` |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | e.g. `myapp` |
| `SSO_HANDOFF_APPLICATION_ID` | e.g. `portal` — identifies this deployment in SSO audiences |
| `SSO_HANDOFF_JWT_SECRET` | a **second** strong random string, ≥ 16 chars |
| `NEXT_PUBLIC_APP_URL` | `https://<your-domain>` (build-time inlined) |
| `NEXT_PUBLIC_PRODUCTION_HOST` | `<your-domain>` (host only, no scheme) |

> The four `SSO_HANDOFF_*` variables are required **even if you never use cross-app SSO** — they're validated at boot. Set sane placeholder values. `NODE_ENV=production` is set by Vercel automatically.

### Strongly recommended

| Variable | Value / purpose |
| --- | --- |
| `DB_SCHEMA` | `auth` (must match what you bootstrapped in §3) |
| `ADMIN_TRUSTED_ORIGINS` | `https://<your-domain>` — trusted origin for admin mutations |
| `CRON_SECRET` | long random string — **enables** the outbox-drain cron (see [§7](#7-the-outbox-drain-cron)); the endpoint **fails closed** without it |
| `PGPOOL_MAX` | keep small on serverless (e.g. `3`–`5`); each function instance opens its own pool |
| `DB_SEARCH_PATH_VIA_OPTIONS` | set to `0` **only if `DATABASE_URL` is a pooled endpoint** (Neon pooled / PgBouncer), and pair it with an `ALTER ROLE … SET search_path` — see [§12](#12-operations--gotchas). Leave unset for a direct endpoint |

### Optional features

- **Email delivery** (otherwise emails are rendered and recorded but never sent): `EMAIL_PROVIDER` (`resend` \| `mailgun`), `EMAIL_FROM`, and `RESEND_API_KEY` *or* (`MAILGUN_API_KEY` + `MAILGUN_DOMAIN`).
- **Social login**: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `MICROSOFT_*`, `GITHUB_*` (each pair empty = that provider is hidden).
- **Error monitoring** ([Observability](observability.md)): `NEXT_PUBLIC_SENTRY_DSN` enables Sentry; add `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` for build-time source-map upload.
- **Metrics**: `METRICS_TOKEN` gates `GET /api/metrics` (Prometheus); fails closed without it.
- **Machine API credentials** ([API keys & tokens](design-api-keys-and-tokens.md)): `API_KEYS_ENABLED`, `API_JWT_ENABLED` + `API_JWT_PRIVATE_KEY`, etc. — both ship dark.
- **Retention windows** for `db:prune`: `AUDIT_RETENTION_DAYS` (365), `OUTBOX_RETENTION_DAYS` (90).

---

## 6. Configure the GitHub Actions deploy pipeline

The workflow gates on a `production` GitHub **Environment**. In the repo: **Settings → Environments → New environment → `production`**, then add:

**Secrets:**

| Secret | Value |
| --- | --- |
| `VERCEL_TOKEN` | the deploy token from §4 |
| `VERCEL_ORG_ID` | `orgId` from `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | `projectId` from `.vercel/project.json` |
| `PRODUCTION_DIRECT_DATABASE_URL` | Neon **direct / unpooled** URL (`?sslmode=require`) — used by the migrate step |

**Variables (optional):**

| Variable | Value |
| --- | --- |
| `DB_SCHEMA` | `auth` (defaults to `auth` if unset) |

Optionally add **required reviewers** to the `production` environment so each deploy needs an approval.

---

## 7. The outbox-drain cron

[`vercel.json`](../vercel.json) declares one scheduled job:

```json
"crons": [{ "path": "/api/internal/outbox-drain", "schedule": "0 8 * * *" }]
```

- It runs **daily at 08:00 UTC** and retries `pending` rows in `app_outbox` (email-delivery retries) — the serverless substitute for a long-running `pnpm outbox:drain` worker.
- Vercel Cron automatically calls it with `Authorization: Bearer <CRON_SECRET>`. **Set `CRON_SECRET` in Vercel env** (§5) or the route returns 401 and no mail is ever retried (fail-closed by design).
- A once-daily cron works on **all Vercel plans** (Hobby included; higher frequencies need Pro).

> **Retention prune is not scheduled in this repo.** `pnpm db:prune` (token-revocation + audit/outbox retention) has no entry in `vercel.json`. If you want it, add a second cron pointing at a route that runs the prune, or schedule it externally.

---

## 8. Deploy

Push to `main` (or run the workflow manually from the Actions tab). The pipeline:

1. Checks out, installs Node 22 + pnpm, runs `pnpm install --frozen-lockfile`.
2. Runs `pnpm db:app:migrate` against `PRODUCTION_DIRECT_DATABASE_URL`.
3. `vercel pull --environment=production` → `vercel build --prod` → `vercel deploy --prebuilt --prod`.

If step 2 fails, the build is never promoted — production keeps running the previous deployment.

---

## 9. Custom domain

1. Add your domain in **Vercel → Project → Settings → Domains** and follow the DNS instructions.
2. Update `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_PRODUCTION_HOST`, `SSO_HANDOFF_ISSUER`, and `ADMIN_TRUSTED_ORIGINS` to the real host.
3. **Redeploy** — the `NEXT_PUBLIC_*` values are inlined at build time, so they only take effect after a fresh build.

---

## 10. Post-deploy verification

- `GET https://<domain>/` → the landing page returns 200.
- Sign in with the seed admin from §3.
- `GET https://<domain>/api/internal/outbox-drain` **without** the bearer header → **401** (confirms the cron is fail-closed).
- In Neon's SQL editor: tables exist in the `auth` schema, and `select id from auth.app_schema_migrations order by id` lists the applied migration ids — core (`0001-initial-schema.sql` …) and, unless `DB_MIGRATE_LOCALES=0`, the localized ones (`locales/0001-…` …).
- If Sentry is configured, trigger a test error and confirm it lands.
- If `METRICS_TOKEN` is set, `GET /api/metrics` with `Authorization: Bearer <token>` returns Prometheus text.

---

## 11. Alternative: Vercel's native Git integration

If you'd rather have Vercel build on every push (no GitHub Actions), you can — with caveats:

- A Vercel build **does not run migrations**. You must apply them yourself: run `pnpm db:app:migrate` (and, for a fresh DB, the [§3](#3-one-time-database-bootstrap) bootstrap) against the **direct** endpoint before the new build serves traffic — e.g. from a separate CI job or manually.
- Set the same env vars from §5 in the Vercel project.
- **Disable the GitHub Actions workflow** (or the repo's `production` environment) so you don't deploy twice.
- You lose the automatic migrate-first ordering, so coordinate schema-changing releases carefully.

For most teams the built-in workflow ([§0](#0-how-this-repo-deploys-read-this-first)) is the safer default.

---

## 12. Operations & gotchas

- **Direct endpoint by default; pooled needs two changes.** The app sets `search_path` via a per-connection startup parameter, which a **transaction pooler rejects** (`08P01 unsupported startup parameter in options: search_path`) — so both migrations and runtime use the **direct/unpooled** endpoint by default. To run the runtime on the **pooled** endpoint (better for serverless concurrency), make the app pooler-compatible: (1) run `ALTER ROLE <db_role> SET search_path = "auth", public;` once against the database (a role default the pooler honors — `<db_role>` is the user in your connection string, e.g. Neon's `neondb_owner`), and (2) set `DB_SEARCH_PATH_VIA_OPTIONS=0` in Vercel so the app stops sending the rejected parameter. Migrations still use the direct endpoint.
- **Schema changes** ship as new numbered files in `src/db/migrations/`: core changes continue **monotonically** at `0011-…` (numbers are never reused — `0006-0010` were relocated to `locales/`), and localized data goes in `src/db/migrations/locales/` (its own `0001-…` sequence, applied unless `DB_MIGRATE_LOCALES=0`). CI applies them migrate-first on the next deploy; never edit an applied migration.
- **Rollback.** Roll the app back by promoting a previous deployment in Vercel. Migrations are additive and have no down-migrations, so the older build runs safely against the newer schema (forward-compatible by design).
- **Connection limits.** Neon caps concurrent connections (especially on the free tier). On the **direct** endpoint keep `PGPOOL_MAX` small (e.g. `3`); if that's tight under serverless concurrency, move runtime to the **pooled** endpoint via the two steps above.
- **Region.** `vercel.json` pins `iad1`; keep Neon in a nearby AWS region to minimize round-trips.
- See [Troubleshooting](troubleshooting.md) and [DevOps Setup](devops-setup.md) for the platform-neutral operational details.
