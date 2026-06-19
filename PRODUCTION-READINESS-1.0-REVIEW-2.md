# devresponsekit — Production 1.0 Readiness, Review #2 (second pass)

**Date:** 2026-06-18 · **Version reviewed:** 0.1.0 · **Branch:** main (`504e237`)
**Method:** 6 parallel read-only dimension reviewers (security/authz, data/DB, API/validation, frontend/i18n/a11y, observability/ops, testing/CI/deps/governance) reading the actual source, reconciled against the first pass (`PRODUCTION-READINESS-1.0.md`, 2026-06-16) and ground-truth `typecheck`/`lint`/`audit`. Supersedes the first pass's status table; the first pass remains the system-of-record for finding rationale.

---

## 1. Verdict

**Readiness score: 8.5 / 10 — up from 7/10. The security/authorization core is now genuinely solid and most of the day-2 ops gaps are closed. What blocks 1.0 is now a finish-line list, not an architecture problem: one new authorization regression, email/DB survivability, a broken docs front door, and the release-governance artifacts.**

Since the first pass the team closed **all of M1** (the tenancy + machine-API + auth-revocation bugs) and **a large share of M2** (structured logging, health probes, a hardened container, graceful shutdown, dependency bumps, and the BUILD-1 security-scanning suite). Ground truth is clean: `typecheck` ✅, `lint` ✅, `pnpm audit --audit-level high` exits 0 behind a triaged allowlist, ~180 test specs.

Three things keep it from a 1.0 tag today:

1. **The deferred AUTHZ-3 group-membership surface is now reachable in the UI** (an org admin can add themselves to a privileged own-org group). This was *consciously deferred* in pass 1 as a delegation-policy decision, not an accidental regression — but it remains an exploitable self-escalation path and needs a decision before 1.0. Plus a couple of smaller shared-identity gaps the AUTHZ-2 work didn't reach.
2. **Email and DB lifecycle are still not survivable** — no outbox retry worker and no provider timeout (password-reset mail is silently dropped on a transient error or mid-insert crash), no proven forward-migration path, a hot-path seq-scan on the SSO nonce table, dead pruning code, and unbounded audit/outbox tables.
3. **The 1.0 "front door" and governance are unfinished** — 11 of 13 README documentation links 404, the load-bearing ADRs live in `docs-backup/`, there's no SECURITY.md / CHANGELOG / CONTRIBUTING, no `engines`/`.nvmrc`, the OpenAPI spec + shipped SDK omit two live endpoints, and the version is still `0.1.0`.

None of these is a remote/unauthenticated exploit. The new authz finding requires an authenticated org admin; the rest are reliability, operability, and release-hygiene. A focused 1–2 week finish sprint gets to a credible, honest 1.0.

---

## 2. Ground-truth signals (2026-06-18)

| Check | Result |
|---|---|
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ clean |
| `pnpm audit --audit-level high` | ✅ exit 0 — 1 critical + 2 high are dev/build-only and allowlisted (`pnpm.auditConfig.ignoreGhsas`); 6 moderate + 2 low remain below the gate |
| Test suite | ~180 specs (vitest unit 74 / component 43 / integration 38 / security 12; Playwright e2e 10 / a11y 3) |

---

## 3. Completed since the first pass (verified this pass)

**M1 — security & authorization (all confirmed RESOLVED with tests):**
AUTH-1 (ban now denies API-key/JWT auth via `resolve-caller.server.ts` + `ban-status.server.ts`), AUTHZ-1 (org-scoped status cascade), AUTHZ-2 (`requiresSuperadminForSharedTarget` on ban/unban/delete/restore + bulk), AUTHZ-3 (`unheldPermissionKeys` intersection on role/app-role/group-role/duplicate paths), MACHINE-1 (bearer org from credential, `active_org` ignored, with real regression tests), AUTH-2 (`revokeSessionsOnPasswordReset`), AUTH-3 (`getSetCookie()`), AUTH-5/OPS-6 (prod kill-switch refusal in `env.ts`), DEPENDENCIES-1/2 (`kysely 0.28.17`, `better-auth 1.6.19`).

**M2 — operations (RESOLVED):** OBSERVABILITY-2 (always-on pino logger w/ `request_id`, audit-mirror), OPS-1 (`/api/health` + `/api/health/ready` `select 1`), OPS-2 (standalone build + multi-stage non-root Dockerfile + `.dockerignore`), OPS-4 (graceful SIGTERM pool drain wired in `instrumentation.ts`).

**M3 (partial):** DOCS-6 (LICENSE + `"license":"MIT"`), BUILD-1 (CodeQL + gitleaks/SARIF + hard audit gate with triaged allowlist). Coverage thresholds set + ratcheted (`vitest.config.ts`).

---

## 4. Pass-2 findings — categorized & ranked

Severity: **BLOCKER** (fix or formally accept before tag) · **HIGH** · **MED** · **LOW**. IDs prefixed by category; carried-over first-pass IDs noted.

### A. Security & authorization correctness

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **A1** | **HIGH** | Group-membership add bypasses the AUTHZ-3 escalation guard. `users/[id]/groups/route.ts:100` and `groups/[id]/members/route.ts:129` (POST) only check org membership, not the permissions the group's roles confer — an org admin with `admin.groups.assign` can add **themselves** to an own-org group whose roles grant permissions they lack (up to a `superuser`-bearing group). Tests currently expect 201 with no escalation case. **Note: this is the AUTHZ-3 "transitive group-membership" surface consciously deferred in pass 1 as a delegation-policy decision — a known-open question, now reachable via the groups UI.** | Decide the policy, then compute conferred perms for the group's roles and apply `unheldPermissionKeys` → 403 for non-superadmins, mirroring `groups/[id]/roles`; add a regression test. |
| **A2** | **MED** | Set-password and revoke-all-sessions are not SUPERADMIN-gated for shared cross-tenant users. `users/[id]/password/route.ts:45` (`mode:"set"`) and `users/[id]/sessions/route.ts:65` mutate an account-global identity an org admin only partially shares — the boundary AUTHZ-2 closed for ban/delete. | Apply `requiresSuperadminForSharedTarget` to these two paths for non-superadmins. |
| **A3** | **MED** | `users/[id]/app-roles` GET is not org-scoped (`route.ts:41`) and returns a shared user's role assignments + **foreign org names** across all tenants — the sibling `/roles` route is scoped. | Add the `scope.kind==="org"` org filter as in `/roles`. |
| **A4** | **LOW** | Impersonation escalation guard resolves the target's permissions in only one org (actor's `active_org`-dependent), and has no test. Not exploitable for the superadmin case (global-superuser marker is detected cross-org), but fragile. | Resolve target perms deterministically; add an impersonation escalation test. |
| **A5** | **LOW** | SSO session plugin checks the raw `banned` flag, ignoring `banExpires` (`auth-sso-session.ts:45`) — diverges from `isBetterAuthUserBanned`. Fails closed. | Reuse `isBetterAuthUserBanned` as the single ban oracle. |
| **A6** (carry: PERF-1) | **MED** | Rate limiter is still an in-process `Map` (`rate-limit.server.ts:58`) — the only guard on the 500-id bulk + 100k-row export paths; budget multiplies per instance, resets on deploy. | Shared (Redis/Postgres) backend, **or** formally document single-instance-only as the supported 1.0 topology. |
| **A7** (carry: CSP) | **MED** | App-wide CSP ships `Content-Security-Policy-Report-Only` with `unsafe-inline`/`unsafe-eval` and **no report sink** (`next.config.mjs:52`) — collects nothing; markdown sanitizer is the sole XSS defense. | Wire a `report-to`/`report-uri` sink now; plan the enforcing nonce-based cutover. |

### B. Data layer & lifecycle

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **B1** (carry: PERF-2) | **HIGH** | No index on `app_sso_handoff_nonces.expires_at`, and `sso.server.ts:99` runs a `DELETE … WHERE expires_at < …` on **every** handoff issuance → seq-scan on a hot auth path. | Add `idx_app_sso_handoff_nonces_expires_at`; consider moving the prune off the request path. |
| **B2** (carry: DB-1) | **HIGH** | No proven forward-migration path — schema is one idempotent `0001` (`CREATE IF NOT EXISTS`), which can never `ALTER` a provisioned DB; no `0002`, no rollback. The multi-file runner works but has never been exercised for an ALTER. | Author + run one real `0002` ALTER end-to-end (the nonce index is a natural first one), freeze `0001`, require numbered forward DDL. |
| **B3** (carry: OBSERVABILITY-3) | **MED** | `app_audit_events` is freely mutable by the app pool (no trigger/RLS/REVOKE) despite being marketed as a compliance record. | `BEFORE UPDATE/DELETE` trigger that raises, or a write-only DB role. |
| **B4** (carry: DB-3) | **MED** | Better-Auth identity DDL is never committed (`run-better-auth-generate.ts` writes a placeholder) and is applied at deploy with no reviewable diff; hand-typed Kysely mirrors can silently drift. | Emit + commit real DDL via `compileMigrations()`; add a drift check; regenerate types from the snapshot. |
| **B5** (carry: DB-2) | **LOW** | Setup scripts run `begin/commit` via `pool.query` (`run-migrations.ts:69`), which may land on different pooled connections — nominal, not guaranteed, atomicity. Setup-tool scope only. | Check out a client and run the transaction on it. |
| **B6** | **LOW** | Pool sets `statement_timeout` but no `idle_in_transaction_session_timeout` (`database.ts`). | Add it as a forward guardrail. |
| **B7** | **LOW** | Window-count + correlated-subselect list pattern (roles/orgs/permissions) and sorting by `permission_count`/`member_count` are O(rows) on large tables. Fine at expected scale; mitigated by `maxPageSize` + `statement_timeout`. | Profile on a seeded large dataset; precompute counts via GROUP-BY-over-page if hot. |

### C. API contract & validation

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **C1** (carry: BUILD-2) | **HIGH** | OpenAPI spec (`docs/openapi-admin.json`) + the committed admin SDK omit the two new endpoints (`/users/{id}/roles`, `/users/{id}/audit`); the drift test only asserts `spec == builder`, not route completeness, so it passes silently. No CI SDK-drift gate exists. | Add both paths to the builder, regenerate spec + SDK; add a CI job (`openapi:export` + `sdk:admin:generate` → fail on `git diff` + `sdk:admin:typecheck`); strengthen the drift test into a completeness test over `administrator/**/route.ts`. |
| **C2** (carry: API-1/2) | **MED** | No shared body-parse helper: ~49 sites inline `request.json()` with no body-size cap (413) or Content-Type check (415). | Introduce `readJsonBody` enforcing both; adopt across routes. |
| **C3** (carry: API-5) | **MED** | Three divergent error envelopes; account/preferences routes return bare `{error}` with **no `x-request-id`** on 4xx/401/403 — uncorrelatable. | Unify behind a helper that always emits `x-request-id`. |
| **C4** | **MED** | Admin **success** responses use bare `NextResponse.json` (78 sites), so `x-request-id` is present only on errors; the `adminJsonResponse` helper is used by one route. 429s from `enforceRateLimit` also mint a fresh request id on most routes. | Route admin successes through `adminJsonResponse`; thread `request`+`guard.requestId` into every `enforceRateLimit` call. |
| **C5** | **LOW** | `users/bulk/route.ts:104` parses + validates the body **before** `requireAdminPermission` — inverts the auth-first pattern (mild pre-auth DoS amplification). | Move the permission guard above the parse. |
| **C6** | **LOW** | Internal per-user audit route returns `ip_address`/`user_agent`/`email` to org admins (the public v1 audit route omits them) — defensible but undocumented. | Record the decision or redact for non-superadmins. |

### D. Observability & operations (survivability)

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **D1** (carry: EMAIL-1/4) | **HIGH** | Email is synchronous-only: no outbox worker, no `attempts`/`next_attempt` column, no retry, and **no provider `fetch` timeout** (`providers.server.ts:39,74`). A crash mid-insert strands `pending` rows; a transient 5xx drops the mail (incl. password-reset); a hung provider blocks the request thread. | Add `attempts`/`next_attempt`, an idempotent `FOR UPDATE SKIP LOCKED` drainer with backoff, and `AbortSignal.timeout` on both providers. |
| **D2** | **HIGH** | Dockerfile has **no `HEALTHCHECK`** — `docker run`/Compose/Swarm report healthy the instant the process starts even with the DB down. Base image is a floating tag. | Add a `HEALTHCHECK` hitting `/api/health/ready`; digest-pin the base image. |
| **D3** (carry: PERF-3/OPS-3) | **MED** | `pruneExpiredRevocations()` is **dead code** (called from nowhere in prod); `app_audit_events` and `app_outbox` have **no retention** and grow unbounded. (SSO nonces are pruned opportunistically.) | Wire revocation prune + audit/outbox retention (opportunistic or a scheduled init job). |
| **D4** (carry: OBSERVABILITY-1) | **MED** | Server-side 5xx catch blocks that swallow-then-audit never call `Sentry.captureException` (only client/boundary code does); they reach the structured log but not Sentry. | Capture in the 5xx catch paths, tagged with `request_id`. |
| **D5** | **MED** | No `unhandledRejection` / `uncaughtException` handler — a stray rejection can crash the worker with no log/Sentry. | Attach handlers in the Node instrumentation branch → log + capture + controlled exit. |

### E. Frontend / a11y / i18n

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **E1** | **HIGH** | Duplicate `banner` landmark — `TopShellBar` and `ShellHeader` both set `role="banner"` and render together (`(secure)/layout.tsx`); axe `landmark-no-duplicate-banner`. | Keep `role="banner"` on `TopShellBar` only. |
| **E2** | **HIGH** | `role="application"` on the shell grid (`shell-grid-container.tsx:57`) disables the SR virtual cursor for all content inside. | Remove it (use `region`/none). |
| **E3** (carry: I18N-1) | **MED** | Stored `timeZone`/`dateFormat`/`numberFormatLocale` preferences are saved + read but never applied — the preferences UI is a no-op shipping to prod. | Feed them into a next-intl formatter config (or hide the controls). |
| **E4** (carry: FRONTEND-5/6/7) | **MED** | `DataGrid` exposes `initialData` but no page uses it — every grid + detail tab client-fetches on mount (and tabs refetch on every switch). | Pass server `initialData` from the list RSCs; seed the first detail tab. |
| **E5** (carry: FRONTEND-3/4, I18N-6) | **MED** | No `loading.tsx`/`not-found.tsx`; permission denial → `notFound()` with no localized 403 distinct from 404. | Add localized loading/not-found + a 403-mask page. |
| **E6** | **LOW** | Dead code: `CompactModeToggle`/`ShellVisibilityToggle`/`NavigationMenuSkeleton`(+3 variants), `embla`/`carousel.tsx`, and the unused `applyServerErrors` helper. | Delete; drop the `embla-carousel-react` dep. |
| **E7** (carry: I18N-3/4) | **LOW** | Hardcoded English aria-labels in app-shell + shared UI; fr/es/uk email templates unseeded. | Localize aria-labels; seed the three locales. |
| **E8** | **LOW** | `aria-rowcount` without per-row `aria-rowindex` misreports position on paginated grids; recharts loads eagerly with the dashboard. | Add `aria-rowindex` offset by page; `next/dynamic` the chart. |

### F. Testing & CI

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **F1** (carry: TESTING-2) | **MED** | `tests/integration/*` replace the DB with a `Proxy` and stub auth guards — they validate control-flow/status codes, not SQL/authz correctness. Real DB behavior is exercised only by the 10 Playwright e2e specs. | Add a tier of genuinely DB-backed integration tests for the security-critical mutation + scoping paths. |
| **F2** (carry: TESTING-3/4) | **MED** | No e2e for SSO launch→consume→replay-rejection or client-credentials mint→call→revoke — the two security-critical machine flows are mock-only. | Add both to the existing DB-backed Playwright harness. |
| **F3** | **MED** | CI runs `vitest run --coverage` serially, **bypassing** the `scripts/test-shards.mjs` single-worker mitigation for the documented SSR-transform race, with no `retry`. | Run the sharded runner in CI or add a retry/justification. |
| **F4** | **MED** | GitHub Actions pinned to mutable tags (`@v4`, `codeql-action/*@v3`, `gitleaks:latest`); no Renovate/Dependabot; 6 moderate advisories form a real backlog. | SHA-pin actions + digest-pin gitleaks; add Renovate/Dependabot; burn down moderates, then lower the audit gate to `moderate`. |
| **F5** | **LOW** | GHSA allowlist (`package.json`) mutes a *critical* with no recorded package/reachability rationale or review date. | Document each GHSA (package + why-unreachable) with an expiry. |
| **F6** | **LOW** | No markdown link checker in CI, so the README rot (G1) regressed undetected. | Add lychee (or similar) to CI. |

### G. Governance, docs & release

| ID | Sev | Finding | Fix |
|---|---|---|---|
| **G1** | **BLOCKER** | README "Documentation" index — 11 of 13 links 404 (point at `docs-backup/`-era names); in-body doc links also dead. First thing a 1.0 evaluator clicks. | Repoint to the real `docs/` filenames; resolve the `docs-backup/` situation. |
| **G2** | **HIGH** | Load-bearing ADRs (`ADR-0001` three-tier access, `ADR-0002` groups) — cited by source + dozens of tests — live only in `docs-backup/adr/`, the deprecated folder. | Promote to `docs/adr/` as authoritative; link from `docs/README.md`. |
| **G3** | **HIGH** | No SECURITY.md, CHANGELOG.md, CONTRIBUTING.md; no `engines.node`/`.nvmrc`; version still `0.1.0` despite shipped public contracts (`/api/v1`, JWKS, OpenAPI, SDK). | Add all four files + `engines`; adopt a semver policy spanning package / `/api/v1` / SDK; cut `1.0.0` on release. |
| **G4** | **LOW** | Dangling `docs/security-test-coverage-plan.md` reference in `vitest.config.ts` (file is in `docs-backup/`). | Move into `docs/` or fix the path. |

---

## 5. Updated release plan toward 1.0

M1 is done; the remaining work re-scopes into **two milestones plus polish**.

### M-A — 1.0 blockers (finish-line sprint; ~1–1.5 eng-weeks)
**Goal: close the new authz regression, make auth-critical email/DB survivable, fix the docs front door, and ship the release artifacts.**
- **A1** group-add escalation guard (+ test) · **A2** shared-target gate on set-password/revoke-sessions · **A3** org-scope `app-roles` GET.
- **D1** outbox worker (`attempts`/`next_attempt`, SKIP LOCKED, backoff) + provider timeouts · **D2** Dockerfile `HEALTHCHECK` + digest-pin base.
- **B1** nonce `expires_at` index · **B2** one proven `0002` ALTER (carry the index) + freeze `0001`.
- **C1** add new routes to OpenAPI + regenerate SDK + add the BUILD-2 drift/typecheck gate.
- **E1/E2** the two a11y landmark fixes.
- **G1** repoint README docs index + markdown link checker (**F6**) · **G2** promote ADRs to `docs/adr/` · **G3** SECURITY.md + CHANGELOG.md + CONTRIBUTING.md + `engines`/`.nvmrc`; bump to `1.0.0` at tag.
**Exit:** no known self-escalation path; password-reset mail retries and survives provider blips; a forward migration is proven; the published spec/SDK match the routes; README + ADRs resolve; the legal/process files exist; version reads 1.0.0.

### M-B — fix at / around 1.0 (~1–1.5 eng-weeks)
**Goal: survivability, scaling honesty, contract consistency, and real security-path tests.**
- **A6** shared rate-limit backend **or** documented single-instance topology · **A7** CSP report sink (+ enforcing-CSP plan).
- **B3** audit-log tamper-evidence · **B4** commit Better-Auth DDL + drift check · **D3** wire revocation prune + audit/outbox retention · **D4** server-side `Sentry.captureException` · **D5** unhandled-rejection handlers.
- **C2** `readJsonBody` (413/415) · **C3/C4** unify error envelope + `x-request-id` on success/429.
- **E3** wire timezone/format preferences · **E4** `DataGrid` `initialData` · **E5** localized loading/not-found/403.
- **F1** DB-backed integration tier · **F2** SSO + client-credentials e2e · **F3** CI shard/retry alignment · **F4** Renovate/Dependabot + SHA-pin actions + burn down moderates → `moderate` audit gate · **F5** document the GHSA allowlist.
- **A4** impersonation guard determinism + test · **A5** unify ban oracle · **B5/B6** setup-tx + `idle_in_transaction_session_timeout`.

### M-C — post-1.0 polish (non-blocking)
**E6** dead-code + `embla` removal · **E7/E8** localized aria-labels, fr/es/uk email templates, chart code-split, `aria-rowindex` · **C5** bulk auth-order · **C6** audit-PII decision · **B7** list-count profiling + keyset pagination for audit · JWKS multi-key rotation · extended PII scrubbing · triage remaining low/info into an owned backlog.

---

## 6. Quick wins (high value / low effort — do first)

1. **A1 group-add escalation guard** — reuse the existing `unheldPermissionKeys` pattern; the highest-severity new bug, small diff.
2. **B1 nonce `expires_at` index** (one line) — removes a seq-scan from the hot SSO path; doubles as the **B2** proof-of-`0002` migration.
3. **D2 Dockerfile `HEALTHCHECK`** + digest-pin base image — a few lines; makes the readiness endpoint actually used.
4. **E1/E2 a11y landmarks** — delete one `role="banner"` and one `role="application"`; axe-detectable, trivial.
5. **G1 README docs index** + **F6** link checker — pure docs edit; fixes every broken onboarding link and prevents regression.
6. **G3 governance files + `engines`/`.nvmrc` + bump to 1.0.0** — table-stakes, mostly authoring.
7. **D1 provider `fetch` timeout** — one `AbortSignal.timeout` per provider; stops a hung provider from blocking request threads (the full outbox worker is larger).
8. **A2/A3** shared-target gate + `app-roles` org-scope — small, mirror existing helpers.
9. **C1 + BUILD-2 gate** — regenerate the spec/SDK and add the drift check so the contract can't silently rot again.
10. **F4** SHA-pin actions + add Renovate/Dependabot — config-only supply-chain hardening.

---

## Appendix — method

Six parallel read-only reviewers read the actual source (not just names), each reconciling the relevant first-pass findings (RESOLVED/PARTIAL/OPEN with evidence) and surfacing new issues with fresh eyes; cross-cutting items (the nonce index, the dead prune, the rate limiter, the GHSA allowlist) were confirmed by more than one reviewer. Ground-truth `typecheck`/`lint`/`audit` were run directly. Finding ids here (A1, B2, …) are stable references; carried-over first-pass ids are noted in parentheses.
