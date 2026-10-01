---
title: Deployment
description: How the repo ships to production on Vercel and Neon, the DB bootstrap, and release checks.
group: General
order: 60
---

# Deployment

_Audience: DevOps and release engineers. How this repo ships to production, the one-time database bootstrap, and how to verify a release._

This repo deploys to **Vercel** with a **Neon** serverless Postgres database. For the full environment-variable catalog see [Configuration](./configuration.md); for the self-host/container path see [Docker](./docker.md).

---

## 1. How this repo deploys

**Production ships through Vercel's own Git integration, with automated migrations and a schema gate: every push to `main` is built by Vercel and, at the same time, migrated by the `migrate-production.yml` workflow (§1.2), and the build is promoted only once its schema gate finds the database ready for that commit.** Until an operator gives that workflow its one secret (§3), or when its run has failed, the migrations are applied by hand: the fallback in §1.1.

The repo also carries a local command-line client, `drk-deploy` (§1.3), that migrates, builds and promotes in that order on demand. The Actions pipeline that used to do the same, `deploy.yml`, was never configured and is retired (§1.2).

### 1.1 The live path: Vercel Git integration, automated migrations, schema gate

|                                 | What happens                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trigger**                     | every push to `main` — a merge **is** a production deploy, once its build passes                                                                                                                                                  |
| **Deployer**                    | Vercel's Git integration (deployments appear under the repo's `Production` environment, created by `vercel[bot]`)                                                                                                                 |
| **Migrations**                  | `migrate-production.yml` on the same push, against production's direct endpoint as the owner, while Vercel builds (§1.2). Until its secret is set, or when its run failed: the hand gate below. Vercel itself never migrates      |
| **Gate**                        | `[deploy-gate]`, the last step of every production build: the build fails, and Vercel does not promote it, unless the database holds every core migration this commit needs, at its checksums, and Better Auth has nothing to add |
| **Env read at build + runtime** | Vercel → Project → Settings → Environment Variables → **Production**                                                                                                                                                              |

**The hand gate: the fallback.** Once the workflow is configured, merging is enough: it applies the merge's migrations and the gate waits for them, so do not also apply them from the pull request's branch. When one of its runs fails, the merge has already happened: fix the cause, re-run it and **Redeploy** the build (§1.2), or apply the migrations by hand from `main` as below. Until it is configured (its runs end green with a `not automated` notice), applying migrations is a person's job, in this order:

> **A pull request that adds or changes a migration is applied to production FIRST and merged SECOND.**
>
> While the PR is still open, run `pnpm db:app:migrate` against the production `DATABASE_URL` (the **direct/unpooled** endpoint — §5), confirm it succeeded, and only then merge. A PR that changes `src/db/migrations/better-auth-schema.sql` (a better-auth upgrade, a new plugin or field) is a migration too: run `pnpm db:auth:migrate` the same way first. Migrations are additive, idempotent and ledgered, so the live build keeps serving happily against the migrated schema ([Compatibility: expand, then contract](#compatibility-expand-then-contract), §5). Merging first no longer causes an outage: the merge's build fails at the schema gate and the previous deployment keeps serving until the migrations are applied.

Run the gate from the PR's branch as it is **pushed**, with nothing uncommitted or untracked in the checkout. The runner ledgers each file under a checksum, so whatever it applies is what production keeps. If review later changes a file that was applied from a local edit, every later migrate against production aborts on the checksum mismatch (§8), and every production build fails at the schema gate until the file is restored. `drk-deploy migrate` (§1.3) runs this gate with those checks enforced. It refuses a dirty or unpushed checkout, checks the URL against production's own settings, runs both migrators, and prints the commit it migrated from.

**The schema gate (DEP1).** [`vercel.json`](../vercel.json) makes `pnpm run vercel-build` the build command, which is `next build && tsx scripts/deploy-gate.ts`. A build command in `vercel.json` wins over the dashboard's Build Command, so the gate cannot be switched off from the project's settings, and `vercel build` (drk-deploy) runs it too. `pnpm build` stays plain `next build`, so CI's Build job and the Docker image do not run it. What the gate does, in [`scripts/deploy-gate.ts`](../scripts/deploy-gate.ts) and [`src/db/deploy-gate.ts`](../src/db/deploy-gate.ts):

- **Which builds.** Only a production build (`VERCEL_ENV=production`) is checked. A preview or development build prints `[deploy-gate] skip vercel-env=…` and never connects. A Vercel build without `VERCEL_ENV` is refused: enable **Automatically expose System Environment Variables** (Project → Settings → Environment Variables).
- **What it checks.** It connects with the build's own `DATABASE_URL`, the runtime credential already in Vercel's Production environment, honouring `DB_SCHEMA` and `DB_SEARCH_PATH_VIA_OPTIONS` exactly as the app does. It has no other credential. The connection must resolve to `DB_SCHEMA`; the ledger must hold every id in `REQUIRED_CORE_MIGRATIONS` (`src/db/migrations/migration-plan.ts`) under this commit's checksum of the file (a database migrated before the consolidation passes on its seven folded rows, [§5](#upgrading-a-database-from-before-the-consolidation)); and Better Auth's migrator must have no table, column or index to add. Then the runtime's privileges (DEP3, §8.5): a non-owner login must hold exactly the privilege manifest, and an owner build fails once a least-privilege login exists for the schema. It never writes. Ids the build does not know (a database ahead of the build) are fine.
- **How long it waits.** The first check runs as soon as `next build` finishes, then one every 10 seconds for up to `DEPLOY_GATE_WAIT_MS` milliseconds (default `600000`, ten minutes; at most `1800000`; `0` is one check). That is the window `migrate-production.yml` works in: it starts on the same push as the build, and the build passes as soon as the ledger is complete. A hand migration after the merge, within the ten minutes, works the same way. A missing migration or an unreachable database is retried until then. A ledger checksum that differs from the commit's file, or a Better Auth change it calls unsafe, fails at once. A check that hangs past every timeout is cut off a minute after the wait.
- **What it prints.** One line each, in the build log: `[deploy-gate] verify env=production infra=vercel commit=<12 chars> wait=600s`, then `[deploy-gate] target host=… port=… database=… schema=… user=… runtime=owner|non-owner` (host, port and database as the URL writes them, percent-escapes included, the user as the database reports it, never the password), an `attempt <n> behind|unreachable: …` line per retry, and `PASS schema current after <s>s runtime=owner|non-owner` or `FAIL <behind|fatal|unreachable|timeout>: …`. `runtime=owner` adds a warning that the least-privilege login (§8) is not adopted.
- **Local builds.** `drk-deploy deploy`/`up` migrate first and then run `vercel build --prod` on their own machine, where a sensitive `DATABASE_URL` comes back as `[SENSITIVE]` and cannot be checked. They pass the commit they migrated as `DEPLOY_GATE_PREBUILT_AFTER_MIGRATE`, and the gate skips. It honours that value only off Vercel's build machines and only when it is exactly the commit being built. On Vercel any value is refused, so **never set it in Vercel's environment**: a production build with it fails.

**When the gate fails, production has not changed**: Vercel does not promote a failed build, so the previous deployment keeps serving. Look at that commit's **Migrate production database** run first (§1.2's table says what each failure means). Once the migrations are in, by a re-run (`gh workflow run migrate-production.yml --ref main`) or by hand against the **direct** endpoint (the hand gate above, or `drk-deploy migrate`), **Redeploy** the failed deployment from Vercel's Deployments page, or push again. [Troubleshooting](./troubleshooting.md#production-build-failed-at-deploy-gate) has an entry for each `FAIL` class. There is deliberately no switch to turn the gate off. Break-glass, if the gate itself is wrong, is `git revert` of the commit that added it: the revert's `vercel.json` has no `buildCommand`, so that build runs no gate. An Instant Rollback or the promotion of an older deployment builds nothing, so the gate does not run then. The older build meets the newer schema, which is safe only because migrations follow [the expand/contract rule](#compatibility-expand-then-contract).

Readiness still reports the same gap without credentials, for anything that reaches production without a passing build (a deployment promoted by hand, a build from before the gate): `GET https://<domain>/api/health/ready` returns **503 `schema_behind`** while a live build is ahead of one of its migrations, and **200 `ready`** once the ledger is complete (§4). Since F-26 that covers the Better Auth half as well: readiness asks Better Auth's own schema check, which compares every table and column the running configuration writes with what the database holds. Before anyone looks at the probe the symptom is 500s confined to the routes that touch the new column or table, or, for a Better Auth table or column, a 500 on **every** sign-in and every authenticated page. Migration 0004 (`0004-oauth-client-secret-rotated-at.sql`, now a section of `0002-release.sql`, §5) documents the worked case (review #43); the runbook entry is in [Troubleshooting](./troubleshooting.md).

### 1.2 Automated migrations: `migrate-production.yml`

[`migrate-production.yml`](../.github/workflows/migrate-production.yml) (DEP2) is the database half of every production deploy. It runs on every push to `main`, and on a manual dispatch from `main`, alongside Vercel's build of the same commit:

1. **`preflight`** reads one thing: whether the `production-migrations` GitHub environment holds the secret `PRODUCTION_DIRECT_DATABASE_URL`. The secret's value never enters the job, only `true` or `false`. Without it the job writes a notice and a run summary ("migrations are not automated; docs/deployment.md §1.1 hand gate applies"), `migrate` is skipped, and the run is **green**.
2. **`migrate`** checks out the pushed commit, installs with `pnpm install --frozen-lockfile` (no secret in reach), then runs `pnpm db:auth:migrate` and `pnpm db:app:migrate`, Better Auth's tables first (F-26), each with the secret as `DATABASE_URL`, `DB_SCHEMA` from the repository variable of that name (default `auth`) and `DB_MIGRATE_LOCK_WAIT_MS=300000` (§5). The auth step gets CI placeholders for the variables `@/lib/auth` validates at load, the same ones `drk-deploy` uses: the Better Auth schema does not depend on them, so the database URL is the only secret it reads. A last step writes the commit to the run summary, never a URL. Its own `if:` restates the configured check and the `main`-ref guard rather than inheriting them through `needs:`.

The order between the workflow and Vercel's build does not matter: the build's schema gate (§1.1) polls for ten minutes until the migrations are in, and Vercel promotes only a build that passed. A migration that lands before the build that needs it is safe because every migration follows [the expand/contract rule](#compatibility-expand-then-contract) (§5). A run in progress is never cancelled (`concurrency: production-migrations` with `cancel-in-progress: false`): the next push's run waits for it. GitHub keeps only one waiting run per group, so a third push in quick succession cancels the run still waiting; the newer run applies the same migrations and more, since its tree contains them. The runners' advisory lock serialises them against any other migration, a hand run or `drk-deploy`, too.

**Why it runs on push and does not wait for CI.** `deploy.yml` waited for CI (audit #19) because it also PROMOTED. Promotion now belongs to Vercel's Git integration, which never waited for CI. `main` requires the CI checks with STRICT up-to-date branches, so the merged tree is the tree CI tested. Waiting for CI on `main` (the e2e job alone may take 30 minutes) would push the migrations past the gate's ten-minute window and fail every build that needs one. The residual risk is an admin-bypass merge of a red pull request: it would migrate, and it would ship through Vercel anyway.

**The secret is the owner's direct URL, and it stays in GitHub.** It is Neon's **direct** connection string for the role that owns the schema (host without `-pooler`, `?sslmode=require`): migrations create tables, the 0005 runtime role and its grants, and the runners refuse a pooled URL and a role that does not own the ledger (§5). It is exposed to the two migrate steps only, and it is never copied into Vercel, which keeps only the runtime `DATABASE_URL` (still the owner's login until the least-privilege role of §8 is adopted), so the runtime can move to that role. Adding it is the operator step in §3. The environment has **no required reviewers**: the migrations must land within the gate's window, and a merge has already been reviewed.

| Situation                                        | Effect                                                                                                                      | Recovery                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret not set                                   | `preflight` green with a notice, `migrate` skipped; the gate fails any build that needs a migration                         | the hand gate (§1.1), or add the secret (§3)                                                                                                               |
| A migration file fails                           | that file's transaction rolls back, earlier files stay ledgered, the job is red; the gate times out and nothing is promoted | fix the file in a new commit (a file production never ledgered may still be edited)                                                                        |
| Lock held (a hand run, a stuck session)          | the runner gives up after 300 s, the job is red, the gate fails                                                             | find the session in `pg_locks` ([Troubleshooting](./troubleshooting.md#migrate-production-database-run-failed)), then re-run the workflow and **Redeploy** |
| Secret points at the wrong database or schema    | the migrations land elsewhere; the gate reads production through the runtime URL, times out, and nothing is promoted        | fix the secret                                                                                                                                             |
| Pooled URL in the secret                         | refused before connecting                                                                                                   | store the direct URL                                                                                                                                       |
| GitHub Actions delayed past the gate's window    | the build fails                                                                                                             | `gh workflow run migrate-production.yml --ref main`, then **Redeploy** in Vercel                                                                           |
| Migrations succeed, the Vercel build fails later | the schema is ahead of the live code: safe under the expand/contract rule                                                   | the next commit                                                                                                                                            |
| Two quick merges                                 | migrations serialise (the concurrency group and the advisory lock); each build gates on its own required set                | none                                                                                                                                                       |
| Three or more quick merges                       | the newest push's run cancels the one still waiting and applies its migrations too                                          | none: look at the newer run. If the cancelled commit's build missed its gate window, the newer build ships instead                                         |

**`deploy.yml` is retired (DEP2).** It was an Actions pipeline that migrated and then promoted with `vercel build` and `vercel deploy`. It was never configured: it needed four secrets and Vercel's Git integration turned off, which contradicts the single production path above. What it got right carries over to `migrate-production.yml`: the secret scoped to the steps that use it, the trigger guard restated on the job that holds it, no fork-controlled code, a run in progress never cancelled, auth migrations before app migrations, CI placeholders, Node 24, and actions pinned by SHA (`tests/unit/migrate-workflow-guards.test.ts` pins all of it). So does DEPLOY-1's lesson, that an unconfigured pipeline must say so rather than fail every run or skip in silence: every run states in its summary whether it migrated. And since the gate, a workflow that skips cannot ship code ahead of its schema; the build fails instead.

The `output: "standalone"` setting in [`next.config.mjs`](../next.config.mjs) is for the Docker image only — Vercel ignores it; no action needed.

### 1.3 `drk-deploy`: the safe order, on demand

[`vercel-cli/README.md`](../vercel-cli/README.md) documents **`drk-deploy`**, a local client that encodes the same order — **migrate → build → promote → verify** — and needs no repository secrets. `drk-deploy deploy` applies migrations first and promotes only if they succeed; `drk-deploy up` syncs the environment first. It migrates only the database it is told to (`PRODUCTION_DIRECT_DATABASE_URL` in the shell or the `--from-env` file, or the deprecated `--database-url`, never a shell's `DATABASE_URL`), and before migrating it pulls production's settings read-only and refuses that URL unless its host, port and database are production's `DATABASE_URL` (or `DATABASE_URL_UNPOOLED`), migrating production's `DB_SCHEMA` (F-47). Like the migrate workflow, it applies `db:auth:migrate` before `db:app:migrate`, with the same CI placeholders for each variable `@/lib/auth` validates at load that the shell does not set, and without reading the checkout's `.env`, so the migration URL is all it needs (F-141). It refuses a pooled connection string for migrations, with no override (since DEP2 the runners it calls refuse one too, §5, so its old `--allow-pooled` is gone), never prints a secret value, and probes `/api/health`, `/api/health/ready` and a deliberately-wrong sign-in after promoting. A build that fails that probe is promoted back to the deployment production served before the run under `--rollback-on-fail`, the default under `--yes` (exit 4 when that restores a healthy production, 5 when it does not). Otherwise it stays live, exits 3, and the error prints the exact `vercel promote` command (F-51). **If you want one command that orders a deploy end to end, this is it.**

**It releases only a clean, pushed commit, and prints which (F-49).** Before anything writes, `deploy`, `up` and `migrate` read each checkout they release from (the kit, and a satellite's app folder when that is what is built) with read-only `git`, and refuse unless all of these hold:

- `git status --porcelain` is empty, **untracked files included**. No flag overrides this. The one exception is a `next-env.d.ts` modified in the working tree. Every `next build` rewrites it, the one `deploy` runs included, so it is named and set aside rather than refused, and `deploy` puts it back after its build.
- HEAD is pushed: a remote-tracking branch points at it.
- For `deploy` and `up`, which promote: HEAD is origin's default branch (`origin/HEAD`, else `origin/main`), or the pushed ref named with `--allow-ref <ref>`.
- For a satellite that owns its database: the kit checkout its migrations come from is at the kit's default branch, for `deploy`, `up` and `migrate` alike. No flag moves it.

The kit's own `migrate` may run from any pushed branch. That is how the §1.1 gate works: migrate from the open PR's branch, then merge. The gate is the kit's own, so it does not reach a satellite's database. Nothing is fetched. "Pushed" and "origin/main" are the remote-tracking refs as last fetched, so fetch first if the branch moved elsewhere. The commit, branch and tree state are printed before anything writes and again next to the database being migrated. That printed line is the only record of which commit a migration ran from: the ledger has no column for it. The promoted build's commit is recorded by Vercel.

Running `drk-deploy` does not stop Vercel's Git integration from deploying the same push. `drk-deploy deploy` and `up` therefore read the project's git connection first, and **refuse to migrate while it auto-deploys production** (F-49), unless you pass `--allow-git-integration-race`, because an ungated push would win the race to production. Auto-deploy counts as off only when no repository is connected, when `vercel.json` sets `git.deploymentEnabled` false for the production branch, or when the Ignored Build Step is exactly `exit 0`. A checkout whose every Vercel build runs the schema gate (`vercel.json` names `pnpm run vercel-build` and that script runs `scripts/deploy-gate.ts`, as the kit's do) is **gated**: Vercel promotes a push only once its migrations are applied, so `deploy` and `up` say so and go ahead (DEP1). A satellite's checkout has no gate and keeps the refusal. They pass the commit they migrated to their own `vercel build` (`DEPLOY_GATE_PREBUILT_AFTER_MIGRATE`). With `--skip-migrations` they pass nothing, and the gate refuses a local production build it cannot check, so drop the flag: the migrations are idempotent. Until the migrate workflow is configured, `drk-deploy migrate` from the PR's branch, then the merge, is the usual order (§1.1); after that, the merge alone.

### 1.4 Two environment stores

They are separate and serve different phases:

| Store                                                                    | Holds                                                                                                                  | Read by                                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Vercel env** (Project → Settings → Environment Variables → Production) | runtime + build vars (`DATABASE_URL`, auth secrets, feature flags, `NEXT_PUBLIC_*`, …)                                 | `vercel build` and the deployed functions at runtime — **this is the live path**                 |
| **GitHub Actions** (the `production-migrations` GitHub environment)      | one secret, `PRODUCTION_DIRECT_DATABASE_URL`: production's direct owner URL (optional repository variable `DB_SCHEMA`) | the two migrate steps of `migrate-production.yml` only — **unset** until the operator step in §3 |

---

## 2. One-time database bootstrap

No deploy path seeds. The migrate workflow (§1.2) and `drk-deploy` (§1.3) apply both migrators on every deploy, and Vercel's build applies neither (§1.1), but none of them creates the baseline org, roles and first admin — you run the bootstrap **once** against a fresh database. Skipping it is the most common first-deploy mistake.

Run it from your own machine (laptop or a one-off runner) with the repo checked out, **Node 24 / pnpm 10+**, and the Neon **direct (unpooled)** connection string — it connects over the network; it is not SQL you paste into Neon's console. Both migrators refuse a pooled URL before connecting (§5).

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

1. **`db:auth:migrate`** — Better Auth tables (`user`/`session`/`account`/`verification`/`rateLimit`). The migrate workflow (§1.2) and `drk-deploy` run it on every deploy; until the workflow is configured, re-run it by hand, **before merging**, whenever `src/db/migrations/better-auth-schema.sql` changes in a release you are deploying (§1.1). The `rateLimit` table (Better Auth's shared sign-in limiter store, review #199) was added this way. Better Auth does not tolerate a missing table or column: an instance that starts without it refuses **every** auth request, and keeps refusing until it restarts, even once the migration has run. `/api/health/ready` reports it as `schema_behind` (§4).
2. **`db:app:migrate`** — extensions (`pgcrypto`, `pg_trgm`, created in `public`) + the **core** app schema (two files, `0001-initial-schema.sql` and `0002-release.sql`, §5), then the **localized data** under `src/db/migrations/locales/`. The migrate workflow and `drk-deploy` re-run this on every deploy; until the workflow is configured you run it by hand (§1.1).
3. **`db:seed`** — the default org (the org flagged `is_default` is reused whatever its slug; the initial `default` org is created only when none is flagged, so a re-run never adds a second default, F-40), the `admin.*` permission catalog, baseline roles, and your first admin (from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`). The roles and the admin go into the platform org, the one holding the seeded `superuser` role (the original default), not into whichever org is flagged default now, so a re-run after a superadmin moved the default to a tenant writes nothing into that tenant. The demo satellite apps it registers for the local dev rig are **skipped** under `NODE_ENV=production` (opt in with `SEED_DEMO_APPS=1`); register real enterprise apps via the admin console instead.

Every step is **idempotent and ledgered** — applied migrations are recorded in `app_schema_migrations`, so re-running `db:provision` (or letting a deploy path re-run the migrators) only applies new work. All tables land in the schema named by `DB_SCHEMA` (default `auth`); extensions stay in `public` so every schema resolves them.

Notes:

- **English-only install:** the email templates live under `src/db/migrations/locales/`, one file per locale, applied by default. Set `DB_MIGRATE_LOCALES=0` (or `false`/`no`/`off`) to skip the **localized** files — the non-English email-template rows are then absent and those recipients fall back to English. The core schema and the English base (`locales/0000-email-templates-en.sql`, always applied) install regardless, so an English-only database still has every template.
- `db:seed` is safe to re-run: every insert is `on conflict do nothing`, and its one update — relaxing the platform sign-up default from the migration's fail-closed `admin_approval` to `auto_active` — is **first-run only**. It is gated on the row never having been edited by an administrator (`updated_by IS NULL`; the admin API stamps it on every edit), so a re-run after you tightened the policy under **Administrator → Platform sign-up defaults** leaves it exactly as configured and prints `[seed] platform sign-up policy left as configured (admin-managed)`. See [Sign-up policy §5](./auth-signup-policy.md#5-activation-re-evaluation-at-sign-in). In production, change the seeded admin password immediately or supply non-default `SEED_ADMIN_*` values.
- **The seed admin is provenance-gated** ([`src/db/seeds/default-admin.ts`](../src/db/seeds/default-admin.ts)). The seed fully escalates (verifies, activates, grants `admin` + `admin.platform` + `superuser`) **only an account it creates itself** in that run. On a re-run it recognises its own admin — the account is already email-verified **and** already holds `superuser` — and re-inserts any missing grants without touching anything else: a seed admin you have since **blocked, suspended or deactivated stays that way** (the run prints `[seed] admin … left as configured (status=blocked)`). Any **other** pre-existing account matching `SEED_ADMIN_EMAIL` — e.g. someone who self-registered that address before you bootstrapped, or an admin whose verification was revoked — makes the seed **refuse** (`[seed] REFUSED to escalate pre-existing account …`, exit code 1, nothing written). If that account really is yours, re-run with `SEED_ADMIN_ADOPT_EXISTING=1` to confer the admin grants on it; even then its password, `emailVerified` flag and status are left as found, and a later plain re-run keeps refusing until the account is verified. Otherwise point `SEED_ADMIN_EMAIL` at an unregistered address.
- **Never** run `db:seed:dev` against production — it creates 24 accounts (21 org-scoped + 3 cross-org members) sharing one weak password, three of them cross-tenant superusers. Two independent guards make this hard to do by accident ([`src/db/guards.ts`](../src/db/guards.ts)): the seed refuses under `NODE_ENV=production` (override `DEV_SEED_ALLOW_PROD=1`), and — whatever `NODE_ENV` says, since it is routinely unset in a shell whose `.env` holds a production URL — it refuses any `DATABASE_URL` whose host is not local (`localhost` / `127.0.0.1` / `::1` / `0.0.0.0` / none; an unparseable URL counts as remote). Both checks run before a connection is opened, so a refusal writes nothing. The host guard is lifted only by `--force` or `DEV_SEED_ALLOW_REMOTE=1`; `db:reset` shares the same host check.

---

## 3. Vercel project + environment

Step 1 is the live path. Step 2 automates its migrations: optional, and until it is done the hand gate in §1.1 applies.

1. From the repo root: `vercel link` (or import the repo in the dashboard). Framework preset: **Next.js**. Importing the repo is also what enables the Git integration that deploys production (§1.1).
2. **Automate the migrations (DEP2).** Once, by a repository administrator, with the [GitHub CLI](https://cli.github.com/). Every push to `main` before this step runs `migrate-production.yml` and skips green; the first run also creates the `production-migrations` environment, with no rules, if the first command below has not.

   ```bash
   # The environment, and its rule that only `main` may use it. Set it BEFORE
   # the secret: an environment secret is readable by any job, in any workflow
   # on any branch, that names the environment (SECURITY.md, I-09).
   gh api -X PUT repos/devresponse/devresponsekit/environments/production-migrations --input - <<'JSON'
   { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
   JSON
   gh api -X POST repos/devresponse/devresponsekit/environments/production-migrations/deployment-branch-policies \
     -f name=main -f type=branch

   # The one secret. With no --body, gh reads the value from standard input
   # (paste it at the prompt), so it never appears in an argument or in your
   # shell history: Neon's DIRECT connection string for the role that owns
   # the schema, host without `-pooler`, ending in ?sslmode=require.
   gh secret set PRODUCTION_DIRECT_DATABASE_URL --env production-migrations

   # Only when production's DB_SCHEMA is not `auth`:
   gh variable set DB_SCHEMA --body <schema>

   # Run it once, from main, and wait for it.
   gh workflow run migrate-production.yml --ref main
   gh run watch "$(gh run list --workflow migrate-production.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

   The run is green, its summary says `Migrations applied for commit <sha>`, and `GET https://<domain>/api/health/ready` answers **200**. From then on every merge migrates itself, and the hand gate is needed only when a run fails (§1.2). Add **no** required reviewers to the environment: the migrations must land within the schema gate's ten-minute window, and an approval given later fails that build. Nothing about Vercel changes; its Git integration stays on, and this secret is never copied into Vercel's environment.

**Set runtime env in Vercel (Production).** [Configuration](./configuration.md) is the **authoritative** list of every variable (≈60); set it there. Validation is at **runtime, not build time** — a missing required var will not fail `next build`. It fails the deployment when it starts: the Node boot hook (`register()` in `src/instrumentation.ts`) parses the whole schema first (F-26), so every server-rendered page and API route of that deployment answers 500, `/api/health` and `/api/health/ready` included, and the function log names each invalid variable and its rule. Set everything before sending real traffic. The deployment-critical must-set production secrets:

- `BETTER_AUTH_SECRET` — strong random string (≥ 32 chars).
- `BETTER_AUTH_URL` — `https://<your-domain>` (also set `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_PRODUCTION_HOST` to the same origin/host).
- `DATABASE_URL` — see the endpoint decision below.
- The three `SSO_HANDOFF_*` vars — `SSO_HANDOFF_ISSUER` (the primary's origin URL), `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID`. Required **even if you never use cross-app SSO** — they are validated at boot. The prefix and application id can be placeholders, but `SSO_HANDOFF_ISSUER` must be an exact `https://` origin (use `BETTER_AUTH_URL`'s value when SSO is unused). If this deployment **issues** handoffs (it is the primary of a satellite fleet) also set `SSO_HANDOFF_PRIVATE_KEY` — an Ed25519 private JWK, generated per [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff), **distinct** from `API_JWT_PRIVATE_KEY`. Satellites never get it; they verify against `https://<primary>/api/sso/jwks.json`.

`NODE_ENV=production` is set by Vercel automatically. The `NEXT_PUBLIC_*` values are inlined at build time, so changing a domain requires a **redeploy**.

> **Operator gate before `MCP_ENABLED` goes on (review #57).** While the gateway is enabled the env schema refuses an `API_JWT_ISSUER` that is not the same identifier as `BETTER_AUTH_URL` (and, since F-22, one with a trailing slash in any case, because the value is stamped into tokens as `iss`) — the OAuth discovery documents are served from `BETTER_AUTH_URL` and RFC 8414 requires the advertised issuer to be that location. The env schema is parsed when the deployment starts (F-26), so a deployment that already has both set to _different_ values answers 500 on every server-rendered page and API route after the deploy rather than merely serving undiscoverable metadata. **CI cannot catch this**: `next build` parses placeholder env (`buildPhasePlaceholders` in `src/lib/env.ts`), so every check stays green and the failure appears only on the deployed instance. It is therefore a manual pre-deploy check — in Vercel → Settings → Environment Variables, for **Production _and_ Preview**, confirm `API_JWT_ISSUER` is unset or equal to `BETTER_AUTH_URL` wherever `MCP_ENABLED` is set, and fix the env _before_ the deploy. (The gateway is dark by default, so a deployment that never set `MCP_ENABLED` is unaffected.)

> **Operator gate for the origin and key rules (F-22).** The env schema refuses, when the deployment starts (F-26), any origin-valued variable that is not an http(s) origin, an `http://` one in production off loopback, a trailing slash on `SSO_HANDOFF_ISSUER` / `API_JWT_ISSUER`, a `COOKIE_DOMAIN` that does not cover `BETTER_AUTH_URL` or is written with a trailing dot, and an Ed25519 key of the wrong shape; the same boot hook refuses a key whose `x` is not `d`'s public half ([Configuration §1](./configuration.md#1-how-configuration-is-loaded)), and an `SSO_HANDOFF_PRIVATE_KEY` on a deployment that `SSO_HANDOFF_ISSUER` does not name (its origin is not `BETTER_AUTH_URL`'s, F-80) — so a Preview whose `BETTER_AUTH_URL` is its own preview URL must not carry the key. The same blind spot applies as for the MCP gate: `next build` parses placeholders, so CI stays green and only the deployed instance fails. Vercel runs **Preview** with `NODE_ENV=production` too. Before deploying a build that carries these rules, check each of these for **Production _and_ Preview**, reading **sensitive** values back from where they are observable when the dashboard cannot show them: `BETTER_AUTH_URL`, `SSO_HANDOFF_ISSUER` (a minted handoff's `iss`), `ADMIN_TRUSTED_ORIGINS`, `COOKIE_DOMAIN` (the `Domain=` of the sign-in `Set-Cookie`), `API_JWT_ISSUER`, `MCP_DISPATCH_BASE_URL`, `MAILGUN_BASE_URL`, and the four `*_PRIVATE_KEY` values. **`drk-deploy env:check` covers only part of this gate** (F-46). Of the values listed above it checks only `BETTER_AUTH_URL` and `SSO_HANDOFF_ISSUER` (and, on an Option C satellite, `COOKIE_DOMAIN`). For Production it reads each one back, applies the same rule the boot does, and compares it with the value the recorded config derives. It also reports any public value stored `sensitive` as a problem, because nothing can read it back. `drk-deploy env:sync` applies the same checks to every variable it leaves in place, so `up` stops on them too. Neither reads a secret, so the `*_PRIVATE_KEY` values are checked only when written (`env:sync` applies the key import to `SSO_HANDOFF_PRIVATE_KEY`). Everything else in this gate stays a manual check: `ADMIN_TRUSTED_ORIGINS` (outside the kit's contract; a satellite's is read back, but no origin rule is applied), the kit's own `COOKIE_DOMAIN` (outside its contract), `API_JWT_ISSUER`, `MCP_DISPATCH_BASE_URL` and `MAILGUN_BASE_URL`. And `env:check` covers Production only: `drk-deploy env:sync --target preview --dry-run` checks Preview.

**`DATABASE_URL`: direct vs. pooled.** Neon gives two connection strings for the same database. By default point `DATABASE_URL` at the **direct/unpooled** endpoint (no `-pooler` in the host). To use the **pooled** endpoint (better serverless concurrency), make the app pooler-compatible first — see §5. Keep `?sslmode=require` on both. **Migrations always use the direct endpoint.**

---

## 4. Deploy + post-deploy verification

Merge to `main`: `migrate-production.yml` applies the migrations while Vercel builds, and Vercel promotes the build once its schema gate sees them (§1.1, §1.2). Until the workflow is configured, apply any new migration to production first (§1.1), or run `drk-deploy deploy` (§1.3). Once the deployment is live, verify:

- [ ] The **Migrate production database** run for the merge commit (Actions tab, or `gh run list --workflow migrate-production.yml --limit 1`) is green, and its summary says `Migrations applied for commit <sha>`. A green run whose summary says `Skipped: migrations are not automated` means the workflow has no secret yet (§3), and the migrations were yours to apply.
- [ ] The production build's log (Vercel → Deployments → the deployment → Build Logs) ends with `[deploy-gate] PASS schema current after <s>s runtime=…`. Above it, `[deploy-gate] verify env=production infra=vercel commit=<12 chars>` names the merged commit, and `[deploy-gate] target host=… port=… database=… schema=… user=… runtime=…` names production's database, its `DB_SCHEMA` and the login the app uses. `runtime=owner` means the app still connects as the table owner (§8); `runtime=non-owner` means it connects as a least-privilege login whose privileges the gate checked. A build whose log ends in `[deploy-gate] FAIL …` was not promoted: see §1.1. A `vercel build` run by `drk-deploy` prints `[deploy-gate] skip prebuilt-after-migrate` instead, because it migrated first.
- [ ] `GET https://<domain>/` → the landing page returns **200**.
- [ ] `GET https://<domain>/api/health/ready` → **200 `{"status":"ready"}`**. This proves the environment passes its schema, the database is reachable, the ledger holds every core migration the live build depends on (`REQUIRED_CORE_MIGRATIONS` in `src/db/migrations/migration-plan.ts`) **and** Better Auth's own schema check finds every table and column its configuration writes (F-26). A **503 `{"status":"unavailable","reason":"schema_behind"}`** means the build went live ahead of one of its migrations: the server log says which half. `kind: "schema-behind"` lists missing core ids — run `pnpm db:app:migrate` against production now. `kind: "auth-schema-behind"` lists missing Better Auth tables or columns — run `pnpm db:auth:migrate`, then **redeploy**, because an instance that already saw the gap keeps refusing auth until it restarts. A **503 `config_invalid`** names the invalid variables in the log (`kind: "config-invalid"`). None of these details is ever in the response.
- [ ] Sign in with the seed admin from §2; the session persists.
- [ ] `GET https://<domain>/api/internal/outbox-drain` and `/api/internal/mcp-registration-reap` **without** the bearer header → **401** (confirms both cron endpoints are fail-closed).
- [ ] One real drain and retention tick answers **200** `{"ok":true,…,"retention":{…}}`. It is the same work the daily cron does, so it confirms that `CRON_SECRET` is set and that retention runs on this deployment. If you hold the secret (you set it yourself, or gave it to `drk-deploy env:sync` with `--from-env`), call `GET https://<domain>/api/internal/outbox-drain` with `Authorization: Bearer <CRON_SECRET>`. If `env:sync` generated it, nobody can read it back, because it is stored `sensitive` ([F-138](../vercel-cli/README.md#f-138-secrets-are-stored-sensitive-and-kept-off-development)). Have Vercel send it instead: run the job from the production deployment's summary, or with `vercel crons run /api/internal/outbox-drain`. Then open **View Logs** for it under Settings → Cron Jobs and confirm the invocation answered 200 and logged a `kind: "retention"` line, not `retention prune tick failed`. Otherwise read the log of the next daily tick the same way.
- [ ] In Neon's SQL editor, `select id from auth.app_schema_migrations order by id` lists the applied ids — the core files `0001-initial-schema.sql` and `0002-release.sql` (a database migrated before the 2026-09-30 consolidation also keeps its rows `0002-…` through `0008-…`, [§5](#upgrading-a-database-from-before-the-consolidation)), the always-applied `locales/0000-email-templates-en.sql`, and (unless `DB_MIGRATE_LOCALES=0`) the localized `locales/0001-…` files.
- [ ] If Sentry is configured, trigger a test error and confirm it lands ([Observability](./observability.md)).
- [ ] If `METRICS_TOKEN` is set, `GET /api/metrics` with `Authorization: Bearer <token>` returns Prometheus text.

> **The cron jobs.** [`vercel.json`](../vercel.json) declares two scheduled jobs: `GET /api/internal/outbox-drain` **daily at 08:00 UTC** retries `pending` rows in `app_outbox` (the serverless substitute for a long-running drain worker), and `GET /api/internal/mcp-registration-reap` **daily at 08:30 UTC** expires MCP self-registrations still pending after `MCP_REGISTRATION_PENDING_TTL_DAYS` (the substitute for `pnpm mcp:reap`). Vercel Cron calls both with `Authorization: Bearer <CRON_SECRET>`, so **set `CRON_SECRET` in Vercel env** or the routes return 401: no mail is retried, no retention runs and no junk registrations expire. Daily works on all Vercel plans (Hobby included, which runs each cron at most once a day, at any time within its scheduled hour); higher frequencies need Pro. Note what "daily" means for **token-bearing** mail. `sendAppEmail` retries a transient provider failure (a 5xx, a 429 after its `Retry-After`, a refused connection) inline, up to three attempts within about 20 seconds, so a brief outage or rate limit no longer loses the mail (F-99). A row that still fails after that stays `pending` for the drain, and a password-reset / verification token lives one hour, so that row is already expired when the next tick runs. The drain fails such a row as `token_expired` instead of delivering a dead link (review #90) — the user simply requests a new one. If you need those retries to actually land, run the drain more often (Pro cron, an external scheduler, or `pnpm outbox:drain`). A drain that runs while an inline send is still in flight does not send that email again: the row is leased to the send for two minutes (F-101).
>
> **Data retention rides the drain cron.** After each drain, the `outbox-drain` tick runs the retention prune that `pnpm db:prune` runs elsewhere (F-96). It deletes expired token revocations, SSO handoff nonces expired over an hour ago (F-84), audit rows older than `AUDIT_RETENTION_DAYS` and terminal outbox rows older than `OUTBOX_RETENTION_DAYS`, and it fails `pending` outbox rows orphaned longer than `OUTBOX_MAX_PENDING_DAYS` (default 7). The windows apply from the first tick after a deploy, so set them (`0` disables one) before deploying if the defaults do not fit. It shares the drain's cron entry and time budget rather than adding a third job. It deletes in bounded batches and starts no new batch later than 45 s into the tick, inside the route's 60 s `maxDuration`. So the first run over a long backlog stops cleanly: it logs `[retention] <table>: stopped at the time budget after N rows`, and the next daily tick carries on. Every tick logs a `kind: "retention"` line with the counts. A failed prune logs `retention prune tick failed` and makes the route answer 500, so the cron log shows the tick as failed. On a host without Vercel Cron, schedule `pnpm db:prune`, or have the scheduler call this route.

---

## 5. Operations & gotchas

**Rate limiting and instance count.** Two limiters run in the application tier, with different topologies. The **pre-auth floors** — `/api/v1/auth/token` (per-IP, then global), `/api/mcp/register` (per-IP, then global), the CSP report sink (per-IP, then global), `/api/sso/consume` and a signed-out `/api/sso/launch` (per-IP only, no global floor; F-19), `/api/mcp` (per-IP only, no global floor; F-78), `/api/invitations/accept` (per user) and the per-account email/password sign-in budget (per address, F-55) — and **Better Auth's built-in sign-in / password-reset limiter** keep their buckets in **Postgres** (`app_rate_limits`, migration `0006`, and Better Auth's `rateLimit` table), so they enforce **one budget across every instance or serverless invocation**; if the database is unreachable the app floors fall back to a per-instance bucket and log a warning (counted in `devresponsekit_rate_limit_shared_fallbacks_total`). The admin actions that send mail (the test email, invitation create and resend, an admin's reset email) take their budgets from Postgres too, including a per-org daily budget (F-64, [Admin Manager §2.5](./admin-manager.md#25-rate-limiting-of-admin-mutations)), because every mail spends a provider quota all tenants share. The **per-actor** abuse guard on the other admin mutations, bulk operations, CSV export, a signed-in SSO launch and the docs/help image route, like the per-actor and per-credential buckets on the v1, account and preference self-service routes and MCP tool calls (`src/lib/http/rate-limit.server.ts`), is **in-process** — its budget lives in one Node process's memory, **resets on restart**, and with more than one instance is enforced per instance (it effectively multiplies by the instance count). That guard layers on top of the real authorization checks and its fan-out is bounded by the credentials an actor holds, so multi-instance is a supported topology; only the per-actor UX limit is best-effort there. (This applies only to the **application** tier — Postgres is external and unaffected.)

**Direct endpoint by default; pooled needs two changes.** The app sends three per-connection **startup parameters**: `search_path` (`-c search_path=…`) plus the `statement_timeout` / `idle_in_transaction_session_timeout` ceilings from `src/db/database.ts` (`pg` puts those in the startup packet too). A **transaction pooler rejects** startup parameters — every connection fails with `08P01 unsupported startup parameter in options: search_path` — along with the DDL + advisory locks the migrator needs. So both migrations and runtime use the **direct/unpooled** endpoint by default. To run the **runtime** on the **pooled** endpoint:

1. Set all three as role defaults the pooler honors, once against the database (`<app_role>` is the user in your connection string, e.g. Neon's `neondb_owner`). The `30s` values match what the code sends by default (`PG_STATEMENT_TIMEOUT_MS` / `PG_IDLE_IN_TX_TIMEOUT_MS` = 30000); mirror any override you set. A least-privilege login made by `pnpm db:runtime-login` already carries all three (§8.3):

   ```sql
   ALTER ROLE <app_role> SET search_path = "auth", public;
   ALTER ROLE <app_role> SET statement_timeout = '30s';
   ALTER ROLE <app_role> SET idle_in_transaction_session_timeout = '30s';
   ```

2. Set `DB_SEARCH_PATH_VIA_OPTIONS=0` in Vercel so the app stops sending **all three** rejected parameters (review #20 — the flag used to strip only `search_path`, and the pooler rejected the timeouts just the same). Verify with `show statement_timeout;` on a pooled connection: it must read `30s`, not `0`.

Migrations still use the direct endpoint, and both migrators refuse a pooled one (see **What the migrators refuse** below). By default they connect as that same role, but its `statement_timeout` does not govern them: both migrators set their own ceilings, and both clear them on the session that waits for their advisory lock (F-94, see **Schema changes** below). Keep `PGPOOL_MAX` small on serverless (each function instance opens its own pool).

**Shutdown on Vercel is a no-op; on a long-running server it is a two-step drain.** Vercel never delivers `SIGTERM` to a warm function in the normal freeze/teardown path, and the app's shutdown watchdog (`src/lib/shutdown.server.ts`) registers nothing when the platform's `VERCEL` variable is set — pool connections are simply dropped when the function instance is recycled. On `next start` / the container (`docs/docker.md` §7), Next's own cleanup drains HTTP and exits `143`/`130`; the watchdog only ends the pool and exits with the same code if that drain overruns `SHUTDOWN_TIMEOUT_MS` (review #24).

**Schema changes** ship as new numbered files in `src/db/migrations/` — never edit an applied migration:

- **Core** — two frozen files today. `0001-initial-schema.sql` is the baseline. `0002-release.sql` holds everything the 1.x/2.x line added after it: the seven files `0002-…` through `0008-…`, consolidated on 2026-09-30, verbatim, each between a `-- ===== BEGIN folded <file> =====` and a `-- ===== END folded <file> =====` line. So a new database applies two core files and then the locale files. Code, docs and tests still say "migration 0005" for a folded file; that names its section of `0002-release.sql`. The last commit with the seven individual files is `79b4803`. A new schema change is a new **numbered file**, `0003-*.sql` next, applied in lexical order and recorded once in the ledger.
- **Email templates** — one file per locale — go in `src/db/migrations/locales/`. The English base `locales/0000-email-templates-en.sql` is ALWAYS applied (the fallback every locale resolves to); the localized files (`locales/0001-…`+) apply unless `DB_MIGRATE_LOCALES=0`. Ledger ids are path-prefixed (`locales/<file>`) so they can never collide with a core filename.

`migrate-production.yml` applies them on the merge's push (§1.2); until it is configured **you** apply them, against production, **before** the PR merges (§1.1); `drk-deploy` applies them migrate-first (§1.3).

**Migrations run against live traffic, so write them to hold locks briefly (F-94).** Every path applies a migration while the previous build is serving. The runner applies each file as **one transaction** (ledgered in the same one), so every lock a statement takes is held until the whole file commits.

- **Lock and statement ceilings.** `db:app:migrate` starts each file's transaction with `set local lock_timeout` (`DB_MIGRATE_LOCK_TIMEOUT_MS`, default 5000) and `set local statement_timeout` (`DB_MIGRATE_STATEMENT_TIMEOUT_MS`, default 600000, 10 minutes); `db:auth:migrate` sets the same two on each of its connections. Both are milliseconds and `0` disables one. A statement that waits longer than the lock timeout fails and the file rolls back with nothing ledgered, instead of queueing every query on that table behind its lock request; re-run once the blocker is gone ([Troubleshooting](./troubleshooting.md#deployment-issues)). The advisory lock that serialises two runners is under neither ceiling: each runner clears both settings for its own session before taking it, so a role default such as the `30s` above cannot cancel the wait, and a second runner waits for the first however long it takes, unless `DB_MIGRATE_LOCK_WAIT_MS` bounds the wait (below).
- **Keep ACCESS EXCLUSIVE work short and on its own.** `ALTER TABLE … ADD COLUMN` / `SET NOT NULL` / `ADD CONSTRAINT` and `DROP TRIGGER` block reads and writes of the table until the file commits. Keep them out of a file that also backfills rows or builds an index on a large table.
- **Add a constraint across two files.** `ADD CONSTRAINT … NOT VALID` in one numbered file, `VALIDATE CONSTRAINT` in the next. Each file commits on its own, so ACCESS EXCLUSIVE lasts only for the catalog change and the row scan runs under VALIDATE's SHARE UPDATE EXCLUSIVE, which lets reads and writes through. A foreign key works the same way. In one file the pair is no better than a plain `ADD CONSTRAINT`: that is what migration 0005 (its section of `0002-release.sql`) does, and it is not a pattern to copy.
- **Build a large table's index by hand first.** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, and the runner has no non-transactional mode. When a blocking build on a table matters, run `create index concurrently if not exists <name> on …` against the database before applying the file, under the name the file uses. Run it with `set statement_timeout = 0` in that session, since a role default such as the `30s` above would cancel it. A build that fails or is cancelled leaves an **INVALID** index behind: the planner ignores it and every write still maintains it, yet `if not exists`, yours and the file's, skips it as if it were done. So before applying the file, confirm `select indisvalid from pg_index where indexrelid = '<name>'::regclass` returns `true`; if it does not, `drop index concurrently <name>` and build it again. The file's `create index if not exists` then skips the valid index, though it still takes a write-blocking SHARE lock until the file commits, so keep that file short. On a small table a plain `create index if not exists` in the file is fine.

**What the migrators refuse (DEP2).** Every path that migrates runs `db:auth:migrate` and `db:app:migrate`: the migrate workflow, `drk-deploy`, the hand gate, `db:provision` and the Docker init step. Both refuse, with exit code 1 and the reason, never the URL:

- **A pooled or re-pointed `DATABASE_URL`, before connecting.** Pooled is a Neon `-pooler` host, a `.pooler.` host, port 6543 or `pgbouncer=true`: DDL and the session advisory lock do not survive a transaction pooler, so there is no override. Re-pointed is a `host`, `hostaddr`, `port`, `dbname`, `database` or `user` query parameter, which `pg` or libpq would follow to a database other than the one the URL's host names. The rules are `drk-deploy`'s (F-47), in `src/db/connection-shape.ts`.
- **A session whose `search_path` does not resolve to `DB_SCHEMA`.** After creating the schema and before anything else, each runner asks `current_schema()`. Every migration statement is unqualified, so with `DB_SEARCH_PATH_VIA_OPTIONS=0`, or a role default that names another schema, the ledger and `0001` used to land in `public`, silently. Leave that flag unset for migrations; it is for a pooled runtime.
- **A role that does not own the ledger.** When `DB_SCHEMA` already has `app_schema_migrations`, its owner must be the migrating role. Migration 0005's default privileges are per creating role, so tables another role creates get no runtime grants, and they break the audit trigger's owner rule. This refusal names both roles, and it is what stops a role that may create schemas in the database, a superuser or another admin role. The runtime login of §8 is stopped one step earlier: it has no `CREATE` on the database, which Postgres checks for `create schema if not exists` even when the schema exists, so the runner's schema step fails with `permission denied for database <name>`, before anything is created. A fresh database has no ledger, so nothing to compare.
- **Waiting too long for the migration lock.** Both runners take `pg_advisory_lock(hashtext('app_schema_migrations'))` for their whole run (the Better Auth runner since DEP2), one after the other. `DB_MIGRATE_LOCK_WAIT_MS` bounds the wait: unset or empty waits as long as it takes; a whole number of milliseconds from 1 to 3600000 retries every second until then and fails with `another session holds the migration lock`; any other value stops the runner before it connects. The workflow sets 300000, five minutes, inside the gate's ten.

[Troubleshooting](./troubleshooting.md#migrate-production-database-run-failed) has what to do about each.

**Rollback.** Roll the app back by **promoting a previous deployment** in Vercel (dashboard → previous deployment → "Promote to Production", or `vercel promote <deployment>`). Prefer promoting to `vercel rollback`: after an Instant Rollback Vercel stops assigning production domains to new deployments until one is promoted, so on the live path (§1.1) the next merge is built and never goes live. Migrations are **forward-only** — additive, with **no down-migrations** — so the older build runs safely against the newer schema ([Compatibility: expand, then contract](#compatibility-expand-then-contract), below). Migrations always land _before_ the build that needs them goes live — the schema gate holds a build back until they have (§1.1) — so a rollback needs no DB change. A migration that genuinely must be reverted is authored as a **new forward migration**. To recover lost _data_ (not a bad deploy), use your provider's PITR/snapshot, not a schema revert.

See [Troubleshooting](./troubleshooting.md) for operational issues.

### Compatibility: expand, then contract

Old code runs on the new schema, on every path. Migrations land before the build that needs them, so the build that is live while they run serves against them. A build that fails at the schema gate (§1.1) leaves the previous one serving. An Instant Rollback, or promoting an older production deployment, puts an older build on the newer schema with no gate in between. And the satellites on the shared database keep running whatever version each has deployed (devresponseapps `DEPLOY.md`). Every argument for the gate's safety rests on this rule, so a migration must leave each of these working:

- (a) the build that is live while it runs;
- (b) any production deployment an Instant Rollback could restore;
- (c) every satellite on the shared database, at its deployed version.

The rules:

- **Same release as the code: add only.** Tables, nullable or defaulted columns, non-unique indexes, functions and grants.
- **Remove or rename only in a LATER release**, once the code that used the object, and every satellite, has shipped without it. A rename is: add the new object, dual-write or fill it by trigger, switch the readers, then drop the old one later.
- **NOT NULL.** Add the column with a default, or fill it by trigger before `SET NOT NULL`, as migration 0005 does for `app_group_roles.organization_id` (its section of `0002-release.sql`). Otherwise run `SET NOT NULL` in a later release.
- **A new CHECK, UNIQUE or foreign key.** Add a CHECK or a foreign key `NOT VALID` first and `VALIDATE` it later (see **Add a constraint across two files** above). A UNIQUE constraint or index has no `NOT VALID`, so it needs the marker below and a reason no older writer can trip it.
- **Better Auth upgrades** that add a required column with no default need a kit migration one release earlier that adds the column with a default. `tests/unit/better-auth-required-columns.test.ts` pins Better Auth's required columns, so such an upgrade fails it, with this instruction.
- **A step that needs an operator** raises an `EXCEPTION`, not a `NOTICE`. An unattended run (the migrate workflow, `drk-deploy`) leaves NOTICE lines nobody reads.
- **Rollback** means promoting the previous deployment. Never down-migrate.

**The guard.** `tests/unit/migration-compat-guard.test.ts` reads every core migration from `0003` on (`compatGuardTargets` in `src/db/migration-compat.ts`; the frozen `0001-initial-schema.sql` and `0002-release.sql`, `better-auth-schema.sql` and `locales/` are not checked) statement by statement, and fails on any of these:

| Class           | Statements                                                                                                                                   | Waived by                        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Forbidden       | `CONCURRENTLY`, `VACUUM`, transaction control, `ALTER TYPE … ADD VALUE`, `ALTER SYSTEM`, `CREATE`/`DROP DATABASE`: none can run in the runner's per-file transaction | nothing                          |
| Idempotency     | `create table`, `add column`, `create [unique] index` or `create schema` without `if not exists`; `create function` without `or replace`      | nothing                          |
| Contract        | any `drop` but `drop not null` (an object, a column with or without `COLUMN`, a constraint, a default, an identity); `rename`; a column type change, `alter [column] … [set data] type`; `truncate`; `revoke` | a `contract` marker              |
| Tighten or data | `set not null`; an added `not null` column with no default; a constraint added without `not valid`; a unique index; `update`; `delete`         | an `expand` or `contract` marker |

Inside a `do` block every rule applies anywhere in the body, string literals included, so `execute format('drop table %I', …)` is caught. The marker is a `--` line directly above the statement. Its reason (20 characters or more) says why the live build, rolled-back builds and the satellites are unaffected, and a `contract` marker also names the release or pull request that removed the last reader:

```sql
-- compat: contract — nothing has read app_users.legacy_name since 2.1.0 (#512), and no satellite selects it
alter table app_users drop column if exists legacy_name;
```

### Upgrading a database from before the consolidation

On 2026-09-30 the seven core files that followed the baseline, `0002-admin-groups-permissions.sql` through `0008-user-data-export-erasure.sql`, became one file, `0002-release.sql`. Each is in it verbatim, and each section still hashes to the checksum its file was ledgered under (`tests/unit/migration-checksums.test.ts`). A new database applies `0001-initial-schema.sql`, `0002-release.sql` and the locale files, and needs nothing from this section. A database migrated before the consolidation has the seven old ids in its ledger instead of `0002-release.sql`, and the runner and the readiness probe recognise it by them (`CONSOLIDATED_CORE_MIGRATIONS` in `src/db/migrations/migration-plan.ts`). What happens depends on how many of the seven it holds:

- **All seven (a database at `0008`, as production and the satellites' shared database are).** Nothing to do. The new build is ready on that ledger as it stands, because readiness counts the seven ids as `0002-release.sql`, so the merge that ships it needs no migration first. The next `pnpm db:app:migrate` logs `[migrate] record 0002-release.sql (already applied as 0002…0008)`: it writes that one ledger row, under the file's checksum, and runs none of the file, so 0007's provider-token scrub and 0005's preflights do not run twice. The seven old rows stay: they are history, the runner ignores ids it has no file for, and a build from before the consolidation, after a rollback, still finds them. Before recording, the runner compares each of the seven stored checksums with its pin. A different checksum means that database applied another version of that file: the run stops with the id and both hashes, and records nothing. A row with no checksum (ledgered before review #86) is accepted with a warning.
- **Some of them (a database at `0002` … `0007`, such as one still on 2.0.0 without `0008`).** The runner refuses before it writes anything, naming the missing ids: it cannot apply part of `0002-release.sql`, and applying all of it would run the files already applied a second time. Readiness answers `503 schema_behind` for the new build, with `0002-release.sql` as the missing id in the log. Bring the database to `0008` from commit `79b4803`, the last with the individual files, first. In a clean checkout run `git switch --detach 79b4803`, `pnpm install --frozen-lockfile`, then `pnpm db:auth:migrate` and `pnpm db:app:migrate` against the direct `DATABASE_URL`, following that commit's runbooks for the files it applies (the notes below). Then switch back to this build and run `pnpm db:app:migrate` again, which records `0002-release.sql`.
- **None of them (a database at `0001` only).** The runner applies `0002-release.sql` like any pending file, in **one** transaction. 0005's and 0007's preflights check the existing data first, and a refusal rolls back the whole file, the sections before it included. Every lock a section takes is held until the whole file commits, so on a live database with large tables read "Hold locks briefly" above and the 0007 note below first.

Rolling back across the consolidation: a build from before it runs unchanged against a database migrated before it, whose old rows are still there. A database **created** by this build has no old rows. An older build reports `503 schema_behind` there, and its runner would apply the seven files again, so roll such a database forward only.

#### Migration 0007

Migration 0007 (2026-09 review, F-97, M-02, F-93, F-150) adds a unique index on the **global** role keys (`idx_app_roles_global_key`), a unique index on the default-organization flag (`idx_app_organizations_single_default`), trigram indexes for the audit and outbox search boxes (`idx_app_audit_events_event_type_trgm`, `idx_app_outbox_template_key_trgm`), and clears the OAuth provider tokens Better Auth stored on `auth.account`. It runs wherever its section of `0002-release.sql` runs, or, for a database brought up to date from `79b4803`, as its own file. Its full runbook, with the apply, the verification and the rollback, is in that commit: `git show 79b4803:docs/deployment.md`, "Migration 0007". On a database that already has data, two things matter first (`auth` below is `DB_SCHEMA`):

1. **Preflight (read-only).** Both queries must come back empty; the migration refuses to apply otherwise, lists the offenders and changes nothing:

   ```sql
   select key, count(*) from auth.app_roles
    where organization_id is null group by key having count(*) > 1;
   select id, slug, created_at from auth.app_organizations
    where is_default order by created_at, id offset 1;
   ```

   A duplicated global key: delete the unused duplicate (Administrator → Roles) or re-key it by SQL. A second default: sign-ups already go to the oldest one (listed first without the `offset`); open each other one → **Settings** and untick **Set as default organization**, which clears an extra flag.

2. **Large audit or outbox table (optional).** The file is applied in a transaction, so it cannot build an index `CONCURRENTLY`; each `CREATE INDEX` holds a `SHARE` lock on its table until the file commits, which blocks **writes** (sign-in audit rows, outbox mail), not reads. If `app_audit_events` or `app_outbox` is large, build those two first, outside a transaction, under the same names, with `set statement_timeout = 0` in that session (see **Build a large table's index by hand first** above, F-94), and check that both are valid (a failed concurrent build leaves an invalid index that the migration would then skip: drop it and build again):

   ```sql
   create index concurrently if not exists idx_app_audit_events_event_type_trgm
     on auth.app_audit_events using gin (event_type gin_trgm_ops);
   create index concurrently if not exists idx_app_outbox_template_key_trgm
     on auth.app_outbox using gin (template_key gin_trgm_ops);
   select indexrelid::regclass, indisvalid from pg_index
    where indexrelid in ('auth.idx_app_audit_events_event_type_trgm'::regclass,
                         'auth.idx_app_outbox_template_key_trgm'::regclass);
   ```

The log then includes `[migrate] notice [0007] cleared stored provider tokens on N account row(s).`

#### Migration 0008

Migration 0008 (2026-09 review, F-151) adds the `admin.users.export` permission, the erasure function `app_users_pseudonymise(uuid)` (`SECURITY DEFINER`, owned by the migrating role, executable by `<DB_SCHEMA>_runtime` and not by `PUBLIC`), and a narrow exemption in the audit table's append-only trigger that lets only that function replace an erased user's `email`, `metadata.email`, `ip_address` and `user_agent` ([Admin Manager, Data export and erasure](./admin-manager.md#data-export-and-erasure-f-151)). It takes no table lock and backfills nothing. Its full runbook for a database that applies it as its own file is in `79b4803` (`git show 79b4803:docs/deployment.md`, "Migration 0008"). One check applies to every database, a new one included, because the function runs with the migrating role's privileges: it writes Better Auth's tables, and the trigger admits its audit update only when that role owns `app_audit_events`. Both hold when `pnpm db:auth:migrate` and `pnpm db:app:migrate` run as the same role, which is the default. Run this as that role (`auth` is `DB_SCHEMA`); every row must say `true`:

```sql
select t, has_table_privilege(format('auth.%I', t), 'UPDATE')
          and has_table_privilege(format('auth.%I', t), 'DELETE') as ok
  from unnest(array['user', 'session', 'account', 'verification']) t;
select pg_get_userbyid(relowner) = current_user as owns_audit_table
  from pg_class where oid = 'auth.app_audit_events'::regclass;
```

A `[migrate] notice [0008] the migrating role … cannot UPDATE and DELETE Better Auth table(s)` line in the migrate log means the same gap: grant `update, delete` on those tables to the role (the notice prints the statement), or apply the migration as the audit table's owner, before anyone erases a user, or the erase route answers `500 erase_failed`. Until a role holds `admin.users.export`, only superadmins can export another user; each user can always export their own data from Account → Overview. Add the key to the roles that answer access requests (Administrator → Roles).

---

## 6. Self-host / container

A production-ready multi-stage `Dockerfile` (built from the Next.js standalone output, non-root) is provided. Build/configure/run, running migrations as a separate init step, required env, a `docker compose` example, and hardening are all in **[Docker](./docker.md)**.

---

## 7. CI

CI is **[`.github/workflows/`](../.github/workflows/)** (source of truth). [`ci.yml`](../.github/workflows/ci.yml) runs on push + pull_request and validates quality and behavior — typecheck, lint, format, build, the docs/help file-trace check (F-88), tests + coverage gate, DB-backed integration tests, Playwright e2e + accessibility (run as a least-privilege login, below), SDK/schema/doc-link drift checks, and the deploy CLI's own typecheck, build, tests and format check (`vercel-cli/`, F-45) — but does **not** itself deploy. Vercel's Git integration builds and promotes every push to `main` independently of CI's result (§1.1), and [`migrate-production.yml`](../.github/workflows/migrate-production.yml) migrates production on that push without waiting for CI, which the merge already passed (§1.2). Separate workflows run the `pnpm audit` hard gate over both lockfiles, the app's and `vercel-cli/`'s (`dependency-audit.yml`, which also reads the Dependabot alerts weekly), plus Trivy, CodeQL, gitleaks, and an advisory Stryker mutation-testing pass on the security core (`mutation.yml`). See [Testing](./testing.md).

The Playwright job (`E2E + accessibility (Playwright)`) is also the proof of §8 (DEP3). The superuser of its Postgres service only creates `app_owner`, a non-superuser with `CREATEROLE` that owns the database, the shape of Neon's `neondb_owner`. As that owner the job migrates (0005 creates `auth_runtime`, the reconcile applies the manifest), runs `pnpm db:runtime-login --login auth_app_ci`, and seeds. Then the schema gate, the server and the runtime jobs (`pnpm db:prune`, `pnpm mcp:reap`) run as `auth_app_ci` with `DB_SEARCH_PATH_VIA_OPTIONS=0`, production's pooled shape: the gate must PASS with `runtime=non-owner`, the server must answer readiness, and after the e2e and accessibility suites the server log must hold no `permission denied` or `must be owner of`. A code path that needs more than the manifest grants fails there. `tests/unit/ci-runtime-login.test.ts` pins the job's shape.

---

## 8. Least-privilege runtime role (optional, recommended)

By default the application connects as the same role that runs migrations and owns every table (Neon's `neondb_owner`, the local `devresponse`). That role can do anything to the schema — including deleting audit rows — so the audit log's append-only trigger is a guard against accidents, not a privilege boundary. Three kinds of role split that apart:

- **Owner / migration role** — whatever `DATABASE_URL` you run `pnpm db:app:migrate` / `db:provision` with. Owns the tables, the trigger, the `SECURITY DEFINER` retention function `app_audit_events_prune(days, batch)` and, from 0008, the `SECURITY DEFINER` erasure function `app_users_pseudonymise(app_user_id)`. Its connection string is the migrate workflow's secret (§1.2) and never goes into Vercel.
- **Runtime group role `<DB_SCHEMA>_runtime`** (`auth_runtime` by default) — created by migration 0005 (review #83; its section of `0002-release.sql`) as `NOLOGIN` with **no password**. It never logs in. It holds what the privilege manifest grants (§8.1), and nothing else.
- **Per-app LOGIN roles** — `<DB_SCHEMA>_app` (or `<DB_SCHEMA>_app_<suffix>`), made by `pnpm db:runtime-login` (§8.3). Each inherits the group (membership `INHERIT TRUE, SET FALSE`, so it holds the grants but cannot become the group) and carries three role defaults: `search_path = "<DB_SCHEMA>", public`, `statement_timeout = 30s` and `idle_in_transaction_session_timeout = 30s`. They are set on the login because role settings are not inherited through membership, and a pooled connection gets nothing else (§8.4). The application's runtime `DATABASE_URL` names one of these.

**Create logins with SQL, which is what `pnpm db:runtime-login` does, and NEVER in the Neon Console, API or CLI.** A role made there joins `neon_superuser`, which holds `pg_write_all_data` and bypasses every grant below; the gate refuses such a login (§8.5). Ignore the advice in 0005's notice (`alter role <DB_SCHEMA>_runtime login password …`), which predates this section: the group role stays `NOLOGIN`.

The append-only trigger permits a `DELETE` only when the **effective** role is the table owner _and_ the transaction-local `app.audit_retention` marker is on — both hold inside the retention function whoever calls it; the owner half never holds for the runtime role — so a stolen runtime credential cannot purge audit history even by setting the marker itself. The one UPDATE besides the org-deletion tombstone follows the same rule: the erasure function's pseudonymisation of an erased user's address (the `email` column and an existing `metadata.email`), IP address and user agent, admitted only for the owner with the `app.audit_pseudonymise` marker on (F-151). The retention function clamps the requested window to a **30-day floor** and each batch to 10 000 rows. Until you switch, the app connects as the owner and a session that sets the marker _can_ delete: the trigger guards against accidents, the role switch is the privilege boundary.

### 8.1 The privilege manifest

[`src/db/runtime-privileges.ts`](../src/db/runtime-privileges.ts) is the one source of truth for what `<DB_SCHEMA>_runtime` may do. Version 1:

| Object | Runtime privileges |
| --- | --- |
| `app_schema_migrations` | `SELECT` (readiness and the gate only read it; a write could forge readiness or skip a migration) |
| `app_audit_events` | `SELECT`, `INSERT` |
| `app_users` | `SELECT`, `INSERT`, `UPDATE` (erasure goes through `app_users_pseudonymise`, and no runtime path deletes a user) |
| every other `app_*` table, and Better Auth's `user`, `session`, `account`, `verification`, `rateLimit` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `app_audit_events_prune(integer, integer)`, `app_users_pseudonymise(uuid)` | `EXECUTE` |
| the `DB_SCHEMA` schema | `USAGE` |

Forbidden, for the group role and every login: `TRUNCATE`, `REFERENCES` and `TRIGGER` on any table; any privilege on a table the manifest does not list; `CREATE` on `DB_SCHEMA`, on `public` and on the database; the attributes `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` and `BYPASSRLS`; membership in the ledger's owner, `pg_write_all_data`, `pg_read_all_data`, `neon_superuser` (on Neon) or `pg_signal_backend`.

Only the ledger, the audit table and `app_users` are narrowed in version 1; narrower per-table grants follow once CI's non-owner job (§7) has run green for a while. **A new table needs an explicit entry**: `tests/unit/runtime-privileges.test.ts` fails on a `create table` the manifest does not list, and the gate treats any privilege on an unlisted table as forbidden.

### 8.2 The reconcile at the end of every `db:app:migrate`

Every `pnpm db:app:migrate` ends, after its last file and still holding the migration lock, by bringing `<DB_SCHEMA>_runtime` to the manifest (`reconcileRuntimePrivileges` in `src/db/migrations/runtime-privileges-db.ts`). It reaches the Better Auth tables that `db:auth:migrate` creates outside the ledger, so re-running `db:app:migrate` re-applies the grants, whoever changed them. It changes that role's grants and nothing else:

- table grants and revokes from the role's direct grants, `USAGE` on the schema (never `CREATE`), `EXECUTE` on both functions, and the migrating role's default privileges for tables a later migration creates, each issued only when missing, in one transaction with `lock_timeout = 5s`. A steady-state run issues nothing and logs `[migrate] runtime role auth_runtime: in sync`; otherwise `[migrate] runtime role auth_runtime: N grants, M revokes`;
- a role that does not exist is reported (`[migrate] warning: auth_runtime does not exist; runtime privileges not reconciled`) and never created: 0005 owns that, and prints the manual steps when the migrating role lacks `CREATEROLE`;
- a table the manifest does not list is reported and left as it is;
- a privilege outside the manifest that no grant to the role explains, because it comes from `PUBLIC` or a membership, fails the run before anything is applied, naming its source;
- a grant or revoke that Postgres only warned about (a migrating role that does not own the table) fails the run when the state is read back.

A failure fails the migrate job; the files it applied are already ledgered. While the app connects as the owner none of this changes what it can do. The first run after this lands revokes `INSERT`, `UPDATE` and `DELETE` on `app_schema_migrations` and `DELETE` on `app_users` from the role, and the next one logs `in sync`.

### 8.3 `pnpm db:runtime-login`: creating, rotating and adopting a login

Run it as the owner, against the **direct** endpoint (the same `DATABASE_URL` as `db:app:migrate`; no other URL variable is read). The login's password comes from `DB_RUNTIME_LOGIN_PASSWORD`, 32 to 128 characters of `A-Z a-z 0-9 _ -` so it embeds in a URL unescaped. Generate it into your secret store, give it to the command for that one run, and never set it in Vercel:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"   # into your secret store
DB_RUNTIME_LOGIN_PASSWORD=<it> DATABASE_URL=<owner direct URL> \
  pnpm db:runtime-login --allow-remote --verify-host <pooled host>
```

| Flag | Meaning |
| --- | --- |
| `--login <name>` | default `<DB_SCHEMA>_app`; otherwise `<DB_SCHEMA>_app_` and 1 to 24 lower-case letters or digits |
| `--connection-limit <n>` | default `-1`, no limit |
| `--allow-remote` | required for a host that is not local |
| `--verify-host <host>` | verify through this host, such as Neon's `-pooler` one |
| `--plaintext-password` | send the password itself, if the server refuses a pre-hashed verifier |

It refuses a pooled or re-pointed owner URL, then checks that the session owns `<DB_SCHEMA>.app_schema_migrations` (or is a superuser), that `<DB_SCHEMA>_runtime` exists ("run pnpm db:app:migrate first"), and that the session may grant it: a superuser, or `ADMIN OPTION` on it, which Postgres 16 and later require and which a non-superuser owner gets by creating the role, as `neondb_owner` does in 0005. Otherwise it prints `grant <runtime> to <owner> with admin option` as the remedy. It runs the reconcile (§8.2), then, in one transaction, creates the login (`nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit`) or, when it exists and has no forbidden attribute and no membership but the runtime role, rotates its password; grants the runtime role; and sets the three role defaults in the current database. The password reaches the server only as a SCRAM-SHA-256 verifier computed client-side (`src/db/scram.ts`), so no statement log holds it. Last, it connects **as the login**, with no startup parameters (a pooler's shape), to `--verify-host` or the owner's host, and checks that `search_path` resolves to `DB_SCHEMA`, both timeouts read `30s`, the ledger reads, and the login holds exactly the manifest. It prints `login=<name> host=<host> database=<db> verified`, and never the password or a URL. A verification failure after a creation says the login exists but is **not in use**; after a rotation it says the password was rotated, since a deployment that connects as the login needs the new one.

To adopt it, set the runtime `DATABASE_URL` (Vercel → Environment Variables, or the container's env) to the login on the pooled host, with `DB_SEARCH_PATH_VIA_OPTIONS=0` (§8.4), and redeploy. The build log then reads `[deploy-gate] target … user=auth_app runtime=non-owner` and `[deploy-gate] PASS … runtime=non-owner`. Sign in, open an admin page, and confirm `select count(*) from auth.app_audit_events` keeps growing. `pnpm db:prune` and `pnpm mcp:reap` work as the login: retention goes through the definer function. Keep the owner's URL for `pnpm db:app:migrate` / `db:auth:migrate` / `db:provision` / `db:seed` / `db:reset`: the login may not create schemas, so the runners stop at their `create schema if not exists` with `permission denied for database <name>` (§5).

Rerunning the command with the same `--login` rotates that login's password at once, so the connections the live deployment opens next fail until it carries the new one. To rotate without that window, create a new login (`--login auth_app_<yyyymmddhhmm>`), point `DATABASE_URL` at it and redeploy, then `alter role <old login> nologin` as the owner.

A self-hosted deployment adopts it the same way: run the command against the database the container uses, put the login in the runtime `DATABASE_URL`, and keep the owner's for the init step ([Docker](./docker.md)).

### 8.4 Pooled runtime, direct migrations

The runtime uses the **pooled** host with `DB_SEARCH_PATH_VIA_OPTIONS=0`: a transaction pooler refuses the startup parameters that carry `search_path` and the two timeouts, so they come from the login's role defaults, which the command set and verified without them. Migrations, the login command, seeds and resets use the **direct** host, as the owner; the migrators and the command refuse a pooled URL. Leave `DB_SEARCH_PATH_VIA_OPTIONS` unset for them.

### 8.5 The gate's privilege check, the ratchet, and break-glass

After the schema check passes, the production build's gate (§1.1) checks the runtime too:

- **As a non-owner** it proves the login holds exactly the manifest, through the same check the command runs. A missing or forbidden privilege is `behind`, so the gate polls while the migrate job's reconcile catches up, and code cannot go live ahead of its grants. A forbidden attribute or membership (a login made in the Neon Console, say) is `fatal`. Then it passes with `runtime=non-owner`.
- **As the owner** it passes with the warning `the app connects as the table owner` as long as no login exists. Once any LOGIN role is a direct member of `<DB_SCHEMA>_runtime` that inherits it or may `SET` it (the owner's own `ADMIN`-only membership from creating the role does not count), a build that connects as the owner is `fatal`: `a least-privilege login exists for this schema but this build connects as the owner <x>`. That ratchet keeps a runtime that was moved to the login from drifting back unnoticed.

**Break-glass**, when production must go back to the owner (the login is broken or leaked): promote the previous deployment (Instant Rollback; see **Rollback** in §5), set Vercel's runtime `DATABASE_URL` to the owner's URL, run `alter role <login> nologin` as the owner so the ratchet stops counting it, and redeploy.

### 8.6 What the runtime credential can still do

The split bounds a stolen runtime credential; it does not make it harmless:

- **The 30-day prune floor.** Through `app_audit_events_prune` it can delete audit rows older than 30 days (10 000 a call), never younger ones.
- **Pseudonymise after deactivation.** It holds `UPDATE` on `app_users`, so it can deactivate an account and then call `app_users_pseudonymise` on it: that rewrites the address, IP address and user agent in that account's audit rows, recent ones included. It cannot delete a row or change anything else, and every call writes a `db.user.pseudonymised` row naming the account, the database login and its `SET ROLE`, which it cannot remove.
- **Forged audit rows.** `INSERT` on `app_audit_events` lets it add rows that never happened. It cannot alter or remove real ones.
- **The latent CASCADE hazard.** Foreign-key actions run as the table's owner, not as the caller. Today `app_audit_events`' foreign keys are `NO ACTION` or `SET NULL` (pinned by `tests/db/runtime-role-grants.db.test.ts`); an `ON DELETE CASCADE` added to one would let an ordinary runtime `DELETE` on the referenced table purge audit rows. Never add one.
- Every other table keeps full DML in version 1.

If the migrating role lacks `CREATEROLE` (some managed providers), 0005 prints a `NOTICE` with the manual steps instead of failing: create the role yourself (`create role auth_runtime nologin;`) and re-run `pnpm db:app:migrate`, whose reconcile then applies the grants. (Neon's `neondb_owner` can create roles.)

**Ledger checksums (review #86).** `app_schema_migrations` now records a sha256 `checksum` per applied file; the runner refuses to proceed if an applied file's hash differs from the ledger, printing the id and both hashes. Rows ledgered before this column existed are backfilled on the next run (logged as `[migrate] backfilled checksum for …`). The hash is of the file's _normalised_ content (comments stripped, whitespace collapsed — `normalizeMigrationSql`), so the comment-only edits this repo deliberately makes to frozen files never move it; only a change to what an applied file _does_ trips the check, and that is a bug to revert (restore the file from `main`, put the change in a new numbered file), not bookkeeping. Only a deliberate DDL change that was already applied by hand to that database needs the pin in `tests/unit/migration-checksums.test.ts` updated and the ledger row corrected with the exact `update … set checksum = …` statement the error prints. The seven files folded into `0002-release.sql` keep their pins in `CONSOLIDATED_CORE_MIGRATIONS` (`src/db/migrations/migration-plan.ts`): a database migrated before the consolidation is checked against them before the runner records `0002-release.sql` there ([§5](#upgrading-a-database-from-before-the-consolidation)). The runner also holds `pg_advisory_lock(hashtext('app_schema_migrations'))` for the whole run (review #85), and so does the Better Auth runner (DEP2), so a deploy racing a manual migrate serialises instead of colliding.

---

_Next: [Configuration](./configuration.md) · [Docker](./docker.md) · [Troubleshooting](./troubleshooting.md)_
