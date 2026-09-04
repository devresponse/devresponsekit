---
title: Developer Onboarding
description: Get the app running, learn the codebase layout, and ship your first change.
group: General
order: 40
---

# Developer Onboarding

_Audience: developers joining the codebase. Get it running, learn the layout, and ship your first change._

---

## 1. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| **Node.js** | 22.x | Pinned via `.nvmrc` (`22`) and `package.json` `engines` (`node >=22`, `pnpm >=10`); CI runs on Node 22. |
| **pnpm** | 10.33.2 | Pinned via `package.json` → `packageManager`. Enable with `corepack enable`. |
| **Docker** | recent | Only used to run PostgreSQL locally. A managed Postgres works too. |
| **PostgreSQL** | 17 | The local Docker image is `pgvector/pgvector:pg17`. |
| **openssl** (or any CSPRNG) | — | For generating secrets. |
| **Git** | — | — |

> Windows note: the repo is developed on Windows and POSIX shells. Commands below are POSIX; PowerShell equivalents are noted where they differ.

## 2. Clone & install

```bash
git clone <repository-url> devresponsekit
cd devresponsekit
corepack enable          # makes the pinned pnpm available
pnpm install             # installs from the frozen lockfile
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
```

Then set, at minimum, `BETTER_AUTH_SECRET` and `SSO_HANDOFF_JWT_SECRET` in `.env` to strong random values (the defaults are placeholders). Generate one with:

```bash
openssl rand -base64 32
```

See [Configuration](./configuration.md) for the full variable list.

## 3. Run locally

```bash
pnpm db:up            # start PostgreSQL in Docker (host port 5444)
pnpm db:provision     # one shot: Better Auth tables + app schema + seed (auth:migrate → app:migrate → seed)
pnpm dev              # start the dev server → http://localhost:3000
```

> All tables are deployed into the **`auth`** schema (configurable via `DB_SCHEMA`; the migrate steps create it automatically). If you inspect the DB with `psql`, the tables won't be in `public` — use `\dt auth.*` or `SET search_path = auth, public;`. See [Configuration → `DB_SCHEMA`](./configuration.md#database-postgresql).

Sign in with the seeded admin (defaults from `.env`):

- **Email:** `admin@devresponse.local`
- **Password:** `ChangeMe-LocalOnly-123!`

Want multi-tenant test data? Load the dev fixture — 3 organizations × 7 users (all pre-approved), plus 3 cross-org members (one account in all three orgs), two groups with members, and back-dated registrations + audit history so the dashboard charts and recent-activity feed are populated:

```bash
pnpm db:seed:dev
```

Every fixture account shares the password **`DevPassword123!`** (override with `DEV_SEED_PASSWORD`):

| Account | Authority |
| --- | --- |
| `superuser@orga.local` (also `orgb`/`orgc`) | Cross-organization superadmin |
| `orgadmin@orga.local` (also `orgb`/`orgc`) | Full `admin.*` catalog, scoped to that one org |
| `user1..5@orga.local` (also `orgb`/`orgc`) | Plain member — `shell.view` only |
| `multi1..3@shared.local` | Member of **all three** orgs (exercises the org switcher) |

Need a clean slate? (Destructive — local only.)

```bash
pnpm db:reset          # DRY RUN: lists what it would drop, changes nothing
pnpm db:reset:reload   # drop everything, re-migrate, and re-seed in one step
```

## 4. Quality gates (run before every PR)

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint .
pnpm format:check   # prettier --check  (use `pnpm format` to auto-fix)
pnpm test:coverage  # vitest with the coverage ratchet
```

The DB-backed suite runs against a real Postgres (set `DATABASE_TEST_URL`):

```bash
pnpm test:db        # vitest run --config vitest.db.config.ts
```

Slower, browser-based suites (also run in CI):

```bash
pnpm build          # next build  (catches config/server errors early)
pnpm test:e2e       # Playwright end-to-end
pnpm test:a11y      # Playwright + axe-core accessibility
```

There's a single convenience target that runs the whole gate:

```bash
pnpm test:all
```

See [Testing](./testing.md) for details on each suite, the sharded runner, and the coverage ratchet.

## 5. Project structure

```
src/
├── app/
│   ├── (root)/                     # locale-independent entry (root layout, error)
│   ├── [locale]/                   # everything localized lives here
│   │   ├── (public)/               # marketing/landing, about, public docs
│   │   ├── (auth)/                 # sign-in, sign-up, verify-email, invite, reset, pending/blocked
│   │   └── (secure)/               # authenticated app — authz boundary is here
│   │       ├── layout.tsx          # loads access context + decideSecureAccess
│   │       └── app/
│   │           ├── account/        # profile, preferences, security, api-keys
│   │           ├── docs/           # in-app docs viewer
│   │           └── administrator/  # the admin console
│   │               └── _components/administrator-navigation.ts  # canonical nav
│   └── api/                        # HTTP API surface
│       ├── auth/[...all]/          # Better Auth catch-all
│       ├── account/ · preferences/ · navigation/
│       ├── sso/                    # launch + consume (handoff)
│       ├── docs/asset/             # docs images
│       └── v1/                     # versioned machine API
├── lib/
│   ├── auth.ts                     # Better Auth config
│   ├── auth-status.ts              # getUserAccessContext, decideSecureAccess
│   ├── admin/                      # guards, access-scope, rate-limit, audit, list-query
│   ├── api-auth/                   # API keys, JWT, scopes, caller resolution
│   ├── account/ · email/ · sso*    # self-service, outbox email, SSO handoff
│   └── env.ts                      # environment loading/validation
├── db/
│   ├── database.ts                 # Kysely instance + pg pool (shared with Better Auth)
│   ├── schema/app-schema.ts        # table types
│   ├── migrations/                 # 0001-initial-schema.sql + runners
│   ├── seeds/                      # seed-local.ts, dev-init.ts
│   └── reset-database.ts           # destructive reset tooling
├── components/                     # shadcn/ui, app shell, data grid, navigation
├── i18n/                           # next-intl request config
└── messages/                       # en.json, fr.json, es.json, uk.json, pt.json, zh.json, hi.json, ja.json

tests/                              # unit, component, integration, security, e2e, accessibility
scripts/test-shards.mjs            # sharded vitest runner
docker/postgres/init/              # Postgres init SQL (extensions)
```

## 6. Main entry points

| Entry point | File |
| --- | --- |
| Edge proxy (redirect + locale) | `src/proxy.ts` |
| Root layout | `src/app/(root)/layout.tsx` |
| Locale layout | `src/app/[locale]/layout.tsx` |
| **Authorization boundary** | `src/app/[locale]/(secure)/layout.tsx` |
| Admin console nav (source of truth) | `src/app/[locale]/(secure)/app/administrator/_components/administrator-navigation.ts` |
| Better Auth config | `src/lib/auth.ts` |
| Access-context resolution | `src/lib/auth-status.ts` |
| Scope primitives | `src/lib/admin/access-scope.server.ts` |
| DB connection | `src/db/database.ts` |
| Next.js config (headers, plugins) | `next.config.mjs` |

## 7. Coding conventions (discovered from the repo)

- **Server-first.** Components are Server Components unless they need interactivity; add `"use client"` only at the boundary. Server-only modules end in `.server.ts` and/or import `server-only`.
- **TypeScript strict.** `pnpm typecheck` must pass with zero errors. Note `noUncheckedIndexedAccess` is on — indexed access yields `T | undefined`.
- **Validate at the edge with Zod.** Route handlers parse request bodies with a Zod schema and return a uniform error envelope on failure.
- **Authorize through the primitives.** Never re-derive tenant scope inline — call `requireAdminPermission` / `resolveOrgScope` / `canAccessOrg`. An admin route that doesn't reference a scope primitive **fails the CI invariant test**.
- **Rate-limit every admin mutation.** Each `POST`/`PATCH`/`DELETE` admin handler calls `enforceRateLimit(...)` right after the permission check (also enforced by an invariant test).
- **Audit every mutation.** Use the `audit*Action` helpers; pass the request so the `x-request-id` is correlated.
- **Internationalize all user-facing text.** Every leaf key must exist in **all 8 locale files (en, fr, es, uk, pt, zh, hi, ja)** — a parity test enforces it. Add keys to `en.json` first, then the rest.
- **Formatting & linting** are enforced by Prettier (with the Tailwind plugin) and ESLint (`eslint-config-next` + `typescript-eslint`). Run `pnpm format` before committing.
- **Commit & PR hygiene** (from project memory): land each logically-complete change as its own PR; PRs auto-merge on green; don't pipe `pnpm build` through `head`/`Select -First` (it truncates and breaks the build log) — redirect to a file instead.

## 8. How to add a feature

A typical admin feature (mirror an existing one such as Roles or Groups):

1. **Schema** (if needed): add a new numbered forward migration (`src/db/migrations/000N-….sql`) — `0001-initial-schema.sql` is **frozen/append-only**, never edit it — and add types to `src/db/schema/app-schema.ts`.
2. **Permissions:** add keys to `ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permissions.ts` (they flow into the `admin.platform`/`superuser` roles automatically). Update the catalog-count test.
3. **API:** add a route handler under `src/app/api/administrator/<feature>/...`. Use `requireAdminPermission`, `resolveOrgScope`/`canAccessOrg`, `enforceRateLimit`, Zod validation, the list-query helper, the error envelope, and an audit call.
4. **UI:** add pages under `src/app/[locale]/(secure)/app/administrator/<feature>/` and a nav entry in `administrator-navigation.ts` with a `requires` permission. Reuse the shared `DataGrid` and form patterns.
5. **i18n:** add strings to all 8 `src/messages/*.json` files (en, fr, es, uk, pt, zh, hi, ja).
6. **Tests:** integration tests for the routes, component tests for client UI, and update the invariant/coverage tests as needed.
7. **Docs:** update the relevant file in `/docs`.

> Browser-observable change? Verify it in a running instance rather than asking a reviewer to check manually.

## 9. Debugging locally

### 9.1 Where to look first

- **Server logs** print to the `pnpm dev` terminal — server component and route-handler errors land here.
- **Liveness/readiness:** `GET /api/health` (process up) and `GET /api/health/ready` (database reachable — `503` means check Postgres before anything else).
- **Request correlation:** every admin and v1 response carries `x-request-id`; grep `app_audit_events` (and Sentry, if enabled) for that id. The audit trail is often the fastest answer to "what did the app actually do?"

### 9.2 Database inspection

- Connect with any Postgres client to `postgresql://devresponse:devresponse@localhost:5444/devresponse_db`.
- **Every table lives in the `auth` schema** (`DB_SCHEMA`), not `public` — use `\dt auth.*` or `SET search_path = auth, public;`. If you find app tables in `public`, a migration/seed ran without the connection-level search path: `DB_SEARCH_PATH_VIA_OPTIONS=0` is set. That flag exists **only** for transaction-pooling endpoints (Neon pooled, PgBouncer) paired with a server-side `ALTER ROLE … SET search_path`; against local/direct Postgres, leave it unset. Recover by unsetting it, dropping the stray `public` tables, and re-running `pnpm db:reset:reload`.
- Inspect `app_audit_events` to see what the app recorded for an action; `app_sso_handoff_nonces` shows one row per SSO launch (`consumed_at` stamps on use — a `null` for an old token means the consume POST never arrived).

### 9.3 Auth & session issues

- Check the `session` / `account` tables and the Better Auth catch-all responses; confirm `BETTER_AUTH_URL` matches the origin you're hitting.
- Remember cookies are **host-scoped, port-agnostic**: two apps on `localhost` (any ports) share the same `better-auth.session_token` cookie slot and will clobber each other; put local test apps on distinct hostnames (see §9.5) when that matters.

### 9.4 Email in dev

With no `EMAIL_PROVIDER`, messages are written to `app_outbox` with status `logged` and visible under **Administrator → Email** — nothing is ever sent.

The bodies shown there are **redacted**: a password-reset, verification or invitation link reads `…/reset-password/[redacted]?…` / `…?token=[redacted]` because the admin outbox must never hand an org admin a live credential (review #21). To follow such a link locally, read the DB-only `delivery_payload` column (never served by the API):

```sql
select delivery_payload->>'text' from app_outbox
 where to_email = 'you@example.com' order by created_at desc limit 1;
```

The e2e suites do the same through `tests/e2e/helpers/outbox-db.ts`.

### 9.5 The local SSO / satellite rig

To debug cross-subdomain SSO (or any multi-app flow) on one machine, use the **suggested subdomain setup** in the [Satellite Apps Integration Guide §6.6](./integration-satellite-apps.md#66-local-development--all-four-apps-on-one-machine-the-suggested-setup): the kit on `http://devresponse.local:3000` and the three satellites on `app1`/`app2`/`app3.devresponse.local` — true subdomains that mirror a live fleet (per-subdomain cookie isolation for the handoff apps, a parent-domain shared session for Option C). One elevated run of **`scripts/setup-local-subdomains.ps1`** maps the four hosts to `127.0.0.1` (idempotent; `-Remove` undoes it); `*.localtest.me` is the no-admin-rights fallback. The guide includes the copy-paste steps (seed, secret, SQL registration, per-app env, `next dev -H …`) and the two dev-only gotchas (host binding for absolute URLs; the CSP `upgrade-insecure-requests` directive silently killing form POSTs on http non-localhost hosts).

## 10. Common mistakes & troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `pnpm install` fails on version | Run `corepack enable` so the pinned pnpm 10.33.2 is used. |
| App can't reach the database | Is `pnpm db:up` running? Is the port `5444` (not 5432)? Check `DATABASE_URL`. |
| Boot error about a secret/JWK | `BETTER_AUTH_SECRET` / `SSO_HANDOFF_JWT_SECRET` unset, or `API_JWT_ENABLED=1` without `API_JWT_PRIVATE_KEY`. |
| `403`/`404` on an admin call you expected to work | Tenant scope — a non-superadmin only sees their own org; out-of-scope resources return **404 by design**. |
| Tables ended up in `public` instead of `auth` | `DB_SEARCH_PATH_VIA_OPTIONS=0` is set locally — a pooler-only setting. Unset it, drop the strays, re-run `pnpm db:reset:reload` (see §9.2). |
| Locale-parity test fails | A new text key is missing from one of the 8 locale files (en, fr, es, uk, pt, zh, hi, ja). Add it everywhere. |
| Coverage gate fails but tests pass | New untested code dropped global coverage below the ratchet — add tests (the local sharded runner does **not** compute coverage; run `pnpm test:coverage`). |
| Flaky/odd test failures with "not a function" | Run the **sharded** runner (`pnpm test`), not a single in-process Vitest run — see [Testing](./testing.md). |

More in [Troubleshooting](./troubleshooting.md).

---

_Next: [API Reference](./api.md) · [Testing](./testing.md)_
