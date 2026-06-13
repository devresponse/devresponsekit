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
  the same `pg` pool. The whole application schema is a single
  consolidated migration (`0001-initial-schema.sql`)
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
pnpm db:app:migrate           # complete application schema (single initial-schema file)
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
  app/api/sso                         # JWT handoff launch/consume
  app/api/preferences                 # locale preference
  components/                         # app-shell, auth, navigation, shadcn ui
  lib/                                # auth, guards, audit, SSO, admin, account, email helpers
  lib/email/                          # outbox-first sender + Resend/Mailgun providers + templates
  db/                                 # Kysely instance, single migration, seeds
tests/                                # unit / component / integration / security / e2e / accessibility
```

## Documentation

- [docs/get-started.md](docs/get-started.md) — full local setup walkthrough
- [docs/setup-better-auth.md](docs/setup-better-auth.md) — auth + schema + migrations
- [docs/setup-email.md](docs/setup-email.md) — email subsystem + provider integration
- [docs/admin-manager.md](docs/admin-manager.md) — administrator console spec
- [specs.md](specs.md) — application shell specification (incl. §35 email, §36 account)

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
- Outbound email is outbox-first: every message is recorded in
  `app_outbox` before any delivery attempt.
- All admin mutations, account changes, and denied attempts are written
  to `app_audit_events`.
