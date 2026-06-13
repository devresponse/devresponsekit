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
  the same `pg` pool. The schema starts from a consolidated initial
  migration (`0001-initial-schema.sql`); later additive changes ship as
  appended numbered files (currently `0003-api-credentials.sql`)
- **Machine API** — a versioned `/api/v1` REST surface authenticated by
  API keys (`drk_…`) or Ed25519 JWT access tokens, with a published
  JWKS document, OAuth client-credentials, and an OpenAPI spec. Ships
  disabled by default (see [docs/api-and-cli-guide.md](docs/api-and-cli-guide.md)
  and [docs/design-api-keys-and-tokens.md](docs/design-api-keys-and-tokens.md))
- **Outbound email** — outbox-first, with pluggable Resend / Mailgun
  delivery and editable templates (see [docs/setup-email.md](docs/setup-email.md))
- **next-intl** — localized routing (`en`, `fr`, `es`, `uk`)
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
pnpm db:app:migrate           # apply all app migrations (0001 initial + 0003 api-credentials)
pnpm db:seed                  # default org, baseline roles, local admin user

pnpm dev                      # http://localhost:3000
```

The seed creates a local admin (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
from `.env`). New self-registered accounts start as `pending_approval`
until an administrator approves them.

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

## Project layout

```
src/
  app/(root)                          # bare "/" → default-locale redirect
  app/[locale]/(public)               # marketing/docs pages
  app/[locale]/(auth)                 # sign-in, sign-up, forgot/reset password, status pages
  app/[locale]/(secure)               # session-gated shell + workspaces
  app/[locale]/(secure)/app/dashboard       # landing workspace
  app/[locale]/(secure)/app/account         # self-service account (user-level)
  app/[locale]/(secure)/app/administrator   # admin console (permission-gated; incl. email)
  app/api/account                     # self-scoped account REST API
  app/api/administrator               # admin REST API (guarded pipeline)
  app/api/v1                          # versioned machine API (API keys, JWT, OAuth clients, JWKS, OpenAPI)
  app/api/sso                         # JWT handoff launch/consume
  app/api/preferences                 # locale preference
  components/                         # app-shell, auth, navigation, shadcn ui
  lib/                                # auth, guards, audit, SSO, admin, account, email helpers
  lib/api-auth/                       # machine-API auth: API keys, JWT/JWKS, scopes, OAuth clients
  lib/email/                          # outbox-first sender + Resend/Mailgun providers + templates
  db/                                 # Kysely instance, numbered migrations, seeds
tests/                                # unit / component / integration / security / e2e / accessibility
```

## Documentation

- [docs/get-started.md](docs/get-started.md) — full local setup walkthrough
- [docs/setup-better-auth.md](docs/setup-better-auth.md) — auth + schema + migrations
- [docs/setup-sso-multi-app.md](docs/setup-sso-multi-app.md) — cross-subdomain SSO across two or more apps
- [docs/setup-email.md](docs/setup-email.md) — email subsystem + provider integration
- [docs/api-and-cli-guide.md](docs/api-and-cli-guide.md) — external API & CLI integration
- [docs/design-api-keys-and-tokens.md](docs/design-api-keys-and-tokens.md) — machine credentials (API keys, JWT, OAuth clients) design
- [docs/admin-manager.md](docs/admin-manager.md) — administrator console spec
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
