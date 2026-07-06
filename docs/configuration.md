# Configuration

_Audience: developers and DevOps. Every environment variable, the config files, and how local differs from production. The authoritative template is [`.env.example`](../.env.example)._

---

## 1. How configuration is loaded

- Environment variables are read from the process environment. Locally, copy `.env.example` to `.env`. `dotenv` is available for scripts; Next.js inlines `NEXT_PUBLIC_*` at build time.
- Server-side variables are validated in `src/lib/env.ts` — several features **fail fast at boot** if misconfigured (e.g. `API_JWT_ENABLED` without a signing key, or an email provider without its credentials).
- `NEXT_PUBLIC_*` values are **embedded in the client bundle** at build time — never put secrets in them.

## 2. Environment variables

### Application

| Variable | Required | Default (example) | Controls |
| --- | --- | --- | --- |
| `NODE_ENV` | No (defaults to development) | `development` | Standard Node environment; `production` for deploys. |
| `NEXT_PUBLIC_APP_NAME` | no | `DevResponse Enterprise` | Display name in the UI. |
| `NEXT_PUBLIC_APP_URL` | yes | `http://localhost:3000` | Public origin; trusted origin, inlined at build. |
| `NEXT_PUBLIC_PRODUCTION_HOST` | no | `app.devresponse.com` | Production host; also seeds the SSO origin-suffix default. |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | no | `en` | **Informational only — NOT read at runtime.** The canonical default lives in `src/config/i18n-config.ts`; editing this does not change behavior. |
| `NEXT_PUBLIC_SUPPORTED_LOCALES` | no | `en,fr,es,uk,pt,zh,hi,ja` | **Informational only — NOT read at runtime.** The canonical locale list lives in `src/config/i18n-config.ts`; editing this does not change behavior. |

### Authentication (Better Auth)

| Variable | Required | Controls |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | **yes** | Signing secret for sessions. Use ≥32 random bytes. Rotating it invalidates all sessions. |
| `BETTER_AUTH_URL` | **yes** | Origin where `/api/auth/*` is reachable. Must match the browser origin. Also the base origin baked into links in outbound emails — verification, password reset, and invitation accept links. |
| `ADMIN_TRUSTED_ORIGINS` | no | Extra comma-separated trusted origins for Better Auth and the admin origin guard (the app's own origin is always trusted). |

### Database (PostgreSQL)

| Variable | Required | Controls |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Primary connection string. Use a **direct/unpooled** endpoint by default; a **pooled** endpoint additionally needs `DB_SEARCH_PATH_VIA_OPTIONS=0` + an `ALTER ROLE` (see the pooler note below). Do **not** add `?schema=…` — it is ignored by `pg`/Kysely; the schema is set via `DB_SCHEMA` (below). |
| `DATABASE_TEST_URL` | for tests | Isolated test database connection. |
| `DB_SCHEMA` | no | Schema **all** tables (app + Better Auth) are deployed into. Default `auth`. Applied at the connection level as `search_path=<DB_SCHEMA>,public`; extensions (`pgcrypto`, `pg_trgm`) stay shared in `public`. Set a different value per deployment to **isolate applications by schema**. Must be a plain SQL identifier. |
| `PGPOOL_MAX` | no | Max pool connections (default 10). |
| `PG_CONNECT_TIMEOUT_MS` | no | Connection acquisition timeout (default 5000). |
| `PG_STATEMENT_TIMEOUT_MS` | no | Per-statement server-side ceiling (default 30000). |
| `PG_IDLE_IN_TX_TIMEOUT_MS` | no | Idle-in-transaction server-side ceiling (default 30000). |
| `DB_SEARCH_PATH_VIA_OPTIONS` | no | Whether to set `search_path` via the libpq `options` startup parameter (default **on**). Set to `0` only on a **transaction-pooling** endpoint, which rejects startup parameters — see the pooler note below. |

> **Schema & connection poolers:** by default the connection sets `search_path` via the libpq `options` **startup parameter**. A **transaction-pooling** endpoint (Neon's pooled host, PgBouncer transaction mode, some Supabase tiers) **rejects startup parameters** — every connection fails with `08P01 unsupported startup parameter in options: search_path`. To run against one: **(1)** set the schema as a server-side role default the pooler honors — `ALTER ROLE <app_role> SET search_path = auth, public;` — and **(2)** set `DB_SEARCH_PATH_VIA_OPTIONS=0` so the app stops sending the rejected parameter. Migrations/seeds/reset always use the **direct** (non-pooled) endpoint (they need the parameter, plus DDL + advisory locks the pooler can't do).

### Social login (all optional — a provider activates only when both id and secret are set)

| Variable | Controls |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft Entra ID OAuth (multi-tenant). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth. |

### Single Sign-On handoff

> **Required at boot for every deployment.** Despite the "SSO" name, `src/lib/env.ts` validates `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID`, and `SSO_HANDOFF_JWT_SECRET` **unconditionally** (`.min(1)` / `.min(16)`). The app **fails fast at boot** if any is missing — even on a deployment that never uses SSO. Set all four everywhere (placeholder values are fine when SSO is unused).

| Variable | Required | Controls |
| --- | --- | --- |
| `SSO_HANDOFF_ISSUER` | **yes (at boot)** | `iss` claim of handoff tokens. |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | **yes (at boot)** | Audience is built as `<prefix>:<applicationId>`. |
| `SSO_HANDOFF_APPLICATION_ID` | **yes (at boot)** | This deployment's application id, so the audience check can't be spoofed via the Host header. |
| `SSO_HANDOFF_JWT_SECRET` | **yes (at boot)** | HS256 signing secret (≥16 chars). **Must differ** from `BETTER_AUTH_SECRET`. |
| `SSO_HANDOFF_TTL_SECONDS` | no | Token lifetime (default 60; clamped to a small max). |
| `SSO_ALLOWED_ORIGIN_SUFFIXES` | no | Comma-separated allow-list of host suffixes a registered app origin may use. Unset → derived from `NEXT_PUBLIC_PRODUCTION_HOST`. |

### Reverse proxy / limits

| Variable | Default | Controls |
| --- | --- | --- |
| `TRUSTED_PROXY_COUNT` | 1 | Number of trusted proxies/CDNs; the client IP for rate-limit keys is taken this many hops from the right of `X-Forwarded-For`. |
| `ADMIN_EXPORT_MAX_ROWS` | 100000 | Hard row cap for a single CSV export; the file is marked truncated past the cap. |

### Email

| Variable | Controls |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` \| `mailgun` \| unset. **Unset = outbox-only** (recorded, never sent) — the default for dev/CI. |
| `EMAIL_FROM` | From address/name. |
| `RESEND_API_KEY` | Resend API key (when provider = resend). |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL` | Mailgun config (use `https://api.eu.mailgun.net` for EU). |
| `CRON_SECRET` | Shared secret the scheduler presents (as `Authorization: Bearer …`) to `GET /api/internal/outbox-drain`, which retries `pending` outbox rows on a serverless host (no long-running `pnpm outbox:drain` process). The route **fails closed** when unset. Vercel Cron attaches it automatically when the env var is set; see `vercel.json` + [deployment.md](./deployment.md#7-ci). |

### Machine API credentials (both paths DARK by default)

| Variable | Controls |
| --- | --- |
| `API_KEYS_ENABLED` | Enable API-key auth (`1`/`true`). |
| `API_KEY_ENV_TAG` | `live` \| `test` — stamped into `drk_<tag>_…`. |
| `API_KEY_DEFAULT_TTL_DAYS` | Default key expiry (empty = never expire; UI warns). |
| `API_JWT_ENABLED` | Enable JWT access tokens (`1`/`true`). |
| `API_JWT_ISSUER` | `iss` claim (defaults to `BETTER_AUTH_URL`). |
| `API_JWT_AUDIENCE` | Expected `aud` (e.g. `devresponse-api`). |
| `API_JWT_PRIVATE_KEY` | Ed25519 private JWK as a JSON string. **Required** when JWT enabled. |
| `API_JWT_KID` | Key id (defaults to the JWK thumbprint). |
| `API_JWT_PREVIOUS_PRIVATE_KEY` | Verify-only previous signing key (the prior `API_JWT_PRIVATE_KEY`) kept during a rotation overlap — its public half stays in JWKS so tokens minted before the rotation keep verifying until they expire. Never used to mint; remove once that window drains. |
| `API_JWT_PREVIOUS_KID` | The previous key's `kid` — only needed when the deployment pins a fixed `API_JWT_KID` (otherwise the thumbprint matches automatically). |
| `API_JWT_ACCESS_TTL_SECONDS` | Token lifetime (default 900, ≤3600). |

Generate an Ed25519 JWK:

```bash
node -e "import('jose').then(async j => { const {privateKey}=await j.generateKeyPair('EdDSA',{extractable:true}); console.log(JSON.stringify(await j.exportJWK(privateKey))) })"
```

### Seeding

| Variable | Controls |
| --- | --- |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Local seed admin credentials. |
| `SEED_DEFAULT_ORGANIZATION_SLUG` | Default org slug (e.g. `default`). |
| `DEV_SEED_PASSWORD` | Shared password for the multi-org dev fixture. |
| `DEV_SEED_ALLOW_PROD` | Set `1` to allow the dev fixture under `NODE_ENV=production` (otherwise it refuses). |

### Observability (opt-in)

| Variable | Controls |
| --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | **Presence enables** client monitoring and the build-time plugin. |
| `SENTRY_DSN` | Server DSN (defaults to the public DSN). |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_ENVIRONMENT` | Environment tag (defaults to `NODE_ENV`). |
| `NEXT_PUBLIC_SENTRY_RELEASE` | Release tag (e.g. git SHA). |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_TRACES_SAMPLE_RATE` | Tracing sample rates. |
| `NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`, `…_ERROR_SAMPLE_RATE` | Session-replay sampling. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | **Build/CI only** — source-map upload. Never expose `SENTRY_AUTH_TOKEN` to the client. |
| `METRICS_TOKEN` | **Presence enables** the Prometheus scrape endpoint `GET /api/metrics`. The route **fails closed** when unset (401, nothing exposed). Scrapers present it as `Authorization: Bearer …`; compared in constant time. See [observability.md](./observability.md#5-metrics). |
| `LOG_LEVEL` | Structured-logger level: `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`. Defaults to `info` (and to `silent` under `NODE_ENV=test`). |

### Docs viewer & test escape hatch

| Variable | Controls |
| --- | --- |
| `DOCS_SOURCE`, `DOCS_ROOT`, `DOCS_ALLOW_MDX_EXECUTION`, `DOCS_INTERNAL_VISIBLE` | In-app docs viewer (all optional; defaults serve the repo `docs/` read-only). |
| `AUTH_RATE_LIMIT_DISABLED` | **Test only** — disables Better Auth's built-in sign-in rate limiter. Never set in production. |

### Operations & data retention

| Variable | Default | Controls |
| --- | --- | --- |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | Graceful-shutdown drain budget (ms). On `SIGTERM`/`SIGINT` the pg pool is drained within this window so in-flight queries finish cleanly; a stuck query can never hang shutdown past it. |
| `AUDIT_RETENTION_DAYS` | 365 | Retention window for `app_audit_events`, applied by `pnpm db:prune`. A compliance record, so the window is long. Set to `0` to disable that table's time-based prune. |
| `OUTBOX_RETENTION_DAYS` | 90 | Retention window for terminal `app_outbox` rows (`sent`/`failed`/`logged`), applied by `pnpm db:prune`. `pending` rows (in-flight retries) are never pruned. Set to `0` to disable. |

## 3. Config files

| File | Purpose |
| --- | --- |
| `next.config.mjs` | Static security headers (X-Frame-Options, HSTS, Reporting-Endpoints, …), next-intl plugin, opt-in Sentry plugin. The enforcing nonce-based CSP is minted per request in `src/proxy.ts`. |
| `vitest.config.ts` | Test config + coverage thresholds (the ratchet). |
| `playwright.config.ts` | E2E/accessibility browser test config. |
| `tsconfig.json` | TypeScript (strict; path aliases). |
| `eslint.config.mjs` | Linting (`eslint-config-next` + `typescript-eslint`). |
| `.prettierrc.json` / `.prettierignore` | Formatting (with Tailwind plugin). |
| `components.json` | shadcn/ui generator config. |
| `postcss.config.mjs` | Tailwind/PostCSS. |
| `docker-compose.yml` | Local PostgreSQL service. |
| `docker/postgres/init/*.sql` | Postgres extensions on first boot (`pgcrypto`, `pg_trgm`, `vector`), installed into `public`. |
| `.npmrc`, `.gitattributes`, `.gitignore` | Tooling/VCS settings. |

## 4. Local vs production

| Concern | Local | Production |
| --- | --- | --- |
| Database | Docker `pgvector/pgvector:pg17` on port 5444 | Managed PostgreSQL 17 with `pg_trgm`; direct endpoint (or pooled — see the pooler note above) |
| DB schema | `auth` (default `DB_SCHEMA`) | `auth`, or a per-app value via `DB_SCHEMA`; extensions in `public` |
| `NODE_ENV` | `development` | `production` |
| Secrets | Placeholder values in `.env` | Real, rotated secrets from a secrets manager |
| Email | Provider unset → outbox-only | Real provider (Resend/Mailgun) |
| Machine API | Usually off | Enabled per need with real signing key |
| Observability | Off (no DSN) | Sentry DSN set; source-map upload in CI |
| HTTPS/HSTS | HTTP (HSTS inert) | TLS terminated upstream; HSTS active |
| Migrations | `pnpm db:*` ad hoc | Run as a gated step **before** serving traffic |

## 5. Minimal `.env` template

```dotenv
# --- Required everywhere ---
NODE_ENV=development
NEXT_PUBLIC_APP_URL=http://localhost:3000
BETTER_AUTH_SECRET=<32+ random bytes>
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=postgresql://devresponse:devresponse@localhost:5444/devresponse_db
DB_SCHEMA=auth

# --- Required if using SSO handoff ---
SSO_HANDOFF_ISSUER=http://localhost:3000
SSO_HANDOFF_AUDIENCE_PREFIX=devresponse-app
SSO_HANDOFF_JWT_SECRET=<different 32+ random bytes>
SSO_HANDOFF_APPLICATION_ID=portal

# --- Local seed admin ---
SEED_ADMIN_EMAIL=admin@devresponse.local
SEED_ADMIN_PASSWORD=ChangeMe-LocalOnly-123!
SEED_DEFAULT_ORGANIZATION_SLUG=default

# --- Optional features (see .env.example for the full set) ---
# EMAIL_PROVIDER=resend
# API_KEYS_ENABLED=1
# API_JWT_ENABLED=1
# NEXT_PUBLIC_SENTRY_DSN=
```

> Use [`.env.example`](../.env.example) as the complete, commented reference — it documents every variable above plus the optional ones.

## 6. Secrets checklist

- [ ] `BETTER_AUTH_SECRET` — unique, ≥32 bytes, rotated on a schedule.
- [ ] `SSO_HANDOFF_JWT_SECRET` — **different** from `BETTER_AUTH_SECRET`.
- [ ] `API_JWT_PRIVATE_KEY` — Ed25519 JWK, only if JWT enabled.
- [ ] OAuth client secrets — per provider, only if social login enabled.
- [ ] `RESEND_API_KEY` / `MAILGUN_API_KEY` — only if email enabled.
- [ ] `SENTRY_AUTH_TOKEN` — build/CI only, never client-exposed.
- [ ] `METRICS_TOKEN` — only if scraping `/api/metrics`; long random secret, scraper-side only.
- [ ] `DATABASE_URL` — direct endpoint by default; a pooled endpoint also needs `DB_SEARCH_PATH_VIA_OPTIONS=0` + an `ALTER ROLE` (see the pooler note above).

---

## Variables read directly (not boot-validated)

Most variables above are validated at boot by `src/lib/env.ts` — a missing or malformed **required** one fails the process immediately. A few operational knobs are instead read straight from `process.env` at the point of use, so a bad value fails (or falls back) only when that feature runs, not at boot:

| Variable | Used by | If unset |
| --- | --- | --- |
| `CRON_SECRET` | `/api/internal/outbox-drain` | endpoint fails closed (401) |
| `METRICS_TOKEN` | `/api/metrics` | endpoint fails closed (401) |
| `LOG_LEVEL` | the Pino logger | defaults to `info` (`silent` under test) |
| `AUDIT_RETENTION_DAYS` / `OUTBOX_RETENTION_DAYS` | `pnpm db:prune` | default 365 / 90; `0` disables |
| `SHUTDOWN_TIMEOUT_MS` | graceful-shutdown drain | defaults to 10000 ms |
| `DB_MIGRATE_LOCALES` | `pnpm db:app:migrate` | localized email-template migrations applied unless `0`/`false`/`no`/`off` (the English base `locales/0000-email-templates-en.sql` is always applied) |
| `SENTRY_*` / `NEXT_PUBLIC_SENTRY_*` | Sentry build + runtime | Sentry stays off unless a DSN is present (see [Observability](./observability.md)) |

---

_Next: [Deployment](./deployment.md) for build, release, and from-scratch stand-up._
