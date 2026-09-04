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
- `postcss`, `esbuild`, and `@babel/core` (Dependabot alerts #1/#3/#4) were
  patched transitives held back by conservative parent pins — `next` pins
  `postcss@8.4.31`, `vite` declares `esbuild@^0.27.0`, and several tools shared
  `@babel/core@7.29.0`. Pinned forward with `pnpm.overrides` (`postcss:
  ^8.5.10`, `esbuild: ^0.28.1`, `@babel/core: ^7.29.6`) to the patched lines.
  Because the first two are forced *past* their parents' declared ranges, both
  were validated end to end: `pnpm build` (Next.js + Tailwind exercise postcss)
  and the full `pnpm test:coverage` (vitest is the only vite/esbuild consumer
  here) both pass. `pnpm why <pkg>` confirms a single resolved version each.

### Moderate / low transitive advisories (below the high gate)

These are reported by `pnpm audit` but **do not block CI** (they are not
high/critical) and are **not** runtime-exploitable. Tracked here so they are
governed, not silent; drop a row when the upstream fix lands.

| GHSA | Package | Severity | Reachability | 
| --- | --- | --- | --- |
| `GHSA-h67p-54hq-rp68` | `js-yaml` | Moderate | **Dismissed — tolerable risk (Dependabot #5).** Via `gray-matter` (docs frontmatter, runtime) and `@eslint/eslintrc` (dev). The only patch is js-yaml **v4**, but `gray-matter` (unmaintained) pins `js-yaml@^3.13.1`, so it cannot be bumped without replacing gray-matter. The runtime path parses only repo-authored, trusted frontmatter — never attacker-supplied YAML. Revisit if gray-matter is ever replaced. |

## Secret scanning

[`.github/workflows/secret-scan.yml`](.github/workflows/secret-scan.yml) runs
**gitleaks** (pinned container image) over every push and pull request as a
**required** status check on `main`; a hit blocks the merge. The configuration
is [`.gitleaks.toml`](.gitleaks.toml) and
[`tests/unit/gitleaks-config.test.ts`](tests/unit/gitleaks-config.test.ts)
pins its policy, so a change that weakens the gate fails the unit suite before
it ever reaches CI.

**Custom detection rules.** The bundled gitleaks rules know nothing about the
credential formats this application issues, so the config adds its own:

| Rule id | Catches | Real shape (source of truth) |
| --- | --- | --- |
| `devresponse-api-key` | `drk_live_` / `drk_test_` API keys | prefix + 32 base62 chars (`src/lib/api-auth/api-key.ts`) |
| `devresponse-oauth-client-secret` | `drkcsec_` OAuth client secrets | prefix + 40 base62 chars (`src/lib/api-auth/oauth-clients.server.ts`) |
| `devresponse-oauth-client-id` | `drkc_` OAuth client ids | prefix + 24 base62 chars |
| `devresponse-seed-default-password` | the documented seed-admin default password anywhere except the files that document it | `.env.example` `SEED_ADMIN_PASSWORD` |
| `devresponse-tooling-hardcoded-password` | a quoted password literal assigned in operator tooling (`help/`, `scripts/`) | tooling reads credentials from the environment |

Only the plaintext of a key or client secret is ever shown (once); the
database holds a SHA-256 hash. A full-length value in the tree is therefore a
leak by construction, and the rules are length-bounded to exactly the real
shapes so **fixtures never collide with them**: keep test and documentation
values shorter than the real random segment (the unit test enforces this
across the tree) and they need no allowlisting at all. A deliberately
full-length placeholder is allowed only under `tests/` or `docs/` **and** only
when it carries an obvious marker (`example`, `placeholder`, `redacted`).

**Allowlist policy.** Allowlists are path-scoped wherever the allowed value is
a credential shape; a global regex allowlist for a credential family would make
the required check structurally blind to that family everywhere (that was the
state before the 2026-09 review, and it is what the unit test now forbids).
The seed-admin default password may appear only in the files that document
the local-only default (`.env.example`, `docs/configuration.md`,
`docs/developer-onboarding.md`, `specs.md`, CI's seed step, and the e2e
sign-in helper) — a copy in application code or tooling fails the gate.
Generated artifacts (`.next/`, `coverage/`, the UAT CSV export) and two
self-describing dummy literals (`ci-only-…-not-for-production`,
`test-secret-test-secret-test-secret`) are the only unscoped entries, and each
must still match something in the tree (dead entries only widen what the
scanner ignores). The one allowance for the app's own formats is fenced three
ways: short throwaway values (at most 12 random characters — e.g. the public
display prefix `drk_live_AbCd1234`) are ignored only under `tests/` and
`docs/`, and only for the bundled `generic-api-key` rule; the
`devresponse-*` rules are never allowlisted. `tests/` is never
blanket-allowlisted.

**Run it locally** exactly as CI does (Docker):

```bash
docker run --rm -v "$(pwd):/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 \
  detect --source=/repo --no-git --config=/repo/.gitleaks.toml --redact
```

If a finding is a false positive, prefer shortening the fixture over adding an
allowlist entry; if an entry is unavoidable, scope it to the narrowest path.

## Handling of secrets

Never include real secrets, production credentials, or customer data in a
report. Use redacted examples. See [SECURITY-adjacent configuration guidance in
docs/configuration.md](docs/configuration.md).
