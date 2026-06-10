# devresponsekit

Enterprise Next.js 16 "Holy Grail" application shell with authentication,
multi-organization user management, an administrator console, and
cross-subdomain SSO handoff.

## Stack

- **Next.js 16** (App Router, Server Components, `proxy.ts` middleware)
- **Better Auth** — email/password + Google / Microsoft / GitHub social
  login, session management, admin plugin (ban, impersonation)
- **PostgreSQL + Kysely** — typed SQL for app tables; Better Auth shares
  the same `pg` pool
- **next-intl** — localized routing (`en`, `fr`, `es`, `uk`)
- **Tailwind CSS 4 + shadcn/ui** — design system primitives
- **Vitest / Playwright / axe-core** — unit, component, integration,
  security, e2e, and accessibility test suites

## Quick start

Prerequisites: Node 22+, pnpm 10, Docker (for local PostgreSQL).

```bash
pnpm install
cp .env.example .env          # then edit secrets

pnpm db:up                    # start PostgreSQL (docker compose)
pnpm db:auth:migrate          # Better Auth tables
pnpm db:app:migrate           # application tables
pnpm db:seed                  # default org, roles, local admin user

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
  app/[locale]/(public)     # marketing/docs pages
  app/[locale]/(auth)       # sign-in, sign-up, status pages
  app/[locale]/(secure)     # session-gated shell + workspaces
  app/[locale]/(secure)/app/administrator   # admin console (permission-gated)
  app/api/administrator     # admin REST API (guarded pipeline)
  app/api/sso               # JWT handoff launch/consume
  components/               # app-shell, auth, navigation, shadcn ui
  lib/                      # auth, guards, audit, SSO, admin helpers
  db/                       # Kysely instance, migrations, seeds
tests/                      # unit / component / integration / security / e2e
```

## Documentation

- [docs/get-started.md](docs/get-started.md) — full local setup walkthrough
- [docs/setup-better-auth.md](docs/setup-better-auth.md) — auth configuration
- [docs/admin-manager.md](docs/admin-manager.md) — administrator console spec
- [specs.md](specs.md) — application shell specification

## Security model (summary)

- `proxy.ts` does an early cookie-presence redirect only; the real
  authorization boundary is `requireSecureSession` (server-side).
- Administrator routes require explicit permissions via
  `requireAdminPermission`, which layers origin checks, rate limiting,
  request-id correlation, and audit logging.
- Cross-app SSO uses 60-second single-use JWTs (`jti` nonces consumed
  atomically); tokens never appear in JSON responses.
- All admin mutations and denied attempts are written to
  `app_audit_events`.
