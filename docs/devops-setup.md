# DevOps Setup

_Audience: DevOps / infrastructure engineers standing the system up from scratch and operating it._

> **Scope note.** The repository defines the **application and its database**, plus a CI pipeline. It does **not** include infrastructure-as-code or a committed production deployment target. Where the hosting platform is a free choice, this guide gives platform-neutral steps and marks decisions as `TODO:`.

---

## 1. What the system needs

```mermaid
flowchart TB
    subgraph Required
        APP["Next.js app (Node 22 runtime)"]
        PG[("PostgreSQL 17 + pg_trgm")]
    end
    subgraph Optional
        OAUTH["OAuth providers<br/>Google / Microsoft / GitHub"]
        EMAIL["Email provider<br/>Resend / Mailgun"]
        SENTRY["Sentry project"]
        CDN["CDN / load balancer (TLS)"]
    end
    APP --> PG
    APP -. optional .-> OAUTH
    APP -. optional .-> EMAIL
    APP -. optional .-> SENTRY
    CDN -. fronts .-> APP
```

| Dependency | Required? | Notes |
| --- | --- | --- |
| **Node.js 22 runtime** | Yes | CI uses Node 22; pinned via `.nvmrc` (`22`) and `package.json` `engines` (`node >=22`). |
| **pnpm 10.33.2** | Yes (build) | Pinned via `packageManager`; use Corepack. |
| **PostgreSQL 17** | Yes | Needs `pgcrypto` (`gen_random_uuid()`, used by the migrations) and `pg_trgm` (text search). The local init script also enables `vector` (pgvector); confirm whether production needs it. |
| **TLS termination** | Production | HSTS is sent on every response; terminate TLS at a proxy/CDN/LB. |
| OAuth provider apps | Optional | Only if social login is enabled. |
| Email provider | Optional | Resend or Mailgun; unset = outbox-only. |
| Sentry project | Optional | Error/performance monitoring. |
| Object storage / queue / cache | **None** | The app uses none today. Rate limiting is in-process (see §8). |

> `docker/postgres/init/01-extensions.sql` enables three extensions in `public`: `vector`, `pg_trgm`, and `pgcrypto`. The migrations require **`pgcrypto`** (`gen_random_uuid()`) and **`pg_trgm`** (trigram search), so production must have both. `vector` (pgvector) is enabled locally as groundwork; no application code in scope was confirmed to use vector columns — `TODO:` decide whether the production database needs it.

## 2. Required accounts / services

| Service | Why | Setup pointer |
| --- | --- | --- |
| PostgreSQL host (managed or self-run) | Primary datastore | A managed Postgres 17 with a pooled connection endpoint is recommended for serverless hosts. |
| Application host | Run the Next.js app | See [Deployment → Hosting model](./deployment.md#4-hosting-model). `TODO:` choose Vercel vs. Node server/container. |
| Git host with Actions (GitHub) | CI pipeline | The pipeline is GitHub Actions (`.github/workflows/ci.yml`). |
| Secrets manager | Inject env at deploy | `TODO:` choose (platform secrets, Vault, etc.). |
| OAuth provider consoles | Social login (optional) | Register redirect URIs `BETTER_AUTH_URL/api/auth/callback/<provider>`. |
| Email provider (optional) | Real email delivery | Resend or Mailgun account + API key. |
| Sentry (optional) | Observability | One project; DSN + (for source maps) org/project/auth-token. |

## 3. Database

1. **Provision PostgreSQL 17** (managed recommended). Create a database and a user.
2. **Enable extensions** the app expects, in the **`public`** schema (kept on the search_path so they resolve from every app schema):
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;  -- gen_random_uuid()
   CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;  -- trigram search
   -- vector is enabled locally; enable only if you confirm production needs it
   CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA public;
   ```
   Locally these are applied automatically by `docker/postgres/init/01-extensions.sql`. The migrations also run `create extension if not exists … with schema public`, so this step is belt-and-suspenders.
3. **Choose the application schema** (optional). All tables (app + Better Auth) deploy into one schema, **`auth`** by default; override with `DB_SCHEMA`. The schema itself is created automatically by the migrate step — you do **not** create it by hand. Applied at the connection level via `search_path=<DB_SCHEMA>,public`. To isolate a second application, give it a different `DB_SCHEMA`.
4. **Use a pooled endpoint** in `DATABASE_URL` on serverless platforms; tune `PGPOOL_MAX` and the timeouts for your host. Run migrations/seeds/reset against the **direct** (non-pooled) endpoint — a transaction-pooling pooler can drop the session `search_path` (see [Configuration](./configuration.md#database-postgresql) for the `ALTER ROLE … SET search_path` workaround).
5. **Provision the database before serving traffic** (idempotent; creates the `DB_SCHEMA` schema and provisions all tables into it). The one-shot `pnpm db:provision` runs the migrations **and** the baseline seed (step 6) together, fail-fast:
   ```bash
   pnpm db:provision      # = db:auth:migrate → db:app:migrate → db:seed
   ```
   Or run the steps individually:
   ```bash
   pnpm db:auth:migrate   # Better Auth tables → DB_SCHEMA
   pnpm db:app:migrate    # application schema (0001-initial-schema.sql) → DB_SCHEMA
   ```
6. **Bootstrap the first admin** (one-time; already included in `db:provision` above):
   ```bash
   pnpm db:seed           # default org + permission catalog + roles + admin user
   ```
   In production, change the seeded admin password immediately and/or supply non-default `SEED_ADMIN_*` values.

See [Configuration → Database](./configuration.md#database-postgresql) and the [Data layer](./architecture.md#5-data-model).

## 4. Environment provisioning

1. Start from [`.env.example`](../.env.example).
2. Provide the **required** set: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `DATABASE_URL`, and (for SSO) `SSO_HANDOFF_ISSUER` / `SSO_HANDOFF_AUDIENCE_PREFIX` / `SSO_HANDOFF_JWT_SECRET` / `SSO_HANDOFF_APPLICATION_ID`.
3. Generate secrets with a CSPRNG; keep `SSO_HANDOFF_JWT_SECRET` **distinct** from `BETTER_AUTH_SECRET`.
4. Enable optional features per environment (email, machine API, social login, Sentry).
5. Inject secrets through your platform's secrets mechanism — never commit `.env`.

Full reference: [Configuration](./configuration.md).

## 5. Build pipeline (CI)

CI is GitHub Actions: **`.github/workflows/ci.yml`**, triggered on `push` and `pull_request`, with in-progress runs cancelled per ref. Runners use **Node 22** and **pnpm 10.33.2**, with a **PostgreSQL service container** (`pgvector/pgvector:pg17`) on port 5444.

```mermaid
flowchart LR
    PRpush["push / pull_request"] --> Q & B & A
    subgraph Q["job: quality"]
        q1["pnpm install --frozen-lockfile"] --> q2["typecheck"] --> q3["lint"] --> q4["format:check"] --> q5["build"] --> q6["test:coverage (sharded + ratchet)"] --> q7["upload coverage"]
    end
    subgraph B["job: browser"]
        b1["install + playwright deps"] --> b2["build"] --> b3["db:auth/app:migrate + seed"] --> b4["start server"] --> b5["test:e2e"] --> b6["test:a11y"]
    end
    subgraph A["job: audit (hard gate)"]
        a1["pnpm audit --audit-level high"]
    end
```

| Job | Blocking | Does |
| --- | --- | --- |
| **quality** | yes | typecheck → lint → format check → `next build` → sharded tests with coverage gate → app migrate + DB-backed integration tests → upload coverage artifact |
| **browser** | yes | install Playwright → build → migrate + seed → start server → e2e → accessibility (axe-core) → upload traces on failure |
| **audit** | yes | `pnpm audit --audit-level high` — a **hard gate**; a new high+ advisory not allowlisted in `package.json` → `pnpm.auditConfig.ignoreGhsas` fails CI |
| **sdk-drift** | yes | regenerates the OpenAPI spec + admin SDK (`pnpm sdk:admin:generate`) and fails on any drift, then typechecks the generated SDK |
| **links** | yes | `lychee` (offline) verifies every relative doc link and `#fragment` in the published docs resolves |
| **auth-schema-drift** | yes | regenerates the Better Auth schema snapshot (`pnpm db:auth:generate`) and fails if `src/db/migrations/better-auth-schema.sql` drifts |

### Security gates (separate workflows)

Three security scanners run as their own workflows on `push`/`pull_request` to `main` (plus a weekly schedule), and publish findings to the GitHub **Security tab** (code scanning):

| Workflow | Tool | Gate |
| --- | --- | --- |
| `.github/workflows/docker-scan.yml` | **Trivy** image scan | Builds the production image and fails on **fixable** HIGH/CRITICAL CVEs not in `.trivyignore` (`--ignore-unfixed`). Covers the base OS layer + runtime image, complementing `pnpm audit`. |
| `.github/workflows/codeql.yml` | **CodeQL** SAST | `security-extended` query suite over the TypeScript/JavaScript source. (SARIF upload needs GitHub Advanced Security on private repos.) |
| `.github/workflows/secret-scan.yml` | **gitleaks** | Scans the checkout for committed secrets; allowlist of intentional dummy values in `.gitleaks.toml`. Fails the job on any finding. |

See [Testing](./testing.md) and [Deployment → CI/CD](./deployment.md#6-cicd-pipeline).

## 6. Deployment steps (platform-neutral)

```mermaid
flowchart LR
    code["main (green CI)"] --> migrate["1. Run DB migrations (gated)"] --> build["2. Build artifact (next build)"] --> deploy["3. Deploy app"] --> verify["4. Post-deploy verification"]
```

1. **Gate on green CI** on `main`.
2. **Run migrations first**, before the new version serves traffic:
   ```bash
   pnpm db:auth:migrate && pnpm db:app:migrate
   ```
   The schema is idempotent and the runner records applied files, so re-running is safe.
3. **Build & deploy** the app (`pnpm build` then `pnpm start`, or your platform's build step). See [Deployment](./deployment.md).
4. **Verify** (see §11 and [Deployment → Post-deploy](./deployment.md#8-post-deployment-verification)).

## 7. Rollback strategy

- **Application:** redeploy the previous known-good build/image. The app is stateless apart from the database, so app rollback is a redeploy.
- **Database:** migrations follow an **additive / backward-compatible contract** and are idempotent; there are **no down-migrations**. To roll back, **revert the app build, leaving the additive migrations ahead** — the previous build is designed to run against the newer schema. **Never auto-down-migrate.** Recover lost _data_ (as opposed to a bad deploy) via your provider's PITR / snapshot (§9), not by reverting schema.
- **Concrete steps:**
  - **Vercel:** promote the last-known-good deployment (dashboard → previous deployment → "Promote to Production", or `vercel rollback`). The deploy pipeline migrates _before_ promoting, so a rollback needs no DB change.
  - **Container:** redeploy the previous image tag (keep the prior digest-pinned tag available).
- A migration that genuinely must be reverted is authored as a **new forward migration** — never edit an applied one.

## 8. Monitoring & logging

| Signal | Source | Notes |
| --- | --- | --- |
| **Audit trail** | `app_audit_events` table | First-party, durable record of who-did-what; query by `request_id`. |
| **Errors / traces / Web Vitals** | Sentry (opt-in) | Enable via `NEXT_PUBLIC_SENTRY_DSN`; PII scrubbed before send. See [Configuration](./configuration.md). |
| **Request correlation** | `x-request-id` response header | Ties a response to its audit rows and Sentry events. |
| **App logs** | stdout/stderr of the Node process | Captured by your platform's log aggregation. |
| **DB health** | Postgres metrics | Connections, slow queries; the app sets per-statement timeouts. |

**Rate limiting is in-process** (per-actor token bucket). It resets on restart and is **not shared across instances** — acceptable for a single instance, but multi-instance deployments should treat it as best-effort until a shared backend is added.

> `TODO:` If running multiple app instances, plan a shared rate-limit backend (e.g. Redis) — the current store is in-memory per process.

### Scheduled maintenance jobs

The app ships no scheduler of its own — these are periodic tasks to wire into your platform's cron / Kubernetes CronJob / init runner. Both connect to Postgres directly, are idempotent, and exit non-zero only on an unexpected error.

| Command | Script | What it does | Cadence |
| --- | --- | --- | --- |
| `pnpm outbox:drain` | `scripts/drain-outbox.ts` | Re-attempts delivery of retryable `app_outbox` rows (safe to run concurrently — `SKIP LOCKED`). Tune with `OUTBOX_DRAIN_LIMIT` (default 100). | Frequent (e.g. every few minutes) for timely email retries. |
| `pnpm db:prune` | `scripts/prune-retention.ts` | Prunes expired token revocations and applies the retention windows to `app_audit_events` (`AUDIT_RETENTION_DAYS`, default 365) and terminal `app_outbox` rows (`OUTBOX_RETENTION_DAYS`, default 90). Set either window to `0` to disable that table's time-based prune. | Daily. |

On **serverless** (Vercel) there is no long-running process for the drainer, so `vercel.json` declares a Cron Job that hits the secret-guarded `GET /api/internal/outbox-drain` — see [Deployment → CI/CD](./deployment.md#6-cicd-pipeline). Schedule `pnpm db:prune` the same way (an external cron / GitHub Actions `schedule:` invoking the script against the production DB).

## 9. Backup & restore

- **What to back up:** the PostgreSQL database is the only stateful component. There is no object storage or queue to back up.
- **How:** prefer the managed provider's automated backups + **point-in-time recovery (PITR)**. If self-hosting, schedule a logical dump with `pg_dump`.

**Procedure A — managed Postgres PITR (preferred).** Rely on the provider's continuous backup. To recover, restore the cluster to a chosen timestamp through the provider's console/CLI, repoint `DATABASE_URL` at the restored endpoint, and run post-deploy verification (§11). Set the backup window/retention to meet your RPO/RTO targets.

**Procedure B — `pg_dump` → scratch DB → verify → cutover.** Take a logical backup against the **direct** (non-pooled) endpoint, restore it into a scratch database, confirm the schema applies, verify, then cut over:

```bash
# 1. Dump (custom format; --no-owner/--no-privileges for portability).
#    Include the app schema (DB_SCHEMA, default `auth`) and `public` (extensions).
pg_dump "$PRODUCTION_DIRECT_DATABASE_URL" \
  --format=custom --no-owner --no-privileges \
  --schema=auth --schema=public \
  --file=backup-$(date +%Y%m%d).dump

# 2. Restore into a fresh scratch database.
createdb devresponsekit_restore
pg_restore --clean --if-exists --no-owner \
  --dbname="postgresql://USER:PASS@HOST:5432/devresponsekit_restore" \
  backup-YYYYMMDD.dump

# 3. Verify the schema is current (idempotent; should be a no-op on a good backup).
DATABASE_URL="postgresql://USER:PASS@HOST:5432/devresponsekit_restore" \
  pnpm db:app:migrate
```

Then smoke-test against the restored DB (sign-in, a DB-backed admin list) and cut over by repointing `DATABASE_URL` at the restored database.

- **Restore test:** periodically run Procedure B end-to-end into a scratch DB so the backups are known-good, not just present.

> Set the backup frequency and retention to meet your **RPO/RTO** — these are provider/topology decisions, not repo defaults.

## 10. Security considerations

- **Secrets:** distinct `BETTER_AUTH_SECRET` and `SSO_HANDOFF_JWT_SECRET`; rotate on a schedule (see below). Keep `SENTRY_AUTH_TOKEN` build-only.
- **Headers:** static ones (X-Frame-Options DENY, nosniff, HSTS, Permissions-Policy, Reporting-Endpoints) ship from `next.config.mjs`. The CSP is **enforcing** and nonce-based, minted per request in `src/proxy.ts` (`script-src` uses `'nonce-…' 'strict-dynamic'`, no `'unsafe-inline'`/`'unsafe-eval'`); violations still report to `/api/security/csp-report`.
- **Origin/CSRF guard** on admin mutations; **trusted proxy count** for correct client-IP attribution behind a CDN.
- **Machine API** is off by default; enable per environment with a real signing key and least-privilege scopes.
- **TLS everywhere** in production so HSTS is meaningful.
- **Tenant isolation** is enforced centrally and CI-tested; keep the invariant tests in the required checks.

### Secret rotation

Rotate through your secrets manager (never `.env`), then redeploy. Steps per secret:

- **`API_JWT_PRIVATE_KEY` (Ed25519 JWK) — dual-key, zero-downtime.** The verifier publishes both the current and a previous public key in JWKS, so existing tokens keep verifying during the overlap (`API_JWT_PREVIOUS_*` is never used to mint).
  1. Set `API_JWT_PREVIOUS_PRIVATE_KEY` to the **current** `API_JWT_PRIVATE_KEY` (and `API_JWT_PREVIOUS_KID` to the current `API_JWT_KID`, only if you pin an explicit kid rather than the JWK thumbprint).
  2. Mint a **new** key:
     ```bash
     node -e "import('jose').then(async (j) => { const { privateKey } = await j.generateKeyPair('EdDSA', { extractable: true }); process.stdout.write(JSON.stringify(await j.exportJWK(privateKey))) })"
     ```
  3. Set the output as the new `API_JWT_PRIVATE_KEY` (and a new `API_JWT_KID` if you pin one), and **redeploy**.
  4. After the access-token TTL elapses (`API_JWT_ACCESS_TTL_SECONDS`, ≤ 1h), **drop `API_JWT_PREVIOUS_PRIVATE_KEY`/`API_JWT_PREVIOUS_KID`** and redeploy.
- **`BETTER_AUTH_SECRET`** — generate a new CSPRNG value and redeploy. **This invalidates all sessions — every user is signed out.** Schedule it accordingly (or accept it during a breach).
- **`SSO_HANDOFF_JWT_SECRET`** — must match between hub and receiver. Rotate both ends together; in-flight handoff tokens (≤60s TTL) minted under the old secret will fail, so rotate during a quiet window.
- **`CRON_SECRET` / `METRICS_TOKEN`** — rotate the value and update the caller (the cron invoker / Prometheus scrape config) in the same change.
- **Provider keys** (`EMAIL_*`, OAuth client secrets, `SENTRY_AUTH_TOKEN`) — rotate at the provider, update the secret, redeploy. `SENTRY_AUTH_TOKEN` is build/CI-only.

## 11. Production-readiness checklist

- [ ] PostgreSQL 17 provisioned; `pg_trgm` enabled; pooled `DATABASE_URL`.
- [ ] `pnpm db:auth:migrate` and `pnpm db:app:migrate` run successfully against production.
- [ ] First admin bootstrapped; default seed password changed.
- [ ] All **required** env vars set; secrets from a manager, not `.env`.
- [ ] `BETTER_AUTH_SECRET` ≠ `SSO_HANDOFF_JWT_SECRET`; both strong and unique.
- [ ] `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` match the real public origin.
- [ ] TLS terminated; HSTS verified; `TRUSTED_PROXY_COUNT` matches the proxy depth.
- [ ] Optional features configured intentionally (email, OAuth, machine API, Sentry).
- [ ] CI green on `main`; required checks include the scope/rate-limit invariants and coverage gate.
- [ ] Backups + PITR enabled and a restore tested.
- [ ] Monitoring in place (Sentry and/or platform logs); audit log reachable by ops.
- [ ] Rollback runbook written for the chosen host and DB.
- [ ] `TODO:` items in this doc resolved for your environment.

---

_Next: [Deployment](./deployment.md) for build/artifact/release detail._
