# Contributing to devresponsekit

Thanks for contributing. This guide covers local setup, the workflow, and the
quality gates a change must pass.

## Prerequisites

- **Node 22** (see `.nvmrc` — `nvm use`), **pnpm 10** (`corepack enable`),
  **Docker** (for local PostgreSQL).

## Local setup

```bash
pnpm install
cp .env.example .env          # then edit secrets

pnpm db:up                    # start PostgreSQL (docker compose)
pnpm db:auth:migrate          # Better Auth (vendor) identity tables
pnpm db:app:migrate           # application schema (0001 + forward migrations)
pnpm db:seed                  # default org, baseline roles, local admin

pnpm dev                      # http://localhost:3000
```

See [docs/developer-onboarding.md](docs/developer-onboarding.md) for the full
tour (project structure, conventions, "how to add a feature") and
[docs/configuration.md](docs/configuration.md) for every environment variable.

## Branch & PR workflow

- **Branch off `main`** with a descriptive name: `feat/…`, `fix/…`, `chore/…`,
  `docs/…`, `ops/…`.
- **One logical change per PR.** Keep PRs focused and reviewable. Don't push
  unrelated follow-ups onto an open PR's branch — open a new one.
- PRs **merge on green** — every required check below must pass.
- Reference the relevant ADR or finding id in the description where it applies.

## Commit messages

Conventional-commit style: `type(scope): summary`
(`feat`, `fix`, `chore`, `docs`, `ops`, `refactor`, `test`). Explain the *why*
in the body, not just the *what*.

## Quality gates (CI)

A PR must pass all of these; run them locally before pushing:

| Check | Command |
| --- | --- |
| Types (strict, `noUncheckedIndexedAccess`) | `pnpm typecheck` |
| Lint (ESLint, flat config) | `pnpm lint` |
| Format (Prettier, LF endings) | `pnpm format:check` (`pnpm format` to fix) |
| Unit/component/integration/security | `pnpm test` |
| Coverage thresholds | `pnpm test:coverage` |
| E2E + accessibility (Playwright + axe) | `pnpm test:e2e` / `pnpm test:a11y` |
| Dependency audit (hard gate) | `pnpm audit --audit-level high` |

CI additionally runs **CodeQL** and **gitleaks** secret scanning. `test:all`
runs typecheck + lint + format check + coverage + e2e locally.

## Testing expectations

- New behavior needs tests. Security- and authorization-sensitive changes
  (tenancy/ADR-0001, RBAC, credentials) **must** include regression tests.
- Run the **full** coverage suite before pushing, not a single file —
  thresholds are ratcheted and only go up (`vitest.config.ts`).

## Database changes

`0001-initial-schema.sql` is **frozen**. Add schema changes as new numbered,
append-only, idempotent forward migrations (`0002-…`, `0003-…`); the runner
applies and ledgers them. See `src/db/migrations/`.

## Security

Do not file security vulnerabilities as public issues — see
[SECURITY.md](SECURITY.md) for private reporting.
