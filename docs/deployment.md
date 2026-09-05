---
title: Deployment
description: How the repo ships to production on Vercel and Neon, the DB bootstrap, and release checks.
group: General
order: 60
---

# Deployment

_Audience: DevOps and release engineers. How this repo ships to production, the one-time database bootstrap, and how to verify a release._

This repo deploys to **Vercel** with a **Neon** serverless Postgres database via a **GitHub Actions** pipeline. For the full environment-variable catalog see [Configuration](./configuration.md); for the self-host/container path see [Docker](./docker.md).

---

## 1. How this repo deploys

The pipeline is **GitHub-Actions-driven, CI-gated, and migrate-first** — it does **not** use Vercel's native "build on git push" integration. [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs when the **CI workflow completes successfully for `main`** (`workflow_run` trigger — a failed CI run never deploys), or on manual `workflow_dispatch`, gated behind a `production` GitHub Environment, and does, in order:

1. `pnpm db:app:migrate` against the **direct (non-pooled)** Neon endpoint (`PRODUCTION_DIRECT_DATABASE_URL`).
2. `vercel pull` → `vercel build --prod` → `vercel deploy --prebuilt --prod` — builds locally in CI and promotes the prebuilt output.

The point of this shape is the **migrate-first contract**: the new build goes live only **after** migrations succeed, so the currently-live build always sees a schema it understands. If step 1 fails, nothing is promoted and production keeps running the previous deployment. This relies on migrations being additive/idempotent (see §5).

**Two environment stores.** They are separate and serve different phases:

| Store | Holds | Read by |
| --- | --- | --- |
| **GitHub Actions secrets** (the `production` environment) | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `PRODUCTION_DIRECT_DATABASE_URL` (optional var `DB_SCHEMA`) | the deploy pipeline |
| **Vercel env** (Project → Settings → Environment Variables → Production) | runtime + build vars (`DATABASE_URL`, auth secrets, feature flags, `NEXT_PUBLIC_*`, …) | `vercel build` and the deployed functions at runtime |

> **Do NOT also enable Vercel's native Git auto-deploy.** Connecting the repo for Vercel to build on push would **double-deploy and skip the migration step**. Leave the project unconnected to Git, or disable production auto-builds (Vercel → Project → Settings → Git) so this workflow is the sole path to production. The `output: "standalone"` setting in [`next.config.mjs`](../next.config.mjs) is for the Docker image only — Vercel ignores it; no action needed.

---

## 2. One-time database bootstrap

CI runs **only `db:app:migrate`** on each deploy. The Better Auth tables (`user`, `session`, `account`, `verification`) and the baseline seed are **not** created by CI — you run them **once** against a fresh database. This is the most common first-deploy mistake.

Run it from your own machine (laptop or a one-off runner) with the repo checked out, **Node 24 / pnpm 10+**, and the Neon **direct (unpooled)** connection string — it connects over the network; it is not SQL you paste into Neon's console.

```bash
pnpm install --frozen-lockfile

# Windows PowerShell: use `$env:NAME = "value"` instead of `export`.
export DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx.us-east-1.aws.neon.tech/neondb?sslmode=require"  # DIRECT / unpooled
export DB_SCHEMA="auth"
export SEED_ADMIN_EMAIL="you@example.com"
export SEED_ADMIN_PASSWORD="<a strong password>"

pnpm db:provision
```

`pnpm db:provision` ([`src/db/provision.ts`](../src/db/provision.ts)) runs the full setup in order, fail-fast:

1. **`db:auth:migrate`** — Better Auth tables (`user`/`session`/`account`/`verification`). **CI never runs this.**
2. **`db:app:migrate`** — extensions (`pgcrypto`, `pg_trgm`, created in `public`) + the **core** app schema, then the **localized data** under `src/db/migrations/locales/`. **CI re-runs this on every deploy.**
3. **`db:seed`** — the default org, the `admin.*` permission catalog, baseline roles, and your first admin (from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`). The demo satellite apps it registers for the local dev rig are **skipped** under `NODE_ENV=production` (opt in with `SEED_DEMO_APPS=1`); register real enterprise apps via the admin console instead.

Every step is **idempotent and ledgered** — applied migrations are recorded in `app_schema_migrations`, so re-running `db:provision` (or letting CI re-run `db:app:migrate`) only applies new work. All tables land in the schema named by `DB_SCHEMA` (default `auth`); extensions stay in `public` so every schema resolves them.

Notes:

- **English-only install:** the email templates live under `src/db/migrations/locales/`, one file per locale, applied by default. Set `DB_MIGRATE_LOCALES=0` (or `false`/`no`/`off`) to skip the **localized** files — the non-English email-template rows are then absent and those recipients fall back to English. The core schema and the English base (`locales/0000-email-templates-en.sql`, always applied) install regardless, so an English-only database still has every template.
- `db:seed` is safe to re-run: every insert is `on conflict do nothing`, and its one update — relaxing the platform sign-up default from the migration's fail-closed `admin_approval` to `auto_active` — is **first-run only**. It is gated on the row never having been edited by an administrator (`updated_by IS NULL`; the admin API stamps it on every edit), so a re-run after you tightened the policy under **Administrator → Platform sign-up defaults** leaves it exactly as configured and prints `[seed] platform sign-up policy left as configured (admin-managed)`. See [Sign-up policy §5](./auth-signup-policy.md#5-activation-re-evaluation-at-sign-in). In production, change the seeded admin password immediately or supply non-default `SEED_ADMIN_*` values.
- **The seed admin is provenance-gated** ([`src/db/seeds/default-admin.ts`](../src/db/seeds/default-admin.ts)). The seed fully escalates (verifies, activates, grants `admin` + `admin.platform` + `superuser`) **only an account it creates itself** in that run. On a re-run it recognises its own admin — the account is already email-verified **and** already holds `superuser` — and re-inserts any missing grants without touching anything else: a seed admin you have since **blocked, suspended or deactivated stays that way** (the run prints `[seed] admin … left as configured (status=blocked)`). Any **other** pre-existing account matching `SEED_ADMIN_EMAIL` — e.g. someone who self-registered that address before you bootstrapped, or an admin whose verification was revoked — makes the seed **refuse** (`[seed] REFUSED to escalate pre-existing account …`, exit code 1, nothing written). If that account really is yours, re-run with `SEED_ADMIN_ADOPT_EXISTING=1` to confer the admin grants on it; even then its password, `emailVerified` flag and status are left as found, and a later plain re-run keeps refusing until the account is verified. Otherwise point `SEED_ADMIN_EMAIL` at an unregistered address.
- **Never** run `db:seed:dev` against production — it creates 24 accounts (21 org-scoped + 3 cross-org members) sharing one weak password, three of them cross-tenant superusers. Two independent guards make this hard to do by accident ([`src/db/guards.ts`](../src/db/guards.ts)): the seed refuses under `NODE_ENV=production` (override `DEV_SEED_ALLOW_PROD=1`), and — whatever `NODE_ENV` says, since it is routinely unset in a shell whose `.env` holds a production URL — it refuses any `DATABASE_URL` whose host is not local (`localhost` / `127.0.0.1` / `::1` / `0.0.0.0` / none; an unparseable URL counts as remote). Both checks run before a connection is opened, so a refusal writes nothing. The host guard is lifted only by `--force` or `DEV_SEED_ALLOW_REMOTE=1`; `db:reset` shares the same host check.

---

## 3. Vercel project + environment

1. From the repo root: `vercel link` (or import the repo in the dashboard). Framework preset: **Next.js**.
2. Capture the identifiers from `.vercel/project.json` → GitHub secrets: `orgId` → `VERCEL_ORG_ID`, `projectId` → `VERCEL_PROJECT_ID`. Create a deploy token (Vercel Account Settings → Tokens) → `VERCEL_TOKEN`.
3. In the repo, create the `production` GitHub Environment (Settings → Environments) and add the secrets above plus `PRODUCTION_DIRECT_DATABASE_URL` (Neon **direct/unpooled** URL). Optionally add required reviewers so each deploy needs approval.

**Set runtime env in Vercel (Production).** [Configuration](./configuration.md) is the **authoritative** list of every variable (≈60); set it there. Validation is at **runtime, not build time** — a missing required var will not fail `next build`, it throws a 500 on the first request that needs it, so set everything before sending real traffic. The deployment-critical must-set production secrets:

- `BETTER_AUTH_SECRET` — strong random string (≥ 32 chars).
- `BETTER_AUTH_URL` — `https://<your-domain>` (also set `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_PRODUCTION_HOST` to the same origin/host).
- `DATABASE_URL` — see the endpoint decision below.
- The three `SSO_HANDOFF_*` vars — `SSO_HANDOFF_ISSUER` (the primary's origin URL), `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID`. Required **even if you never use cross-app SSO** — they are validated at boot; set sane placeholders. If this deployment **issues** handoffs (it is the primary of a satellite fleet) also set `SSO_HANDOFF_PRIVATE_KEY` — an Ed25519 private JWK, generated per [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff), **distinct** from `API_JWT_PRIVATE_KEY`. Satellites never get it; they verify against `https://<primary>/api/sso/jwks.json`.

`NODE_ENV=production` is set by Vercel automatically. The `NEXT_PUBLIC_*` values are inlined at build time, so changing a domain requires a **redeploy**.

**`DATABASE_URL`: direct vs. pooled.** Neon gives two connection strings for the same database. By default point `DATABASE_URL` at the **direct/unpooled** endpoint (no `-pooler` in the host). To use the **pooled** endpoint (better serverless concurrency), make the app pooler-compatible first — see §5. Keep `?sslmode=require` on both. **Migrations always use the direct endpoint.**

---

## 4. Deploy + post-deploy verification

Push to `main` (or run the workflow from the Actions tab). After it completes, verify:

- [ ] `GET https://<domain>/` → the landing page returns **200**.
- [ ] Sign in with the seed admin from §2; the session persists.
- [ ] `GET https://<domain>/api/internal/outbox-drain` **without** the bearer header → **401** (confirms the cron endpoint is fail-closed).
- [ ] In Neon's SQL editor, `select id from auth.app_schema_migrations order by id` lists the applied ids — the core `000N-*.sql` files (`0001-initial-schema.sql`, `0002-admin-groups-permissions.sql`, `0003-outbox-delivery-payload.sql`, `0004-oauth-client-secret-rotated-at.sql`, `0005-integrity-constraints.sql`, …), the always-applied `locales/0000-email-templates-en.sql`, and (unless `DB_MIGRATE_LOCALES=0`) the localized `locales/0001-…` files.
- [ ] If Sentry is configured, trigger a test error and confirm it lands ([Observability](./observability.md)).
- [ ] If `METRICS_TOKEN` is set, `GET /api/metrics` with `Authorization: Bearer <token>` returns Prometheus text.

> **The outbox-drain cron.** [`vercel.json`](../vercel.json) declares one scheduled job hitting `GET /api/internal/outbox-drain` **daily at 08:00 UTC** to retry `pending` rows in `app_outbox` (the serverless substitute for a long-running drain worker). Vercel Cron calls it with `Authorization: Bearer <CRON_SECRET>`, so **set `CRON_SECRET` in Vercel env** or the route returns 401 and no mail is ever retried. Daily works on all Vercel plans (Hobby included); higher frequencies need Pro. `pnpm db:prune` (token-revocation + audit/outbox retention) is **not** scheduled in this repo — add a cron or external caller if you want it.

---

## 5. Operations & gotchas

**Single application instance (1.0).** The abuse-mitigation **rate limiter** on admin mutations, bulk operations, and CSV export is **in-process** (`src/lib/admin/rate-limit.server.ts`) — its budget lives in one Node process's memory and **resets on restart**. With more than one instance (multiple containers, or serverless where each invocation is a separate process) the limit degrades to best-effort: it is enforced per instance and effectively multiplies by the instance count. The limiter layers on top of the real authorization checks, so this is a hardening regression, not an authz hole. For a hard, cluster-wide limit, run a single instance; a shared (Redis/Postgres) backend is planned post-1.0. (This applies only to the **application** tier — Postgres is external and unaffected.)

**Direct endpoint by default; pooled needs two changes.** The app sends three per-connection **startup parameters**: `search_path` (`-c search_path=…`) plus the `statement_timeout` / `idle_in_transaction_session_timeout` ceilings from `src/db/database.ts` (`pg` puts those in the startup packet too). A **transaction pooler rejects** startup parameters — every connection fails with `08P01 unsupported startup parameter in options: search_path` — along with the DDL + advisory locks the migrator needs. So both migrations and runtime use the **direct/unpooled** endpoint by default. To run the **runtime** on the **pooled** endpoint:

1. Set all three as role defaults the pooler honors, once against the database (`<app_role>` is the user in your connection string, e.g. Neon's `neondb_owner`). The `30s` values match what the code sends by default (`PG_STATEMENT_TIMEOUT_MS` / `PG_IDLE_IN_TX_TIMEOUT_MS` = 30000); mirror any override you set:

   ```sql
   ALTER ROLE <app_role> SET search_path = "auth", public;
   ALTER ROLE <app_role> SET statement_timeout = '30s';
   ALTER ROLE <app_role> SET idle_in_transaction_session_timeout = '30s';
   ```

2. Set `DB_SEARCH_PATH_VIA_OPTIONS=0` in Vercel so the app stops sending **all three** rejected parameters (review #20 — the flag used to strip only `search_path`, and the pooler rejected the timeouts just the same). Verify with `show statement_timeout;` on a pooled connection: it must read `30s`, not `0`.

Migrations still use the direct endpoint. Keep `PGPOOL_MAX` small on serverless (each function instance opens its own pool).

**Shutdown on Vercel is a no-op; on a long-running server it is a two-step drain.** Vercel never delivers `SIGTERM` to a warm function in the normal freeze/teardown path, and the app's shutdown watchdog (`src/lib/shutdown.server.ts`) registers nothing when the platform's `VERCEL` variable is set — pool connections are simply dropped when the function instance is recycled. On `next start` / the container (`docs/docker.md` §7), Next's own cleanup drains HTTP and exits `143`/`130`; the watchdog only ends the pool and exits with the same code if that drain overruns `SHUTDOWN_TIMEOUT_MS` (review #24).

**Schema changes** ship as new numbered files in `src/db/migrations/` — never edit an applied migration:

- **Core** — `0001-initial-schema.sql` is the frozen baseline; further schema changes are added as new **numbered `NNNN-*.sql`** files, applied in lexical order after it and recorded once each in the ledger.
- **Email templates** — one file per locale — go in `src/db/migrations/locales/`. The English base `locales/0000-email-templates-en.sql` is ALWAYS applied (the fallback every locale resolves to); the localized files (`locales/0001-…`+) apply unless `DB_MIGRATE_LOCALES=0`. Ledger ids are path-prefixed (`locales/<file>`) so they can never collide with a core filename.

CI applies them migrate-first on the next deploy.

**Rollback.** Roll the app back by **promoting a previous deployment** in Vercel (dashboard → previous deployment → "Promote to Production", or `vercel rollback`). Migrations are **forward-only** — additive, with **no down-migrations** — so the older build runs safely against the newer schema (forward-compatible by design). The deploy pipeline migrates *before* promoting, so a rollback needs no DB change. A migration that genuinely must be reverted is authored as a **new forward migration**. To recover lost *data* (not a bad deploy), use your provider's PITR/snapshot, not a schema revert.

See [Troubleshooting](./troubleshooting.md) for operational issues.

---

## 6. Self-host / container

A production-ready multi-stage `Dockerfile` (built from the Next.js standalone output, non-root) is provided. Build/configure/run, running migrations as a separate init step, required env, a `docker compose` example, and hardening are all in **[Docker](./docker.md)**.

---

## 7. CI

CI is **[`.github/workflows/`](../.github/workflows/)** (source of truth). [`ci.yml`](../.github/workflows/ci.yml) runs on push + pull_request and validates quality and behavior — typecheck, lint, format, build, tests + coverage gate, DB-backed integration tests, Playwright e2e + accessibility, a `pnpm audit` hard gate, SDK/schema/doc-link drift checks — but does **not** itself deploy: [`deploy.yml`](../.github/workflows/deploy.yml) fires only after this workflow **succeeds** on `main` (§1). Separate workflows run Trivy, CodeQL, gitleaks, and an advisory Stryker mutation-testing pass on the security core (`mutation.yml`). See [Testing](./testing.md).

---

## 8. Least-privilege runtime role (optional, recommended)

By default the application connects as the same role that runs migrations and owns every table (Neon's `neondb_owner`, the local `devresponse`). That role can do anything to the schema — including deleting audit rows — so the audit log's append-only trigger is a guard against accidents, not a privilege boundary. Migration `0004-integrity-constraints.sql` (review #83) splits the two:

- **Owner / migration role** — whatever `DATABASE_URL` you run `pnpm db:app:migrate` / `db:provision` with. Owns the tables, the trigger and the `SECURITY DEFINER` retention function `app_audit_events_prune(days, batch)`.
- **Runtime role `<DB_SCHEMA>_runtime`** (`auth_runtime` by default) — created by 0004 as `NOLOGIN` with **no password**, holding `USAGE` on the schema, `SELECT/INSERT/UPDATE/DELETE` on every table **except** `UPDATE/DELETE/TRUNCATE` on `app_audit_events` (`INSERT`/`SELECT` only), and `EXECUTE` on the retention function. Default privileges are set so tables a later migration creates are covered automatically. The append-only trigger permits a `DELETE` only when the **effective** role is the table owner inside that function, so a stolen runtime credential cannot purge or rewrite audit history even by setting the `app.audit_retention` marker.

Nothing changes until you switch the app's connection string. To adopt it, once, against the **direct** endpoint as the owner role:

```sql
alter role auth_runtime login password '<a strong secret>';
-- Only if the runtime uses the POOLED endpoint (§5): the pooler drops the
-- startup search_path, so pin it on the role as well.
alter role auth_runtime set search_path = "auth", public;
```

Then set the **runtime** `DATABASE_URL` (Vercel → Environment Variables, or the container's env) to the same host/database with `auth_runtime` as the user, redeploy, and verify: sign in, open an admin page, and confirm `select count(*) from auth.app_audit_events` keeps growing. Keep the owner role's connection string for `pnpm db:app:migrate` / `db:provision` / `db:seed` / `db:reset` (the deploy pipeline and CI keep using it). `pnpm db:prune` works under either role — the retention job goes through the definer function.

If the migrating role lacks `CREATEROLE` (some managed providers), 0004 prints a `NOTICE` with the manual steps instead of failing: create the role yourself (`create role auth_runtime nologin;`) and re-run `pnpm db:app:migrate` — the grant block is idempotent and runs on any later pass. (Neon's `neondb_owner` can create roles.)

**Ledger checksums (review #86).** `app_schema_migrations` now records a sha256 `checksum` per applied file; the runner refuses to proceed if an applied file's hash differs from the ledger, printing the id and both hashes. Rows ledgered before this column existed are backfilled on the next run (logged as `[migrate] backfilled checksum for …`). A deliberate comment-only fix to a frozen file therefore needs the pinned hash in `tests/unit/migration-checksums.test.ts` AND the ledger row in every migrated database updated on purpose — the error message prints the exact `update … set checksum = …` statement. The runner also holds `pg_advisory_lock(hashtext('app_schema_migrations'))` for the whole run (review #85), so a redeploy racing a manual migrate serialises instead of colliding.

---

_Next: [Configuration](./configuration.md) · [Docker](./docker.md) · [Troubleshooting](./troubleshooting.md)_
