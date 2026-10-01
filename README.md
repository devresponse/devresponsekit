# devresponsekit

Enterprise Next.js 16 "Holy Grail" application shell with authentication,
multi-organization user management, an administrator console, a
self-service account area, outbound email, and cross-subdomain SSO
handoff.

## Stack

- **Next.js 16** (App Router, Server Components, `proxy.ts` middleware)
- **Better Auth** — email/password (with password reset) + Google /
  Microsoft / GitHub social login, session management, admin plugin
  (ban, impersonation), and a server-only plugin that establishes the
  consumer-side session on SSO handoff
- **PostgreSQL + Kysely** — typed SQL for app tables; Better Auth shares
  the same `pg` pool. The application schema starts from the frozen
  `0001-initial-schema.sql` baseline, with later changes shipped as
  append-only numbered migrations (`NNNN-*.sql`): today `0002-release.sql`,
  the 1.x/2.x changes consolidated into one file, so a new database applies
  two core files. The runner applies any not-yet-recorded file in order, each
  in a transaction, recording it in `app_schema_migrations`
- **Machine API** — a versioned `/api/v1` REST surface authenticated by
  API keys (`drk_…`) or Ed25519 JWT access tokens, with a published
  JWKS document, OAuth client-credentials, and an OpenAPI spec. Ships
  disabled by default (see [docs/api.md](docs/api.md))
- **Outbound email** — outbox-first, with pluggable Resend / Mailgun
  delivery and editable templates (see [docs/configuration.md](docs/configuration.md))
- **next-intl** — localized routing (`en`, `fr`, `es`, `uk`, `pt`, `zh`, `hi`, `ja`)
- **Tailwind CSS 4 + shadcn/ui** — design system primitives
- **Vitest / Playwright / axe-core** — unit, component, integration,
  security, e2e, and accessibility test suites (e2e + a11y run in CI
  against a production build)

## Quick start

Prerequisites: Node 24 (what CI, the Docker image and Vercel run), pnpm 10, Docker (for local PostgreSQL).

```bash
pnpm install
cp .env.example .env          # then edit secrets

pnpm db:up                    # start PostgreSQL (docker compose)
pnpm db:provision             # one shot: Better Auth tables + app schema + seed

pnpm dev                      # http://localhost:3000
```

The seed creates a local admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
from `.env`). New self-registered accounts start as `pending_approval`
until an administrator approves them — the platform default. Each
organization's sign-up policy can instead auto-activate registrations,
require invitations, or auto-approve verified email domains; see
[docs/auth-signup-policy.md](docs/auth-signup-policy.md).

For the complete path — prerequisites, configuration reference, production
build, and deploying a fully functional instance — see the canonical docs in
[docs/](docs/README.md) (start with [Configuration](docs/configuration.md) and
[Deployment](docs/deployment.md)).

## Deployment

Production ships through **Vercel's Git integration**: every push to `main` is
built and promoted automatically. Vercel does not run migrations, so the
ordering is a standing **operator gate** — a pull request that adds a database
migration is applied to production **first** (`pnpm db:app:migrate` against the
production direct/unpooled `DATABASE_URL`, and `pnpm db:auth:migrate` when
`better-auth-schema.sql` changed), and merged **second**. Merging first
promotes a build that expects a schema the database does not have; the tell is
`GET /api/health/ready` answering **503 `schema_behind`**.

Two tools automate that order instead. [`vercel-cli/`](vercel-cli/README.md)
(`drk-deploy`) does migrate → build → promote → verify from your machine and
works today; `.github/workflows/deploy.yml` does the same in CI but has none of
its four credentials configured, so it skips itself and says so (DEPLOY-1).
Full detail, and what adopting either would take, is in
[docs/deployment.md §1](docs/deployment.md#1-how-this-repo-deploys).

## Scripts

| Command           | Purpose                                           |
| ----------------- | ------------------------------------------------- |
| `pnpm dev`        | Start the dev server                              |
| `pnpm build`      | Production build                                  |
| `pnpm typecheck`  | TypeScript, no emit                               |
| `pnpm lint`       | ESLint (flat config, eslint-config-next)          |
| `pnpm format`     | Prettier write (LF line endings enforced)         |
| `pnpm test`       | Vitest: unit + component + integration + security |
| `pnpm test:e2e`   | Playwright end-to-end tests                       |
| `pnpm test:a11y`  | Playwright + axe accessibility tests              |
| `pnpm test:all`   | typecheck + lint + format check + coverage + e2e + a11y |
| `pnpm db:codegen` | Regenerate Kysely types from the live schema      |
| `pnpm db:seed:dev` | Optional dev/testing seed: 3 orgs × 7 users + cross-org members, groups & demo activity |
| `pnpm db:reset`   | Dry run: list every table a reset would drop      |
| `pnpm db:reset:reload` | Drop all tables, then re-run migrations + seed (local only) |
| `pnpm db:provision` | Provision a fresh database in one shot: Better Auth + app schema + seed |
| `pnpm db:app:migrate` | Apply the app schema migrations                  |
| `pnpm db:prune`   | Prune expired revocations/SSO nonces + aged audit/outbox rows (cron — see [Deployment](docs/deployment.md)) |
| `pnpm outbox:drain` | Retry pending outbox emails (cron)               |
| `pnpm mcp:reap`   | Expire stale pending MCP self-registrations (cron) |
| `pnpm openapi:export` | Write the admin OpenAPI document to `docs/`      |
| `pnpm sdk:admin:generate` | Regenerate the typed admin SDK from the OpenAPI doc |

## Project layout

```
src/
  app/(root)                          # bare "/" → default-locale redirect
  app/[locale]/(public)               # localized marketing landing page (/[locale]) + about, public docs, logged-out
  app/[locale]/(auth)                 # sign-in (+ /[org]), sign-up, email verification, forgot/reset password, invitation accept, SSO confirm, status pages
  app/[locale]/(secure)               # session-gated shell + workspaces
  app/[locale]/(secure)/app/dashboard       # landing workspace
  app/[locale]/(secure)/app/workspace       # nested ApplicationShell example
  app/[locale]/(secure)/app/docs            # in-app Markdown docs viewer (+ /[...slug])
  app/[locale]/(secure)/app/help            # screenshot walkthrough, served by the same viewer (+ /[...slug])
  app/[locale]/(secure)/app/account         # self-service account (profile, preferences, security, api-keys)
  app/[locale]/(secure)/app/administrator   # admin console (users, roles, groups, permissions, orgs, memberships, apps, api-keys, MCP agents, audit, email)
  app/api/auth                        # Better Auth catch-all (sign-in, sign-up, sessions, social callbacks)
  app/api/account                     # self-scoped account REST API
  app/api/administrator               # admin REST API (guarded pipeline)
  app/api/v1                          # versioned machine API (API keys, JWT, OAuth clients, JWKS, OpenAPI)
  app/api/mcp                         # MCP agent gateway (+ /register, dynamic client registration)
  app/api/sso                         # JWT handoff launch/consume + the handoff JWKS
  app/api/invitations                 # organization invitation accept
  app/api/navigation                  # server-filtered shell menus
  app/api/docs                        # auth-gated docs image assets
  app/api/help                        # auth-gated help screenshot assets
  app/api/preferences                 # locale and active-organization preferences
  app/api/health                      # liveness + readiness probes
  app/api/metrics                     # Prometheus metrics (METRICS_TOKEN bearer; closed while unset)
  app/api/internal                    # cron routes: outbox drain + retention, MCP registration reaper
  app/api/security                    # CSP violation report sink
  components/                         # admin, api-keys, app-shell, auth, i18n, navigation, observability, theme, shadcn ui
  lib/                                # auth, guards, audit, SSO, admin, account, email, docs, observability helpers
  lib/api-auth/                       # machine-API auth: API keys, JWT/JWKS, scopes, OAuth clients
  lib/mcp/                            # MCP gateway: protocol, generated tool surface, registration, reaper
  lib/email/                          # outbox-first sender + Resend/Mailgun providers + templates
  lib/docs/                           # in-app docs reader: source, frontmatter, sanitize-first render pipeline
  db/                                 # Kysely instance, numbered migrations, seeds
tests/                                # unit / component / integration / security / e2e / accessibility
```

## Documentation

The canonical, audience-organized documentation set lives in **[docs/](docs/README.md)** — start there. Direct links:

- [docs/product-overview.md](docs/product-overview.md) — what it is, who it's for, value proposition, feature catalog, user flows, roles & permissions
- [docs/architecture.md](docs/architecture.md) — system design, boundaries, auth/authz, data flow, diagrams
- [docs/developer-onboarding.md](docs/developer-onboarding.md) — **start here as a developer**: install, run, test, structure, conventions
- [docs/configuration.md](docs/configuration.md) — every environment variable, config files, secrets, local vs production
- [docs/deployment.md](docs/deployment.md) — deploy model, DB provisioning and migrations, CI/CD, release & post-deploy verification
- [docs/docker.md](docs/docker.md) — container build/run, env, and the migrations init step
- [docs/api.md](docs/api.md) — HTTP API surface, auth + error model, and typed clients/SDKs for the `/api/v1` surface and the committed admin SDK
- [docs/api-security.md](docs/api-security.md) — credentials for third parties, the operator playbook, MCP agents, satellite trust boundaries
- [docs/integration-satellite-apps.md](docs/integration-satellite-apps.md) — standing up a subdomain app that delegates sign-in to the platform
- [docs/testing.md](docs/testing.md) — test strategy, suites, coverage, manual QA checklist
- [docs/observability.md](docs/observability.md) — logs, redaction, request-id correlation, audit, Sentry, metrics, health probes, and the roadmap
- [docs/troubleshooting.md](docs/troubleshooting.md) — incident runbook, and common setup, build, runtime, and deployment failures and fixes
- [CHANGELOG.md](CHANGELOG.md) — what changed in each release, what an operator must do before deploying it, and which fixes the satellite forks must port
- [specs.md](specs.md) — application shell specification (incl. §35 email, §36 account, §37 machine API)

## Security model (summary)

- `proxy.ts` does an early cookie-presence redirect only; the real
  authorization boundary is `requireSecureSession` (server-side).
- Administrator routes require explicit permissions via
  `requireAdminPermission`: an origin check for cookie callers, the
  caller's account and membership status, the permission (intersected with
  a bearer credential's scopes), and an audit row when the permission is
  missing. An origin refusal comes before the caller is known, so it is
  logged and counted rather than audited (F-15). Each mutating handler then
  applies its own rate limit and audits its change, and `withAdminRoute`
  stamps an `x-request-id` on every response.
- The self-service Account app (`/app/account`) is user-level
  (`shell.view`) and **strictly self-scoped**: every read/write targets
  the session user's own row — no id is ever accepted from the client,
  so it is free of IDOR by construction.
- Cross-app SSO uses 60-second single-use JWTs (`jti` nonces consumed
  atomically); tokens never appear in JSON responses. After the nonce is
  burned, a server-only Better Auth plugin establishes the consumer-side
  session so the user lands signed in.
- The `/api/v1` machine surface (disabled by default; enable per
  environment) authenticates via API keys — stored only as SHA-256
  hashes — or Ed25519 JWT bearer tokens. Every credential's scopes are
  intersected with its owner's permissions, so a credential can never
  exceed its owner's authority; every JWT names the key/client it was
  minted from (`cid`), so revoking or rotating that credential retires its
  outstanding tokens on their next request.
- Outbound email is outbox-first: every message is recorded in
  `app_outbox` before any delivery attempt.
- All admin mutations, account changes, and denied attempts are written
  to `app_audit_events`.
