# Security Policy

devresponsekit is a security-first authentication and multi-tenant application
shell, so we take vulnerability reports seriously and aim to respond quickly.

## Supported versions

Security fixes land on the latest `1.0.x` release and the `main` branch.

| Version         | Supported          |
| --------------- | ------------------ |
| `1.0.x`         | :white_check_mark: |
| `main` (latest) | :white_check_mark: |
| `< 1.0`         | :x:                |

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
| `GHSA-5xrq-8626-4rwp` | `vitest` | High | The **test runner** (`@vitest/coverage-v8`, dev). Never imported by the production runtime bundle. | 2026-09-18 |

To re-verify reachability: `pnpm why vitest` shows it arrives only via the
test runner (`@vitest/coverage-v8`), and the Next.js standalone trace
(`output: "standalone"`) excludes it from the runtime image. A **new**
high/critical advisory that is *not* in this list fails CI by design, so the
gate still catches anything unreviewed.

### Cleared

- `dompurify` (`GHSA-cmwh-pvxp-8882`, moderate — `ALLOWED_ATTR` pollution via
  `setConfig`) reached the runtime via `mermaid` on the in-app docs renderer.
  Pinned forward to the patched line with `pnpm.overrides` (`dompurify:
  ^3.4.11`); `pnpm why dompurify` confirms a single resolved `3.4.11`, and the
  mermaid render path stays defended by `securityLevel: "strict"` + server-side
  `rehypeSanitize`.

### Moderate / low transitive advisories (below the high gate)

These are reported by `pnpm audit` but **do not block CI** (they are not
high/critical) and are **not** runtime-exploitable. Tracked here so they are
governed, not silent; drop a row when the upstream fix lands.

| GHSA | Package | Severity | Reachability | 
| --- | --- | --- | --- |
| `GHSA-qx2v-qp2m-jg93` | `postcss` | Moderate | Via `next > postcss`. Next-managed; the app authors no untrusted CSS through it. Clears on a Next patch bump. |
| `GHSA-q8mj-m7cp-5q26` | `qs` | Moderate | Via `supertest > superagent > qs` — a **devDependency** (test HTTP), not in the shipped bundle. |
| `GHSA-v6wh-96g9-6wx3` | `vite` | Moderate | Via `vite-tsconfig-paths > vite` — dev-server `launch-editor` (Windows). Build/test tooling only. |
| `GHSA-h67p-54hq-rp68` | `js-yaml` | Moderate | Via `@eslint/eslintrc` (dev) and `gray-matter` (docs frontmatter). The runtime path parses only repo-authored, trusted frontmatter — not attacker-supplied YAML. |
| `GHSA-g7r4-m6w7-qqqr` | `esbuild` | Low | Via `vite-tsconfig-paths > vite > esbuild` — dev-server file read. Build/test tooling only. |
| `GHSA-4x5r-pxfx-6jf8` | `@babel/core` | Low | Via `eslint-config-next > eslint-plugin-react-hooks > @babel/core` — lint tooling (dev). |

## Handling of secrets

Never include real secrets, production credentials, or customer data in a
report. Use redacted examples. See [SECURITY-adjacent configuration guidance in
docs/configuration.md](docs/configuration.md).
