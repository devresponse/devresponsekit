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

## Install-time supply chain

Two settings narrow the window in which a hijacked publish could reach a
build (source review 2026-09-04, #226):

| Control | Where | What it does |
| --- | --- | --- |
| **Release cooldown** | [`.npmrc`](.npmrc) → `minimum-release-age=1440` | pnpm refuses to **resolve** any version published less than 24 h ago. A hijacked publish is typically detected and yanked well inside that window. |
| **Cooldown for proposals** | [`.github/dependabot.yml`](.github/dependabot.yml) → `cooldown.default-days: 1` | Dependabot does not open npm version-update PRs for releases younger than a day, so it never proposes a bump the `.npmrc` floor would refuse to re-resolve. **Security** updates are exempt from the cooldown, but Dependabot opens them only while the repository's *Dependabot security updates* setting is on, and no file can turn that on. See [Repository security settings](#repository-security-settings). |
| **Package-manager integrity** | [`package.json`](package.json) → `packageManager: pnpm@<version>+sha512.<hash>` | Corepack verifies the pnpm tarball against this hash before running it (`corepack use pnpm@<version>` regenerates the pair). A tampered pnpm release fails the check instead of executing in CI and in the Docker build. `pnpm/action-setup` ignores the `+sha512…` suffix and installs the pinned version. |

The cooldown applies only where pnpm **resolves** a version. Every automated
install in this repo — CI, the Dockerfile, the deploy path — runs
`pnpm install --frozen-lockfile`, which resolves nothing and is therefore
never delayed, including on a Dependabot PR that pins a release published
minutes earlier. It bites only when a human adds or updates a dependency; to
take an urgent security release inside the window, override it for that one
command:

```bash
pnpm install --config.minimum-release-age=0   # document why in the PR
```

## Dependency advisory allowlist

The `Dependency audit` workflow
([`.github/workflows/dependency-audit.yml`](.github/workflows/dependency-audit.yml),
a required status check on `main`) fails the build on any **high or critical**
advisory (`pnpm audit --audit-level high` — a BUILD-1 hard gate) in **either**
lockfile: the app's, and the deploy CLI's in `vercel-cli/`
(`pnpm --dir vercel-cli audit --audit-level high`). The CLI is its own pnpm
package, and it handles `VERCEL_TOKEN` and the production direct database URL;
until F-28 no check audited it, and its advisories piled up as alerts nobody
read. Its override floors are documented in
[`vercel-cli/README.md`](vercel-cli/README.md#dependency-override-floors). The workflow also
runs weekly (Mondays 05:13 UTC) so an idle `main` is re-audited as new
advisories are published. The weekly run also lists GitHub's open
high/critical **Dependabot alerts** (the `Dependabot alerts` job, which is not
a required check). GitHub's advisory database reports advisories the npm audit
endpoint misses, such as `path-to-regexp@6` `GHSA-9wv6-86v2-598j` in
`vercel-cli/`. A failed scheduled run opens — or comments on — a GitHub issue
titled **"Dependency audit failing on main"** that names the failing tree,
and marks **NOT AUDITED** any lockfile whose audit a setup or install failure
skipped (review #227: the gate had been red for weeks with no commit to surface
it). A
Dependabot alert for an advisory you accept below must be **dismissed** in the
Security tab, citing its row, or the weekly job stays red.

A small, explicit allowlist mutes advisories that cannot be reached in what
ships. **Each lockfile has its own**, because `pnpm audit` reads the
`pnpm.auditConfig.ignoreGhsas` of the package it audits and no other:

- the app's lockfile (`pnpm-lock.yaml`): `package.json` →
  `pnpm.auditConfig.ignoreGhsas`;
- the deploy CLI's lockfile (`vercel-cli/pnpm-lock.yaml`):
  `vercel-cli/package.json` → `pnpm.auditConfig.ignoreGhsas`. A GHSA added
  to the root list does **not** mute it in the CLI's audit.

Every entry in either list has a row below that names the lockfile it mutes
and carries a **review-by date**. When an upstream fix lands, drop the entry
rather than let it linger. `tests/unit/dependency-governance.test.ts` fails
when any lockfile's list mutes a GHSA that has no row.

| GHSA | Lockfile | Package | Severity | Why it is not reachable | Review by |
| --- | --- | --- | --- | --- | --- |
| _none_ | — | — | — | Both allowlists are **empty**: the app's since 2026-09-04, and the CLI's has never had an entry. Every advisory is fixed by a version bump or an override floor (next section, and [the CLI's floors](vercel-cli/README.md#dependency-override-floors)). Add a row here, and the id to **that lockfile's** `ignoreGhsas`, only for an advisory that has **no** fixed release and meets the reachability rule below — never for anything reachable at runtime. | — |

To re-verify reachability for a future entry:

- **App lockfile.** `pnpm why <pkg>` must show it arriving only via
  dev/build/test tooling, and the Next.js standalone trace
  (`output: "standalone"`) must exclude it from the runtime image.
- **Deploy CLI lockfile.** The CLI never enters the runtime image, but it runs
  with `VERCEL_TOKEN` and the production direct database URL, so "deploy-time
  only" is not a reason by itself. Try a floor in `vercel-cli/package.json` →
  `pnpm.overrides` first. Mute only when no fixed release exists and
  `pnpm --dir vercel-cli why <pkg>` shows the package arriving only through
  code `drk-deploy` never executes. The `@vercel/node` framework adapters under
  `vercel` are the model case: a Next.js deployment installs them and never
  runs them.

A **new** high/critical advisory that is *not* in these lists fails CI by
design, so the gate still catches anything unreviewed.

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
| `jsdom>undici` | `^8.9.0` | `GHSA-4cwx-7wf7-3272` (high). `jsdom@30` declares `undici@^8.9.0` (its network stack needs undici 8 — forcing 7.x hangs XHR/`fromURL`); the floor is the first patched 8.x release and dedupes with the direct dev pin. | Dev (jsdom test environment). The direct dev `undici` is pinned `8.10.2` separately. | 2026-12-01 |
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
| `lodash-es@4` | `^4.18.0` | `GHSA-r5fr-rjxr-66jc` (high — `_.template` code injection). Arrived with `mermaid@12`, which adds `chevrotain@11.1.2`. **Major-scoped, not parent-scoped, on purpose:** `chevrotain`, `@chevrotain/gast` and `@chevrotain/cst-dts-gen` each declare `"lodash-es": "4.17.23"` — an exact pin at the top of the vulnerable range, so it can never float to the fix — and a `chevrotain>lodash-es` floor would leave the other two parents live. | **Runtime** (`mermaid` → `chevrotain`, which mermaid 12 uses for the `usecase` diagram parser only; `dagre-d3-es` already resolved 4.18.1). Verified in Chromium: the docs diagrams and chevrotain-parsed `usecase` diagrams render identically with 4.17.23 and 4.18.1. | 2026-12-01 |

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

## Repository security settings

Two supply-chain controls are repository **settings**, not files. The
`GITHUB_TOKEN` a workflow runs with cannot read either of them: both endpoints
need administration access, and no workflow `permissions:` key grants that. No
check in this repository can pin them, so they are an **operator checklist**.
Confirm both when you adopt the kit, and again after any change to the
repository's owner or security configuration (review F-28).

| Setting | Expected | Verify (read-only) | Turn on | When it is off |
| --- | --- | --- | --- | --- |
| **Dependabot alerts** | on | `gh api -i repos/devresponse/devresponsekit/vulnerability-alerts` answers `204` (`404` = off) | Settings → Advanced Security → Dependabot alerts → **Enable** | GitHub stops matching the lockfiles against its advisory database. The weekly `Dependabot alerts` job cannot read the alerts API and fails, so this one is detected after all. |
| **Dependabot security updates** | on | `gh api repos/devresponse/devresponsekit/automated-security-fixes` returns `"enabled": true` | Settings → Advanced Security → Dependabot security updates → **Enable**, or `gh api -X PUT repos/devresponse/devresponsekit/automated-security-fixes` | An advisory raises an alert and **no PR**. Nothing proposes the fix: the next weekly run fails and opens the tracking issue, and someone bumps or floors the package by hand. Every comment in [`.github/dependabot.yml`](.github/dependabot.yml) that says a security update "still arrives" assumes this setting is on. |

When F-28 was verified on 2026-09-24, Dependabot alerts were on and
**Dependabot security updates were off**. Turning the setting on is an
operator action; no code change can do it. Security-update PRs go through the
same required checks as any other PR, and Dependabot's `cooldown` and
`open-pull-requests-limit` do not apply to them.

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
