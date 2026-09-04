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
| _none_ | — | — | The allowlist is **empty** as of 2026-09-04: every advisory is fixed by a version bump or an override floor (next section). Add a row here (and the id to `ignoreGhsas`) only for an advisory confined to dev/build/test tooling that has **no** fixed release — never for anything reachable at runtime. | — |

To re-verify reachability for a future entry: `pnpm why <pkg>` must show it
arriving only via dev tooling, and the Next.js standalone trace
(`output: "standalone"`) must exclude it from the runtime image. A **new**
high/critical advisory that is *not* in this list fails CI by design, so the
gate still catches anything unreviewed.

### Override floors (`pnpm.overrides`)

The preferred fix for a vulnerable **transitive** is to raise its floor with
`pnpm.overrides`, not to mute the advisory: a mute's rationale rots the moment
a later CVE moves the patched line, while a floor keeps resolving to the fixed
release. Every override in `package.json` is listed here with the reason it
exists; `tests/unit/dependency-governance.test.ts` fails when an override is
added without a row (and when the lockfile resolves below the patched lines
the 2026-09 sweep established). Floors are **scoped** — to a parent
(`parent>child`) or a major (`pkg@N`) — so a floor can never cross a major
version behind a consumer's back. Review each row when its parent ships a
release that satisfies the floor on its own; the override can then go.

| Override | Floor | Why (advisories closed) | Scope / consumer | Review by |
| --- | --- | --- | --- | --- |
| `jsdom>undici` | `^7.29.0` | `GHSA-4cwx-7wf7-3272` (high). `jsdom` declares `undici@^7.25.0`; the resolved copy sat one patch below the fix. | Dev (jsdom test environment). The direct dev `undici` is pinned `8.10.2` separately. | 2026-12-01 |
| `dompurify` | `^3.4.13` | `GHSA-cmwh-pvxp-8882`, `GHSA-55q2-fjhq-7xh7` (moderate), `GHSA-c2j3-45gr-mqc4` (low). | Runtime (`mermaid` on the in-app docs renderer, also a direct dependency). | 2026-12-01 |
| `postcss` | `^8.5.23` | `GHSA-r28c-9q8g-f849` (high, `sourceMappingURL` path traversal), `GHSA-fxqj-rqcc-2cmp` (moderate); pulls `nanoid@^3.3.18` (`GHSA-28wg-ghj8-5hjv`, `GHSA-2v37-7h3g-55p8`, high). `next` pins `postcss@8.4.31`. | Build (Next.js + Tailwind), validated by `pnpm build`. | 2026-12-01 |
| `@babel/core` | `^7.29.6` | Dependabot alert #4. | Dev (Stryker instrumenter). | 2026-12-01 |
| `esbuild` | `^0.28.1` | Dependabot alert #3; `vite` declares `^0.27.0`. | Dev (vitest), validated by `pnpm test:coverage`. | 2026-12-01 |
| `next>sharp` | `^0.35.0` | `GHSA-f88m-g3jw-g9cj` (high — libvips CVE-2026-33327/33328/35590/35591). `next@16.2.x` declares `sharp@^0.34.5` as an optional dependency. | **Runtime** (`next/image` optimisation in the standalone server). Validated by `pnpm build` + the Trivy image scan. | 2026-12-01 |
| `js-yaml@3` | `^3.15.2` | `GHSA-52cp-r559-cp3m`, `GHSA-5p4m-2wfm-xmqj` (high — merge-key / `!!omap` quadratic CPU), `GHSA-h67p-54hq-rp68` (moderate). `gray-matter` declares `^3.13.1`, which 3.15.x satisfies. | **Runtime** (`gray-matter` docs frontmatter — repo-authored input only). Pinned by `tests/unit/docs-frontmatter.test.ts`. | 2026-12-01 |
| `js-yaml@4` | `^4.3.1` | Same three advisories on the 4.x line. | Dev (`@eslint/eslintrc`, `cosmiconfig` via `kysely-codegen`). | 2026-12-01 |
| `ajv>fast-uri` | `^3.1.6` | `GHSA-v2hh-gcrm-f6hx`, `GHSA-7p8r-x3mc-p8w7`, `GHSA-5jgf-p345-68v8`, `GHSA-f65p-4m7j-42xc`, `GHSA-fph4-wmhf-6fwf`, `GHSA-jqff-g426-hqxp` (high). | Dev/build (`ajv` under Stryker and webpack's `schema-utils`). | 2026-12-01 |
| `browserslist` | `^4.28.7` | `GHSA-c83g-rgw3-j3cx`, `GHSA-73wf-gq98-2v4g` (high). | Build/dev (`@babel/helper-compilation-targets`, `webpack` via `@sentry/webpack-plugin`). | 2026-12-01 |
| `brace-expansion@1` | `^1.1.18` | `GHSA-3jxr-9vmj-r5cp`, `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895` (high, ReDoS). | Dev (`minimatch@3` under eslint). | 2026-12-01 |
| `brace-expansion@5` | `^5.0.9` | Same three advisories on the 5.x line. | Dev (`minimatch@10` under Stryker). | 2026-12-01 |
| `typed-rest-client>qs` | `^6.16.0` | `GHSA-q8mj-m7cp-5q26`, `GHSA-x5fp-wj9c-mxmx`, `GHSA-4mjr-xmp4-gh2g` (moderate). `typed-rest-client` pins `qs@6.15.1` exactly. | Dev (Stryker dashboard client). The direct dev `qs` is `^6.16.0`. | 2026-12-01 |

To confirm a floor took effect: `pnpm why <pkg>` must show a single resolved
version at or above the floor for every parent the row names, and
`pnpm audit --audit-level low` must report nothing for it (it reported **0**
advisories at every level after the 2026-09-04 sweep).

### Cleared

- **2026-09 dependency sweep (review #8, #9, #26, #114).** Both required
  supply-chain gates (`Dependency audit` and `trivy`) had gone red on `main`
  with 28 high advisories across `next@16.2.10` (4 GHSAs incl.
  `GHSA-6gpp-xcg3-4w24` proxy bypass and `GHSA-m99w-x7hq-7vfj` Server-Actions
  DoS), `next>sharp@0.34.5`, `undici`, `postcss`/`nanoid`, `fast-uri`,
  `browserslist`, `brace-expansion`, and `js-yaml`. Fixed by bumping `next` +
  `eslint-config-next` to 16.2.12, the direct dev `undici` to 8.10.2 and
  `postcss` to 8.5.28, and by raising/adding the override floors in the table
  above. No advisory was muted. Validated with `pnpm build`, the full
  `pnpm test:coverage` (ratchet intact), and `pnpm audit --audit-level low`
  (clean).
- `js-yaml` (`GHSA-h67p-54hq-rp68`, previously dismissed as "only v4 patches
  it"): that rationale went stale when js-yaml 3.15.x was published for the 3.x
  line. The `js-yaml@3: ^3.15.2` floor now keeps `gray-matter`'s copy on the
  patched line (it satisfies gray-matter's `^3.13.1`), so the docs viewer is
  unchanged and no longer carries the two newer high advisories either.
- `vitest` (`GHSA-5xrq-8626-4rwp`, high — test runner only) was the sole
  `ignoreGhsas` mute. `vitest@4.1.9` is no longer reported by `pnpm audit`
  (verified with the allowlist emptied on 2026-09-04), so the entry was
  dropped and the allowlist is empty.

- `dompurify` (`GHSA-cmwh-pvxp-8882`, moderate — `ALLOWED_ATTR` pollution via
  `setConfig`) reached the runtime via `mermaid` on the in-app docs renderer.
  Pinned forward to the patched line with `pnpm.overrides` (now `dompurify:
  ^3.4.13`); `pnpm why dompurify` confirms a single resolved version, and the
  mermaid render path stays defended by `securityLevel: "strict"` + server-side
  `rehypeSanitize`.
- `postcss`, `esbuild`, and `@babel/core` (Dependabot alerts #1/#3/#4) were
  patched transitives held back by conservative parent pins — `next` pins
  `postcss@8.4.31`, `vite` declares `esbuild@^0.27.0`, and several tools shared
  `@babel/core@7.29.0`. Pinned forward with `pnpm.overrides` (`postcss`,
  `esbuild`, `@babel/core` — current floors in the table above) to the patched
  lines. Because the first two are forced *past* their parents' declared
  ranges, both were validated end to end: `pnpm build` (Next.js + Tailwind
  exercise postcss) and the full `pnpm test:coverage` (vitest is the only
  vite/esbuild consumer here) both pass. `pnpm why <pkg>` confirms a single
  resolved version each.

### Moderate / low transitive advisories (below the high gate)

Advisories below the high gate are reported by `pnpm audit` but **do not
block CI**. They are still governed, not silent: prefer raising a floor (table
above) and, only when a fix genuinely does not exist, record the accepted risk
here with its reachability rationale so the row can be dropped when the
upstream fix lands.

| GHSA | Package | Severity | Reachability |
| --- | --- | --- | --- |
| _none_ | — | — | `pnpm audit --audit-level low` reported 0 advisories after the 2026-09-04 sweep. |

### Production image scan (Trivy)

`.github/workflows/docker-scan.yml` (required check `trivy`) builds the
Dockerfile and fails on any **fixable** HIGH/CRITICAL in the image; accepted,
non-runtime-reachable findings would go in `.trivyignore` with the same
rationale + review-by discipline as the table above. The runner stage deletes
the base image's bundled `npm`/`npx`/`corepack`/`yarn` CLIs, so npm's vendored
dependency tree (the source of every previous `.trivyignore` mute) is no longer
in the image and `.trivyignore` currently carries **no** entries. The base
image digest is tracked by Dependabot's `docker` ecosystem; a stale digest is
the usual cause of a base-OS finding (see [docs/docker.md](docs/docker.md)).

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
