# Security Policy

devresponsekit is a security-first authentication and multi-tenant application
shell, so we take vulnerability reports seriously and aim to respond quickly.

## Supported versions

The project is pre-1.0. Until `1.0.0` is tagged, security fixes are applied to
the latest `main` only.

| Version            | Supported          |
| ------------------ | ------------------ |
| `main` (latest)    | :white_check_mark: |
| older commits/tags | :x:                |

Once `1.0.0` ships, this table will track the supported release line(s).

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for security
vulnerabilities** — that discloses the problem before a fix is available.

Instead, report privately via **GitHub Security Advisories**:

> [Report a vulnerability](https://github.com/devresponse/devresponsekit/security/advisories/new)

(If private reporting is not enabled on the repository, ask a maintainer to
enable *Settings → Security → Private vulnerability reporting*.)

Please include, as far as you can:

- affected version / commit SHA,
- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested remediation.

### What to expect

- **Acknowledgement:** we aim to confirm receipt within **5 business days**.
- **Assessment:** we triage the report, confirm severity, and agree a fix
  timeline with you.
- **Fix & disclosure:** we develop the fix privately, release it, and then
  publish a GitHub Security Advisory crediting the reporter (unless you prefer
  to remain anonymous). We support coordinated disclosure and will agree a
  public-disclosure date with you.

## Scope

Reports that bear directly on the security posture are highest priority, e.g.:

- authentication or session bypass (Better Auth integration, the
  `requireSecureSession` boundary),
- cross-tenant isolation breaks (ADR-0001 — an actor reading or mutating data
  outside their organization),
- privilege escalation (RBAC / the `admin.*` permission model, group/role
  conferral, impersonation),
- machine-credential issues (API keys, JWT/JWKS, OAuth client credentials,
  scope intersection),
- SSO handoff abuse (nonce replay, audience confusion),
- injection, SSRF, XSS (including the Markdown docs viewer), or secret leakage.

Out of scope: findings that require a compromised host or database role,
denial-of-service via unrealistic load, and issues solely in third-party
dependencies (report those upstream — though we welcome a heads-up).

## Dependency advisory allowlist

CI's `audit` job fails the build on any **high or critical** advisory
(`pnpm audit --audit-level high` — a BUILD-1 hard gate). A small, explicit
allowlist in `package.json` (`pnpm.auditConfig.ignoreGhsas`) mutes advisories
that are confined to **dev/build/test tooling** and are not reachable in the
shipped application. Each entry is justified below and carries a **review-by
date** — when an upstream fix lands, drop the entry rather than let it linger.

| GHSA | Package | Severity | Why it is not reachable in production | Review by |
| --- | --- | --- | --- | --- |
| `GHSA-hmw2-7cc7-3qxx` | `form-data` | Critical | Pulled only by `supertest` → `superagent`, a **devDependency** for HTTP assertions in tests. The shipped app makes outbound HTTP via `fetch`/`undici`, never `form-data`. | 2026-09-18 |
| `GHSA-fx2h-pf6j-xcff` | `vite` | High | A build-time transitive of `vitest` / `vite-tsconfig-paths` (and of `better-auth`'s own tooling). The advisory is in Vite's **dev server**, which is never started in production — the app ships a Next.js standalone bundle, not Vite. | 2026-09-18 |
| `GHSA-5xrq-8626-4rwp` | `vitest` | High | The **test runner** (`@vitest/coverage-v8`, dev). Never imported by the production runtime bundle. | 2026-09-18 |

To re-verify reachability: `pnpm why <package>` shows each arrives only via
test/build tooling (or a `better-auth` build-time transitive), and the Next.js
standalone trace (`output: "standalone"`) excludes all three from the runtime
image. A **new** high/critical advisory that is *not* in this list fails CI by
design, so the gate still catches anything unreviewed.

## Handling of secrets

Never include real secrets, production credentials, or customer data in a
report. Use redacted examples. See [SECURITY-adjacent configuration guidance in
docs/configuration.md](docs/configuration.md).
