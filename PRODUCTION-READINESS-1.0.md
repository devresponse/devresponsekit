> **⚠️ HISTORICAL SNAPSHOT** — point-in-time production-readiness review. Retained as an audit trail. Findings may have been resolved since; for current state see [CHANGELOG.md](CHANGELOG.md) and [docs/](docs/README.md).

# devresponsekit — Production 1.0 Readiness Review & Release Plan

**Date:** 2026-06-16 · **Reviewed version:** 0.1.0 · **Branch:** main
**Method:** 16-dimension deep code review (auth, authz/tenancy, machine-API, DB, API/validation,
frontend, email, docs-viewer, i18n, observability, testing, build/CI, dependencies, performance,
ops, docs) with adversarial re-verification of every high-severity finding against the source,
plus ground-truth `typecheck` / `lint` / `pnpm audit` / `pnpm outdated`.

---

## 1. Verdict

**Readiness score: 7 / 10 — strong architecture, not yet operationalized; do not tag 1.0 today, but the gap is narrow and well-understood.**

The hard, easy-to-get-wrong parts are done unusually well. `requireSecureSession` (not `proxy.ts`)
is the real server boundary and re-reads status/membership every request; SSO uses 60-second
single-use, atomically-consumed nonces; machine credentials are SHA-256-hashed, JWTs are EdDSA with
the algorithm pinned and `jti` revocation, and every credential's scope is intersected with its
owner's permissions so it can never out-scope its minter; tenant routes return **404-not-403** to
avoid existence leaks; the docs viewer sanitizes *before* transforming and funnels all path safety
through one realpath-checked choke point. TypeScript is full-strict with `noUncheckedIndexedAccess`
and the build does **not** suppress type/lint errors. **Typecheck and lint are both clean.**

What holds it back is three clusters, none of which is an unauthenticated/remote exploit:

1. **A small set of confirmed authorization-correctness bugs around shared multi-org identities and
   credential org-binding** that violate the project's own ADR-0001 tenant invariant.
2. **The project is not yet packaged or instrumented for production operations** — no default error
   logging, no health endpoint, no container artifact, no scheduler for outbox retries / table
   pruning, an in-process-only rate limiter, and no proven forward-migration path.
3. **Missing 1.0 governance/legal artifacts** — no LICENSE, no SECURITY.md/CHANGELOG, and a README
   doc index whose links all 404.

The reassuring part is depth-of-defense: on verification, finding after finding dropped from *high*
to *medium* because a second layer held (banned JWTs self-expire within an hour, the cookie org-pivot
is bounded to the caller's own memberships, audit-log tampering needs an already-compromised DB role).
**There are no confirmed remote/unauthenticated bypasses.** A focused security pass (M1) and an
ops/packaging pass (M2), each a few engineer-weeks, turn this into a credible, honest 1.0.

---

## 2. Ground-truth signals (run 2026-06-16)

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ clean |
| `pnpm audit` | ⚠️ 1 critical · 5 high · 6 moderate · 2 low — see below |
| `pnpm outdated` | ⚠️ `better-auth` 1.6.9→1.6.19, `kysely` needs ≥0.28.17, React/Next a few patches behind, Radix cluster behind |

**Audit triage (important nuance):**
- The single **critical** (`vitest` UI server `<4.1.0`) is **dev-only**, never shipped.
- **`kysely` <0.28.17 — HIGH JSON-path injection** (`GHSA-pv5w-4p9q-p3v2`): real advisory on a prod dep,
  but the vulnerable `.key()`/`.at()` JSON-path API is **not used anywhere** in `src` (verified) — latent,
  not live. Fix = trivial patch bump.
- **`better-auth` 1.6.9 — HIGH device-authorization bypass** (`GHSA-cq3f-vc6p-68fh`): the `deviceAuthorization`
  plugin is **not registered** (`src/lib/auth.ts:142` enables only `admin()`, `ssoSession()`, `nextCookies()`),
  so the vulnerable endpoints are never mounted — **not reachable**. Fix = bump to ≥1.6.11.
- Remaining highs (`form-data`, `vite` fs.deny, `esbuild`) are dev/transitive build-time.

Net: **no live runtime vulnerability from dependencies today**, but the security-critical deps sit
below known-HIGH patches and the audit gate is non-blocking — so the backlog can grow silently.

---

## 3. What's already strong (preserve these)

- **Auth/session:** `proxy.ts` correctly scoped as UX-only; real boundary re-reads status+membership every
  request; `getSafeReturnTo` is a robust open-redirect filter; social providers register only with both
  id+secret; account-linking restricted to verified same-email providers.
- **Authz/tenancy:** one source of truth (`access-scope.server.ts`) used by **all 42 admin routes**;
  universal `requireAdminPermission` coverage; consistent 404-not-403; SUPERADMIN-gated escalation paths;
  account API genuinely self-scoped (no client id accepted).
- **Machine API:** ~190-bit base62 keys, SHA-256-hashed, surfaced once; EdDSA pinned (no alg-confusion/`none`
  downgrade); `ungrantableScopes` closes bearer-mints-broader-bearer; constant-time OAuth secret compare;
  RFC-7807 problem+json with `x-request-id`; DB-backed `jti` revocation.
- **DB/perf:** allow-listed sort/filter (no ORDER-BY injection), single-round-trip `count(*) over()` pagination,
  trigram GIN + composite indexes matched to query shapes, pool fails fast (`connectionTimeoutMillis` +
  `statement_timeout`), `cache()`-memoized access context.
- **Docs viewer:** sanitize-first pipeline, `allowDangerousHtml:false`, realpath containment re-check, Mermaid
  `securityLevel:'strict'`, auth-gated asset route with no-script CSP — a genuinely hard target.
- **i18n:** **all four locales 100% complete** (846 leaf keys, 0 missing/extra, verified), CLDR-correct Ukrainian
  plurals, CI parity guard, security-aware locale validation.
- **Email:** true outbox-first, HTML-value escaping (tested), structural header-injection prevention at the
  provider layer, secrets env-only with boot-time validation.
- **Build/tooling:** full TS strict, no suppressed build errors, broad CI (quality + real-Postgres e2e/a11y),
  Zod env validation that fails loudly and never leaks values, OpenAPI byte-drift guard.

---

## 4. The review at a glance

130 findings across 16 dimensions; **0 critical, 26 high, 45 medium, 46 low, 13 info** as originally
rated. After adversarial verification, the *high* tier compressed to **10 confirmed 1.0 blockers** (the
rest were downgraded to medium/low or shown to be mitigated/stale). Severities below are **post-verification**.

| Tier | Meaning | Count |
|---|---|---|
| **Tier 1 — 1.0 blocker** | Confirmed high; fix or formally accept before tagging 1.0 | 10 |
| **Tier 2 — fix at/around 1.0** | Confirmed medium; real and worth closing | ~24 |
| **Tier 3 — post-1.0 polish** | Low/info; quality, cleanup, hardening | ~60 |

---

## 5. Tier 1 — 1.0 blockers (confirmed high)

### Security & authorization correctness

**[AUTH-1] A Better-Auth ban does not revoke the user's API keys or JWTs.** *(Security · effort M)*
The standalone `/ban` route (`src/app/api/administrator/users/[id]/ban/route.ts:64`) and bulk ban only set
the Better-Auth `banned` flag; they never touch `app_users.status`. But the machine-API path authorizes
purely off `app_users.status` (`resolve-caller.server.ts` → `auth-status.ts:61`), so a banned user's `drk_`
API keys keep authenticating against `/api/v1` **indefinitely** (`expires_at` is nullable/unbounded); JWTs
self-expire within ≤1h. Admins reasonably believe ban locks the user out.
**Fix:** make `/ban` (and bulk) also flip `app_users.status` to suspended (restore on unban) — single source
of truth — or revoke `app_api_keys` + add active `jti`s to `app_revoked_tokens`. Add a regression test that a
banned user's API key stops authenticating.

**[AUTHZ-1] An org admin can globally suspend/block/deactivate a user shared with other tenants.** *(Security · M)*
`performAdminStatusChange` (`src/lib/admin-status.server.ts:59`) updates account-wide `app_users.status` and
cascades to memberships **with no `organization_id` filter**. Because a user can be a member of many orgs and
`app_users` has no org column, an org-A admin can blank-block a member shared with org B — and even *reactivate*
a member org B suspended. Directly breaks ADR-0001 ("every tenant query confined to that org").
**Fix:** for non-SUPERADMINs, scope the cascade with `organization_id = scope.organizationId` and don't mutate
global `app_users.status`; derive effective status from memberships, or restrict global status to single-org
users / SUPERADMIN.

**[AUTHZ-2] Org-admin ban / soft-delete / restore act account-wide on shared users.** *(Security · L)*
Same root cause via a different path: `auth.api.banUser` / `removeUser` are keyed only on the Better-Auth user
id (`auth-admin.server.ts:125`), the membership cascade in `DELETE users/[id]` (`route.ts:245`) has no org
predicate, and the gating permission (`admin.users.ban`/`.delete`) is an ordinary org-admin key — **no
SUPERADMIN gate**. A tenant-scoped admin can ban/soft-delete a shared identity globally.
**Fix:** gate account-global ban/`removeUser` behind SUPERADMIN; for org admins, scope to memberships in the
actor's org (or to users who belong *only* to that org). Cover the shared-user case with tests.

> *Related medium in the same cluster:* **[AUTHZ-3]** role editing does not intersect attached permission keys
> with the actor's own held permissions, allowing an org admin to self-escalate to any non-superuser permission.
> Fix by mirroring the `ungrantableScopes` pattern. Treat as part of the M1 tenancy work.

**[MACHINE-1] A bearer credential's bound organization is discarded; tenant scope is recomputed from the
`active_org` cookie.** *(Security · M)*
`resolve-caller.server.ts:77,95` pass only the principal id into `getUserAccessContext`; the credential's
`organization_id` / JWT `org` claim is produced then dropped, and the effective org is read from the
`active_org` cookie (`active-org.server.ts`) or earliest-membership fallback. A holder of a key minted for org A
can send `Cookie: active_org=<org B>` and have it act in org B. Bounded to the principal's own memberships
(hence high, not critical), but it breaks the per-credential tenant confinement the design advertises and the
token endpoint itself records at mint time.
**Fix:** derive org from the credential on bearer paths, ignore `active_org` entirely there, and reject if the
bound org is no longer an active membership. Add the org-binding regression test (currently the resolver test
mocks this away).

### Database lifecycle

**[DB-1] No proven forward-migration path after the consolidated `0001` schema.** *(Database/Ops · M)*
The entire app schema is one idempotent `create … if not exists` file; `CREATE TABLE IF NOT EXISTS` against an
existing table is a no-op, so editing `0001` can never `ALTER`/backfill a provisioned production DB, and the
ledger skips already-applied files. The runner *is* multi-file capable, so a future `0002 ALTER` would
mechanically work — what's missing is a **documented, exercised, frozen-`0001`** convention and any rollback.
**Fix:** add a real `0002` ALTER, prove it end-to-end, freeze `0001`, require numbered forward-DDL; consider
Kysely Migrator with down-migrations.

**[DB-3] The Better-Auth identity schema is never version-controlled and is auto-`ALTER`ed at deploy.** *(Database/Ops · M)*
`db:auth:generate` writes only a placeholder comment (it never invokes a real generator), no
`better-auth-schema.sql` is committed, and `db:auth:migrate` calls the vendor's `runMigrations()` (apply) rather
than `compileMigrations()` (emit-for-review) — so a `better-auth` version bump silently issues
`ALTER TABLE ADD COLUMN`/`CREATE TABLE` against prod with no reviewable diff, and the documented
"regenerate schema in a PR" policy is impossible to follow.
**Fix:** make `db:auth:generate` emit real DDL via `compileMigrations()` and commit it; treat any `better-auth`
bump as a reviewed migration.

### Operability & supply chain

**[OBSERVABILITY-2] No structured server logging — a default (Sentry-off) deployment has zero error visibility.** *(Ops · M)*
There is no server logger (no pino/winston; `console.*` appears only in `src/db` scripts), Sentry is opt-in and
no-ops without a DSN (the default), and the audit table only records curated `outcome:'error'` rows for
*anticipated* failures while unexpected errors are re-thrown with no app-level log. Self-hosters get no
correlated error stream to ship to an aggregator.
**Fix:** add an always-on JSON server logger (pino) carrying `request_id`; route every caught error through it
regardless of Sentry. *(Companion medium **[OBSERVABILITY-1]**: handled 5xx in admin/SSO/export catch blocks
never call `Sentry.captureException` — add it, tagged with `request_id`.)*

**[BUILD-1] No SAST or secret scanning in CI; the dependency audit is non-blocking.** *(Security/CI · M)*
`ci.yml` has only quality + browser + a `continue-on-error` audit job — no CodeQL, no gitleaks, no SARIF upload —
on a repo that auto-merges on green. For a security-marketed auth product this is a material defense-in-depth gap.
**Fix:** add CodeQL (javascript-typescript) + secret scanning uploading SARIF; clear the high+ backlog, then flip
`pnpm audit` to a hard gate (or an explicit ignore-allowlist so *new* highs fail).

**[DEPENDENCIES-1] Pinned `kysely` 0.28.16 is below the patch for a HIGH advisory.** *(Dependencies · S)*
Latent (the vulnerable API is unused) but the audit gate is non-blocking, so it won't self-correct.
**Fix:** bump `kysely` ≥0.28.17 and `better-auth` ≥1.6.11 (`DEPENDENCIES-2`); regenerate the lockfile.

### Legal / release governance

**[DOCS-6] No LICENSE file and no `package.json` license field.** *(Legal · S — hard release blocker)*
The product markets itself as "yours to own / clone and self-host / open-source," but with no license the legal
default is all-rights-reserved — genuine ambiguity for anyone cloning it.
**Fix:** add a LICENSE file + matching `package.json` `license` field reflecting the intended terms; reference it
from the README. *(Companion: SECURITY.md + CHANGELOG/versioning policy — see M3.)*

---

## 6. Tier 2 — fix at / around 1.0 (confirmed medium)

**Authorization/tenancy**
- **AUTHZ-3** — intersect role-attached permissions with the actor's own (self-escalation). *(also a M1 item)*
- **AUTHZ-5 / AUTHZ-6 / MACHINE-4** — bind revoked-session token to target; deterministic bearer org; per-credential
  rate-limit hardening.

**Operations & scalability**
- **OPS-1** — add `/api/health` liveness + a readiness variant running `select 1` (pool already exported). *(quick win)*
- **OPS-2 / BUILD-5** — `output:'standalone'` + multi-stage non-root Dockerfile + `.dockerignore`; migrations as a
  separate init job.
- **OPS-4** — graceful SIGTERM/SIGINT handler draining the pg pool.
- **PERF-1 / MACHINE-4 / OPS-10** — the abuse limiter is **in-process only** (`rate-limit.server.ts:58` = a module
  `Map`), so budget multiplies per instance and resets on deploy; it's the *only* guard on the 100k-row export and
  500-id bulk paths. Implement a shared (Redis/Postgres) backend, or document single-instance-only.
- **EMAIL-1** — no delivery retry: rows stuck in `pending` (crash between INSERT and provider call) or marked
  `failed` on a transient 5xx are silently dropped (incl. password-reset mail). Add an idempotent outbox worker
  (`FOR UPDATE SKIP LOCKED`, backoff, `attempts` column).
- **PERF-2/3 / OPS-3 / DB-4** — wire `pruneExpiredRevocations` + SSO-nonce prune + audit/outbox retention into a
  scheduler (revocation/audit/outbox tables grow unbounded); add the `app_sso_handoff_nonces.expires_at` index.
- **DB-2** — setup scripts run `begin/commit` on a `Pool` rather than a checked-out client, so the intended
  atomicity of DDL+ledger / multi-insert seed isn't guaranteed (setup-tool scope, not runtime).
- **OBSERVABILITY-3** — `app_audit_events` is mutable (no trigger/RLS/REVOKE) despite being marketed as a durable
  compliance record; add a BEFORE UPDATE/DELETE trigger or a write-only role.

**Security hardening / correctness**
- **AUTH-2** — revoke existing sessions on password reset (`onPasswordReset` hook); today only the self-service
  change-password path revokes.
- **AUTH-3** — SSO consume forwards `Set-Cookie` via `Headers.entries()`, which collapses multiple cookies; use
  `getSetCookie()`.
- **AUTH-5 / OPS-6** — refuse `AUTH_RATE_LIMIT_DISABLED` and the `SKIP_ENV_VALIDATION` placeholder branch when
  `NODE_ENV==='production'`; add a per-account failed-login lockout (only IP throttling exists today).
- **DOCS-1 (CSP) / OBSERVABILITY-4 / BUILD-9** — the app-wide CSP ships **Report-Only with `unsafe-inline`/
  `unsafe-eval` and no report sink**, leaving the markdown sanitizer as the sole XSS defense with no runtime
  backstop. Move to an enforcing nonce-based CSP (or at least wire a report endpoint).

**Quality gates / docs**
- **TESTING-2** — add DB-backed integration coverage for the 0%-covered v1 credential/admin mutation handlers and
  the docs-asset 404 branches.
- **BUILD-2** — CI step that regenerates the admin SDK and fails on `git diff` (+ `sdk:admin:typecheck`).
- **DEPENDENCIES-3** — non-blocking audit on a known backlog (see BUILD-1).
- **DOCS-1 (README) / DOCS-2..5** — the README's entire documentation index links to files now in `docs-backup/`
  and 404s; repoint to the current `docs/` set, resolve the `docs-backup/` situation, add a markdown link checker.
- **I18N-1** — stored `timeZone`/`dateFormat`/`numberFormatLocale` preferences are never applied to any rendered
  output (inert controls); wire a shared formatter factory or hide the controls.

---

## 7. Tier 3 — post-1.0 polish (low / info — selected)

- **Frontend cleanup:** dead zustand shell store + unused toggle/`LanguageMenu`/app-shell barrel (FRONTEND-1/2/8);
  drop unused `recharts`/`embla` (DEPENDENCIES-6/PERF-5); decide RHF-vs-hand-rolled form strategy.
- **UX:** localized `loading.tsx` / `not-found.tsx` and a 403-mask UX (FRONTEND-3/4, I18N-6); replace
  fetch-on-mount sidebar/detail panels with server `initialData` to remove waterfalls (FRONTEND-5/6/7).
- **API hygiene:** shared `readJsonBody` helper enforcing a body-size cap (413) + Content-Type (415) (API-1/2);
  unify the error envelope across account/preferences routes (API-5).
- **Perf:** keyset pagination / capped count for the audit log (PERF-4); document pool sizing + optional verified-TLS
  DB config (PERF-7/OPS-5).
- **i18n/email:** seed fr/es/uk email templates; localize hardcoded `aria-label`s (I18N-3/4).
- **Machine API:** JWKS multi-key overlap for zero-downtime rotation (MACHINE-2); redact reset tokens/PII in the
  outbox (EMAIL-3); extend Sentry scrubbing (OBSERVABILITY-6/7/8).
- **Tooling:** `engines.node` + `.nvmrc` (DEPENDENCIES-5/OPS-8); pin third-party GitHub Actions to SHAs; add
  Renovate/Dependabot.

---

## 8. Cross-cutting themes

1. **Strong security architecture, weak day-2 operations.** Request-time security is excellent; everything that
   makes a service *survivable* (structured logs, health checks, graceful shutdown, a scheduler, a shared
   rate-limit/migration story, a container artifact) is absent or stubbed.
2. **Multi-org shared-identity is an undefined boundary.** ADR-0001 assumes one admin = one org and tenant-confined
   credentials, but user-lifecycle mutations act account-globally (AUTHZ-1/2), role editing has no self-grant
   intersection (AUTHZ-3), and bearer org-binding is discarded (MACHINE-1). Needs an explicit, tested policy.
3. **Defense-in-depth is real and repeatedly saved the score.** Finding after finding downgraded because a second
   layer held — the system fails safer than its individual bugs suggest.
4. **CSP Report-Only is a recurring single point of dependency.** The markdown sanitizer is the sole XSS defense
   with no runtime backstop and no telemetry feeding the planned enforcement cutover.
5. **In-memory state is the horizontal-scaling ceiling.** Security-critical stores (revocation, nonces) are correctly
   DB-backed; the rate limiter is not — so the advertised multi-instance topology isn't safe for the abuse guard.
6. **Process/governance maturity lags code maturity.** Near-1.0 code, but no license, changelog, security policy,
   working doc links, blocking audit, or real version number (still 0.1.0).

---

## 9. Release plan toward 1.0

### M1 — Security & authorization correctness *(1.0 blockers; ~1–2 eng-weeks)*
**Goal:** honor ADR-0001 and make advertised admin actions actually revoke access.
- AUTH-1: ban revokes machine credentials (+ regression test).
- AUTHZ-1/2: org-scope status/ban/soft-delete/restore for non-SUPERADMINs; gate account-global ban/`removeUser`
  behind SUPERADMIN; cover the shared-user case.
- AUTHZ-3: intersect role-attached permissions with the actor's own.
- MACHINE-1: derive bearer org from the credential, ignore `active_org` on bearer paths (+ test).
- AUTH-5/OPS-6: refuse rate-limit + env-validation kill switches in production; add per-account lockout.
- AUTH-2/AUTH-3: revoke sessions on reset; `getSetCookie()` for SSO.
- DEPENDENCIES-1/2 + BUILD-1: bump `kysely`/`better-auth`; add CodeQL + gitleaks (SARIF).
**Exit:** all four tenancy bugs + AUTH-1 + MACHINE-1 fixed-with-tests or formally accepted-with-rationale by the
lead; deps patched; CodeQL + secret scanning in CI; the multi-org shared-identity policy written down and
test-enforced.

### M2 — Operations, observability & scalability *(1.0 blockers; ~2–3 eng-weeks)*
**Goal:** observable, deployable, safe in the documented multi-instance topology, with bounded-growth tables.
- OBSERVABILITY-2/1: always-on structured logger + `Sentry.captureException` in every 5xx catch.
- OPS-1: `/api/health` liveness + readiness `select 1`.
- OPS-2/BUILD-5: `output:'standalone'` + multi-stage non-root Dockerfile + `.dockerignore`; migrations as init job.
- OPS-4: graceful pool-draining SIGTERM handler.
- PERF-1/MACHINE-4: shared rate-limit backend (or document single-instance-only).
- EMAIL-1/EMAIL-4: idempotent outbox worker + provider fetch timeouts.
- PERF-2/3, OPS-3, DB-4: scheduler for revocation/nonce/audit/outbox pruning; nonce `expires_at` index.
- DB-1/2/3: prove a `0002` ALTER, freeze `0001`, fix the pool/transaction bug, emit+commit real Better-Auth DDL.
- OBSERVABILITY-3: make `app_audit_events` tamper-evident.
**Exit:** a no-Sentry deploy emits correlated JSON error logs; `/health` drives an orchestrator probe; app runs as
a hardened non-root container; rate limiting is shared *or* single-instance is the documented supported topology;
the outbox retries and all unbounded tables have a running prune job; a `0002` migration proven end-to-end.

### M3 — Governance, docs & quality gates *(1.0 release-readiness; ~1 eng-week)*
**Goal:** ship the legal/process/docs artifacts a 1.0 is judged by, and make quality gates honest.
- DOCS-6: LICENSE + `package.json` license; bump version to 1.0.0 on release.
- DOCS-8: SECURITY.md (disclosure + supported versions) + CONTRIBUTING.md.
- DOCS-7: CHANGELOG.md + versioning/compat policy for the package, `/api/v1`, and the admin SDK.
- DOCS-1..5: repoint README + `.env.example` doc links; resolve `docs-backup/`; add a markdown link checker to CI.
- BUILD-2: SDK drift check + `sdk:admin:typecheck` in CI.
- DEPENDENCIES-3/4/BUILD-3: Renovate/Dependabot; clear the high+ backlog; flip `pnpm audit` to a hard gate; pin
  actions to SHAs.
- TESTING-2/3/4: DB-backed coverage of the 0%-covered v1 handlers; SSO launch-consume-replay + client-credentials
  mint-call-revoke e2e; ratchet coverage thresholds toward the documented targets.
- CSP (DOCS-1/OBSERVABILITY-4/BUILD-9): enforcing nonce-based CSP, or at least a report sink.
- DEPENDENCIES-5/OPS-8: `engines.node` + `.nvmrc`.
**Exit:** LICENSE/SECURITY.md/CHANGELOG present; `package.json` reads 1.0.0 with a license; all doc links resolve
and are CI-guarded; the audit is a required passing check; SDK drift + SSO/machine-API e2e covered; CSP enforcing
or actively collecting reports.

### M4 — Polish & post-1.0 hardening *(non-blocking)*
Frontend dead-code removal, localized loading/not-found pages, server-rendered detail panels, body-size/Content-Type
hardening, audit-log keyset pagination, fr/es/uk email templates, JWKS multi-key rotation, extended PII scrubbing,
and triage of the remaining low/info findings into an owned backlog.

---

## 10. Quick wins (high value, low effort — do these first)

1. **Add a LICENSE + `package.json` license** (DOCS-6) — legal blocker, minutes.
2. **Bump `kysely` ≥0.28.17 and `better-auth` ≥1.6.11** (DEPENDENCIES-1/2) — clears both HIGH advisories on the
   most security-critical deps.
3. **Make ban set `app_users.status`** (AUTH-1, option a) — smallest change that makes the primary revoke action
   actually revoke API keys/JWTs.
4. **Refuse `AUTH_RATE_LIMIT_DISABLED` + `SKIP_ENV_VALIDATION` placeholder in production** (AUTH-5/OPS-6) — a
   `superRefine` in `env.ts` closing two silent production-weakening footguns.
5. **Add `/api/health` with a `select 1` readiness check** (OPS-1) — small handler; `pgPool` is already exported.
6. **Repoint the README doc index + `.env.example`** (DOCS-1/2) and add a markdown link checker — fixes every broken
   onboarding link.
7. **SIGTERM pool-drain** (OPS-4) and **opportunistic `pruneExpiredRevocations()` inside `revokeJti`** (OPS-3/PERF-3)
   — bounds table growth without a scheduler.
8. **`engines.node` + `.nvmrc`** (DEPENDENCIES-5/OPS-8) and the `idx_app_sso_handoff_nonces_expires_at` index (PERF-2).
9. **Revoke sessions on password reset** (AUTH-2) and **`getSetCookie()` for SSO** (AUTH-3) — two small auth fixes.
10. **CodeQL + gitleaks workflows** (BUILD-1) — config-only, immediately raises the security-scanning posture.

---

## Appendix — method & confidence

16 parallel dimension reviewers read the actual source (not just names); every **high**-severity finding was then
handed to an independent adversarial verifier instructed to *refute* it by re-reading the cited code. That pass
**confirmed 10**, **downgraded ~13 high→medium/low** (a second defensive layer held), and caught **stale/partly-wrong
claims** (e.g. TESTING-2 listed routes as 0%-covered that since gained tests; TESTING-3's "double-burn passes all
tests" was disproven by existing unit tests). Ground-truth `typecheck`/`lint`/`audit`/`outdated` were run directly.
Severities in this document are **post-verification**. Finding ids (AUTH-1, AUTHZ-1, MACHINE-1, …) are stable
references for tracking.
