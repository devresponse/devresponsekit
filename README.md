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
  the same `pg` pool. The application schema starts from a consolidated
  `0001-initial-schema.sql` baseline, with later changes shipped as
  append-only numbered migrations (`0002-…` onward). The runner applies any
  not-yet-recorded file in order, each in a transaction, recording it in
  `app_schema_migrations`
- **Machine API** — a versioned `/api/v1` REST surface authenticated by
  API keys (`drk_…`) or Ed25519 JWT access tokens, with a published
  JWKS document, OAuth client-credentials, and an OpenAPI spec. Ships
  disabled by default (see [docs/api.md](docs/api.md) and
  [docs/api-clients.md](docs/api-clients.md))
- **Outbound email** — outbox-first, with pluggable Resend / Mailgun
  delivery and editable templates (see [docs/configuration.md](docs/configuration.md))
- **next-intl** — localized routing (`en`, `fr`, `es`, `uk`, `pt`, `zh`, `hi`, `ja`)
- **Tailwind CSS 4 + shadcn/ui** — design system primitives
- **Vitest / Playwright / axe-core** — unit, component, integration,
  security, e2e, and accessibility test suites (e2e + a11y run in CI
  against a production build)

## Quick start

Prerequisites: Node 22+, pnpm 10, Docker (for local PostgreSQL).

```bash
pnpm install
cp .env.example .env          # then edit secrets

pnpm db:up                    # start PostgreSQL (docker compose)
pnpm db:auth:migrate          # Better Auth (vendor) tables
pnpm db:app:migrate           # apply the app schema (0001 baseline + numbered migrations)
pnpm db:seed                  # default org, baseline roles, local admin user

pnpm dev                      # http://localhost:3000
```

The seed creates a local admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
from `.env`). New self-registered accounts start as `pending_approval`
until an administrator approves them.

For the complete path — prerequisites, configuration reference, production
build, and deploying a fully functional instance — see the canonical docs in
[docs/](docs/README.md) (start with [Configuration](docs/configuration.md) and
[Deployment](docs/deployment.md)).

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
| `pnpm test:all`   | typecheck + lint + format check + coverage + e2e  |
| `pnpm db:codegen` | Regenerate Kysely types from the live schema      |
| `pnpm db:seed:dev` | Optional dev/testing seed: 3 orgs × 7 users + cross-org members, groups & demo activity |
| `pnpm db:reset`   | Dry run: list every table a reset would drop      |
| `pnpm db:reset:reload` | Drop all tables, then re-run migrations + seed (local only) |
| `pnpm db:app:migrate` | Apply the app schema migrations                  |
| `pnpm db:prune`   | Prune expired revocations + aged audit/outbox rows (cron — see [Deployment](docs/deployment.md)) |
| `pnpm outbox:drain` | Retry pending outbox emails (cron)               |
| `pnpm openapi:export` | Write the admin OpenAPI document to `docs/`      |
| `pnpm sdk:admin:generate` | Regenerate the typed admin SDK from the OpenAPI doc |

## Project layout

```
src/
  app/(root)                          # bare "/" → default-locale redirect
  app/[locale]/(public)               # localized marketing landing page (/[locale]) + about, public docs, logged-out
  app/[locale]/(auth)                 # sign-in, sign-up, forgot/reset password, status pages
  app/[locale]/(secure)               # session-gated shell + workspaces
  app/[locale]/(secure)/app/dashboard       # landing workspace
  app/[locale]/(secure)/app/workspace       # nested ApplicationShell example
  app/[locale]/(secure)/app/docs            # in-app Markdown docs viewer (+ /[...slug])
  app/[locale]/(secure)/app/account         # self-service account (profile, preferences, security, api-keys)
  app/[locale]/(secure)/app/administrator   # admin console (users, roles, permissions, orgs, memberships, apps, api-keys, audit, email)
  app/api/account                     # self-scoped account REST API
  app/api/administrator               # admin REST API (guarded pipeline)
  app/api/v1                          # versioned machine API (API keys, JWT, OAuth clients, JWKS, OpenAPI)
  app/api/sso                         # JWT handoff launch/consume
  app/api/navigation                  # server-filtered shell menus
  app/api/docs                        # auth-gated docs image assets
  app/api/preferences                 # locale preference
  components/                         # admin, api-keys, app-shell, auth, i18n, navigation, observability, theme, shadcn ui
  lib/                                # auth, guards, audit, SSO, admin, account, email, docs, observability helpers
  lib/api-auth/                       # machine-API auth: API keys, JWT/JWKS, scopes, OAuth clients
  lib/email/                          # outbox-first sender + Resend/Mailgun providers + templates
  lib/docs/                           # in-app docs reader: source, frontmatter, sanitize-first render pipeline
  db/                                 # Kysely instance, numbered migrations, seeds
tests/                                # unit / component / integration / security / e2e / accessibility
```

## Documentation

The canonical, audience-organized documentation set lives in **[docs/](docs/README.md)** — start there. Direct links:

- [docs/product-overview.md](docs/product-overview.md) — what it is, who it's for, value proposition
- [docs/features.md](docs/features.md) — feature catalog, user flows, roles & permissions
- [docs/architecture.md](docs/architecture.md) — system design, boundaries, auth/authz, data flow, diagrams
- [docs/developer-onboarding.md](docs/developer-onboarding.md) — **start here as a developer**: install, run, test, structure, conventions
- [docs/configuration.md](docs/configuration.md) — every environment variable, config files, secrets, local vs production
- [docs/devops-setup.md](docs/devops-setup.md) — from-scratch infrastructure, provisioning, CI/CD, readiness checklist
- [docs/deployment.md](docs/deployment.md) — build, artifacts, container, release & post-deploy verification
- [docs/docker.md](docs/docker.md) — container build/run, env, and the migrations init step
- [docs/api.md](docs/api.md) — HTTP API surface, auth requirements, request/response, error model
- [docs/api-clients.md](docs/api-clients.md) — typed clients/SDKs for the `/api/v1` surface and the committed admin SDK
- [docs/testing.md](docs/testing.md) — test strategy, suites, coverage, manual QA checklist
- [docs/observability.md](docs/observability.md) — logs, redaction, request-id correlation, audit, Sentry, metrics, health probes, and the roadmap
- [docs/incident-response.md](docs/incident-response.md) — on-call runbook: severity, triage by signal, playbooks, rollback
- [docs/troubleshooting.md](docs/troubleshooting.md) — common setup, build, runtime, and deployment failures and fixes
- [docs/adr/](docs/adr/) — architecture decision records: [ADR-0001 three-tier access control](docs/adr/0001-three-tier-access-control.md), [ADR-0002 organization groups](docs/adr/0002-organization-groups.md)
- [specs.md](specs.md) — application shell specification (incl. §35 email, §36 account, §37 machine API)

## Security model (summary)

- `proxy.ts` does an early cookie-presence redirect only; the real
  authorization boundary is `requireSecureSession` (server-side).
- Administrator routes require explicit permissions via
  `requireAdminPermission`, which layers origin checks, rate limiting,
  request-id correlation, and audit logging.
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
  exceed its owner's authority; revoked JWTs are tracked in
  `app_revoked_tokens`.
- Outbound email is outbox-first: every message is recorded in
  `app_outbox` before any delivery attempt.
- All admin mutations, account changes, and denied attempts are written
  to `app_audit_events`.
