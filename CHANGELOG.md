# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

As of `1.0.0`, [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
applies, and three surfaces are versioned with distinct guarantees:

- **The package / application shell** — semver on tagged releases.
- **The machine API (`/api/v1`)** — the `v1` path is the compatibility
  contract; breaking changes ship under a new version prefix.
- **The admin SDK** (`sdk/admin/`) — regenerated from the OpenAPI spec; tracks
  the admin API surface.

## [1.0.0] - 2026-06-18

The first stable release. Closes the 1.0 blockers and the full second-pass
hardening review (`PRODUCTION-READINESS-1.0.md`,
`PRODUCTION-READINESS-1.0-REVIEW-2.md`). Highlights:

### Added

- CI security scanning: CodeQL (`javascript-typescript`) and gitleaks secret
  scanning with SARIF upload; `pnpm audit` promoted to a hard gate.
- `/api/health` (liveness) and `/api/health/ready` (readiness, `select 1`)
  endpoints; a `HEALTHCHECK` wiring readiness into the container image.
- Always-on structured (pino) server logging carrying `request_id`.
- Graceful SIGTERM/SIGINT shutdown that drains the PostgreSQL pool.
- Forward database-migration convention (`0002+`) atop the frozen `0001`
  baseline; index on `app_sso_handoff_nonces.expires_at`.
- Administrator user-detail Roles and Audit tabs; Organization column on the
  Roles grid.
- System-wide form validation (React Hook Form + Zod): required-field markers,
  error-border highlighting, shared client/server schemas, accessibility.
- Governance docs: `SECURITY.md`, `CONTRIBUTING.md`, this changelog;
  `engines` / `.nvmrc`; `LICENSE` (MIT).
- CSP violation report sink (`/api/security/csp-report`); OpenAPI
  `/users/{id}/roles` + `/audit` endpoints with a regenerated admin SDK and an
  SDK-drift CI gate.
- Email outbox retry worker with exponential backoff (`pnpm outbox:drain`) and
  data-retention pruning (`pnpm db:prune`: expired token revocations + audit /
  outbox windows).
- Committed Better Auth identity-schema snapshot with a drift CI gate.
- DB-backed integration test tier (`pnpm test:db`) plus end-to-end coverage of
  the SSO handoff and client-credentials machine flows.
- Markdown link checker; Dependabot with SHA-pinned GitHub Actions and
  digest-pinned tool images.
- Process-level `unhandledRejection` / `uncaughtException` handlers
  (log + Sentry + controlled exit).

### Fixed

- Authorization (ADR-0001): org-scoped user lifecycle for non-superadmins;
  ban now revokes API keys/JWTs; bearer credentials bound to their minted org;
  role/group conferral can never grant a permission the actor lacks
  (including group-membership self-escalation); superadmin can impersonate org
  admins.
- App-shell double scrollbar at narrow widths; duplicate `banner` and bogus
  `application` ARIA landmarks.
- Email provider HTTP calls now time out instead of hanging the request.
- Bumped `undici` (and `kysely` / `better-auth`) to clear advisories.

### Security

- `app_audit_events` is now append-only — a database trigger blocks
  UPDATE/DELETE outside the explicit retention job, making the audit log
  tamper-evident.
- Server-side 5xx errors are captured to Sentry, tagged with the `request_id`
  that correlates the structured log, the audit row, and the Sentry issue.

### Changed

- Documented single-instance as the supported 1.0 deployment topology (the
  abuse-guard rate limiter is in-process; a shared backend is post-1.0).
- Documented the `pnpm audit` GHSA allowlist — per-advisory package,
  reachability rationale, and review date — in `SECURITY.md`.

> Older history predates this changelog; see the git log and the
> `PRODUCTION-READINESS-1.0*.md` reviews.
