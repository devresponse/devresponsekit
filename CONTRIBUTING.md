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

CI additionally runs **CodeQL** and **gitleaks** secret scanning (a required
check; rules, allowlist policy, and the local command are in
[SECURITY.md → Secret scanning](SECURITY.md#secret-scanning)). The dependency
audit is its own workflow (`dependency-audit.yml`) so it can also run on a
weekly schedule; a failed scheduled run opens a tracking issue. `test:all`
runs typecheck + lint + format check + coverage + e2e + a11y locally. The
full workflow → required-check map is in
[docs/testing.md → CI workflows](docs/testing.md#9-ci-workflows-and-required-checks).

## Regenerating the help walkthrough screenshots

The in-app help (`/app/help`) is a screenshot tour whose images live in
`help/screenshots/` and are produced by `help/capture.mjs` (Playwright, from
the repo). The script is operator tooling, not servable content: it is
excluded from the Docker build context and holds **no credentials** — pass
them through the environment and it exits non-zero when one is missing:

```bash
CAPTURE_BASE_URL=https://<host> CAPTURE_EMAIL=<admin account> CAPTURE_PASSWORD=<from your secret store>   node help/capture.mjs
```

The account needs the administrator-console permissions for the
`/administrator` screens. `CAPTURE_USER_ID` / `CAPTURE_ROLE_ID` /
`CAPTURE_ORG_ID` optionally pick the representative detail rows. Never inline
a password in the script, a shell alias, or a commit — the secret-scan gate
rejects quoted password literals under `help/` and `scripts/`.

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
