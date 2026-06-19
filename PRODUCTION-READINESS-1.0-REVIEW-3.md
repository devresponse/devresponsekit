# devresponsekit — Production 1.0 Readiness, Review #3 (third pass)

**Date:** 2026-06-19 · **Version reviewed:** 1.0.0 · **Branch:** `main` (`74b2b88`)
**Method:** 14 read-only dimension reviewers (auth, authz/multitenancy, machine API, SSO, email, DB/migrations, observability/ops, frontend/RSC, a11y/i18n, headers/CSP/proxy/rate-limit, build/CI/supply-chain, testing, type-safety, docs/DX), each finding paired with an adversarial verdict, then lead-reconciled. This pass **post-dates** the two prior reviews whose fixes are all merged, plus the 1.0.0 bump and a Dependabot wave. Spot-verified against live source: DB-1, DB-2, MAPI-2, SSO-1, OPS-OBS-1/3, TSQ-1, SUPPLY-1/3, TEST-3, AUTH-PROV-1, and the ADR-0001/0002 scope primitives.

---

## 1. Executive summary

**Verdict: GO for 1.0, with caveats. Score: 8.5 / 10.**

This is a genuinely strong, security-first shell. The third pass found **no P0** — no cross-tenant leak, no data-loss path, no unauthenticated remote exploit, no broken core flow. The ADR-0001 three-tier model and ADR-0002 groups are implemented with unusual discipline: every tenant-data surface I sampled derives its boundary from the single `access-scope.server.ts` source of truth, the privilege-escalation conferral guard is applied uniformly across all conferral paths, and the prior-pass blockers (AUTHZ-1/2/3, MACHINE-1, AUTH-1/2/3, the a11y landmarks, the survivability work) all hold in the current tree.

What keeps it from a clean 9–10 is a finish-line list of **two important correctness bugs reachable by an authenticated admin** (an org DELETE that 500s once any audit row exists; a role DELETE that silently strips group-conferred roles), **observability blind spots on the default no-Sentry deployment** (uncaught 5xx and v1/SSO failures produce zero correlated stdout), and a cluster of **regression-prevention gaps** — the systemic scope/rate-limit invariant tests cover only `/api/administrator/**`, leaving `/api/v1/**` and the admin RSC pages unguarded against future regressions. None blocks a tag; all are worth a focused 1–1.5 week sprint.

The score is unchanged from pass 2's 8.5 deliberately: pass 2 closed its blocker list, but this deeper pass surfaced a comparable-weight set of new correctness and observability items that pass 2 didn't reach. The architecture is 1.0-ready; the hardening is not yet complete.

**Headline themes:**

1. **DELETE-path correctness** — two un-handled foreign-key / in-use-guard gaps (DB-1 P1, DB-2 P2) on admin delete flows that mocked tests never exercise.
2. **Observability is Sentry-coupled** — the always-on pino stream is fed only by `auditEvent`; genuinely uncaught throws and v1/SSO failures reach Sentry-or-nothing, so a default DSN-less deploy is blind to its own 500s (OPS-OBS-1/2/3, P1/P2).
3. **Systemic invariants under-cover** — the route-scope and rate-limit critic tests walk only `/api/administrator`, so `/api/v1` routes and admin RSC pages can regress org-scoping without failing CI (MAPI-1 P1, AUTHZ-RSC-1 P2, TEST-1 P1).
4. **Defense-in-depth & consistency debt** — login-CSRF on SSO consume, banned-principal JWT minting, raw env vars bypassing the schema, three divergent error envelopes, warn-only lint gate.
5. **Accepted-but-tracked scale ceilings** — in-memory rate limiter, Report-Only CSP with no nonce path, OFFSET-paginated exports. All correctly documented for the single-instance 1.0 topology; they are the post-1.0 roadmap.

---

## 2. Prior fixes confirmed

Verification found these genuinely resolved by passes 1 & 2 — concrete confidence the prior work landed:

| Area | Confirmed in current tree |
|---|---|
| **AUTH-3** multi-cookie forwarding | `sso/consume/route.ts:115` uses `getSetCookie()`, not `entries()`. |
| **AUTHZ-1/2/3** tenancy + escalation | `resolveOrgScope`/`canAccessOrg` on every sampled list/`[id]` route; `unheldPermissionKeys` conferral guard on roles/app-roles/groups/duplicate/impersonate; `requiresSuperadminForSharedTarget` on ban/delete/set-password/sessions. All five admin RSC detail pages call `canAccessOrg`/`canAccessUser` → `notFound()`. |
| **MACHINE-1** | `auth/token/route.ts:118` and `resolve-caller` evaluate the gate against the credential's bound org, ignoring the `active_org` cookie. |
| **AUTH-1** ban on machine paths | `resolveCaller` checks `isBetterAuthUserBanned` at use-time (`resolve-caller.server.ts:107`). |
| **D1/D2/D5 survivability** | Outbox worker exists with `FOR UPDATE SKIP LOCKED` + backoff; graceful shutdown + `registerProcessErrorHandlers` wired in `instrumentation.ts`. |
| **CSP report sink** | `/api/security/csp-report` hardened: 64 KiB cap, field truncation, always-204, swallows parse errors. |
| **CSRF origin guard** | `checkTrustedOrigin` applied across admin/v1/account mutating surfaces, before caller resolution, fails closed in prod. |
| **Type-safety core** | `typecheck`/`lint` clean; no `any` in app code; strict tsconfig with `noUncheckedIndexedAccess` holds. |

---

## 3. Findings — ranked

### P0 — release blockers

**None.** No cross-tenant leak, data-loss path, or broken core flow was found. The architecture is sound for a 1.0 tag.

### P1 — important hardening / correctness / observability

| id | title | category | files | evidence / impact | fix | effort |
|---|---|---|---|---|---|---|
| **P1-1 (DB-1)** | Org DELETE raises unhandled FK 500 once any org-tagged audit/role row exists | correctness | `app/api/administrator/organizations/[id]/route.ts:183-199`, `lib/admin/orgs.server.ts:104`, `db/migrations/0001-initial-schema.sql:196` | DELETE guards only `assertOrgNotDefault`+`assertOrgEmpty` (memberships); the `catch` handles only `AdminError` and rethrows everything else. `app_audit_events.organization_id`, `app_roles.organization_id`, `app_provider_organizations` reference the org with **no ON DELETE**. Every org PATCH writes an audit row tagged `organization_id`, so a member-less, previously-edited org → Postgres 23503 → raw 500 instead of the documented 409. `enterprise-apps` DELETE already translates this (`enterprise-apps/[id]/route.ts:209`); mocked tests miss it. SUPERADMIN-only, not data loss. | Catch the FK error → 409 (mirror enterprise-apps), or reject dependent rows in the guard. Add a forward migration setting ON DELETE (audit SET NULL, roles/bindings RESTRICT). | M |
| **P1-2 (OPS-OBS-1)** | Uncaught route 5xx are Sentry-only; invisible on stdout when Sentry disabled (default) | observability/dx | `instrumentation.ts:41-48`, `lib/audit.server.ts:55-71`, `app/api/administrator/users/route.ts:282` | `onRequestError` only tags `request_id` + calls `Sentry.captureRequestError`, never `logServerError`. The always-on pino stream is fed *only* by `auditEvent` error/failure outcomes. Genuinely uncaught throws (`throw err` at users/route.ts:282; unguarded `executeTakeFirstOrThrow`) reach Sentry-or-nothing. On a default no-DSN deploy a Next 500 yields **zero correlated stdout**. | Call `logServerError` from `onRequestError` alongside the Sentry capture, or add a route-error-logging wrapper. | S |
| **P1-3 (MAPI-1 + TEST-1 + AUTHZ-RSC-1)** | Systemic scope/rate-limit invariant tests cover only `/api/administrator`, leaving `/api/v1` routes, admin RSC pages, and the ADR-0002 group UNION unguarded against regression | testing | `tests/unit/admin-route-scope-invariant.test.ts:27,55`, `tests/unit/admin-route-rate-limit-invariant.test.ts:23`, `tests/db/access-scope.db.test.ts`, `tests/unit/auth-status-db.test.ts:50`, `tests/integration/users-bulk-scope.test.ts:129` | The only systemic ADR guards `walk()` **only** `src/app/api/administrator` for files named `route.ts`. Result: (a) a future `/api/v1` route omitting `resolveOrgScope`/`enforceApiRateLimit` ships undetected; (b) a new admin RSC `page.tsx` (or an edit dropping `canAccessOrg`) does not fail CI; (c) the ADR-0002 group UNION (`auth-status.ts:150-167`) is tested via a Proxy whose own comment admits only the left builder's `.execute()` runs — the `app_group_memberships` join never hits Postgres; (d) cross-tenant bulk tests pass on pre-seeded rows regardless of WHERE, so a dropped org filter still passes. All surfaces are correct *today*; the regression net has holes exactly where the invariant exists to catch them. | Extend the invariant walks to `src/app/api/v1/**` and `src/app/[locale]/(secure)/app/administrator/**/page.tsx` (require a scope primitive or EXEMPT marker). Add real `tests/db` coverage for the group UNION and list org filters; adopt the WHERE-recording mock proven in `tests/security/export-org-scope.test.ts`. | L |

> **Note:** SUPPLY-1's adversarial verdict downgraded it from P1 to P2 (mermaid input is trusted repo-authored markdown rendered with `securityLevel:"strict"`; the advisory needs attacker-controlled `setConfig()`, not hostile diagram content). It is filed at **P2-9**.

### P2 — correctness / consistency / quality

| id | title | category | files | evidence / impact | fix | effort |
|---|---|---|---|---|---|---|
| **P2-1 (DB-2)** | Role DELETE in-use guard ignores `app_group_roles`; group-conferred roles silently stripped | correctness | `lib/admin/roles.server.ts:123`, `app/api/administrator/roles/[id]/route.ts:153`, `0001-initial-schema.sql:150` | `assertRoleNotInUse` counts only `app_user_roles`. A role conferred via a group but assigned to no user passes the guard; the DELETE tx removes it, and `app_group_roles.role_id` is `ON DELETE CASCADE`, so the group_role row vanishes with no `role_in_use` 409 — contradicting the route contract. `auth-status.ts:157` resolves group roles into effective permissions, so this is authorization-affecting (perm loss, not escalation). | Extend `assertRoleNotInUse` to also count `app_group_roles` (OR EXISTS). Add a DB test for the group-conferred-but-unassigned case. | S |
| **P2-2 (SSO-1)** | SSO consume allows login CSRF / session fixation — no browser-to-subject binding | security | `app/api/sso/consume/route.ts:58-118`, `lib/sso.server.ts:131` | consume verifies the URL token, burns the jti, creates a session for `payload.sub`, and forwards the cookie to **whatever browser hit the URL** with no binding. An attacker launches for their own account, captures the consume URL from the 307 `Location`, and delivers it to a victim within TTL (≤60s) → victim signed into the attacker's session. Requires timed social delivery + reachable consumer, hence P2. | Set a short-lived HttpOnly SameSite=Lax launch-state cookie matched against a token claim at consume; else 401 + audit. | M |
| **P2-3 (OPS-OBS-2)** | v1 5xx capture to Sentry but never audit; no structured log without Sentry | observability/dx | `app/api/v1/users/route.ts:163-190`, `lib/api-auth/problem.ts:66` | `problemResponse` captures to Sentry on ≥500 but never logs. v1 502 branches pass `cause` but write no audit event (unlike the admin twin which audits → logs). The follow-on `executeTakeFirstOrThrow` insert at users/route.ts:180 is outside any try/catch. | Have `problemResponse` call `logServerError` on ≥500; add `api.*.failed` audit events on the v1 502 branches; wrap the unguarded insert. | M |
| **P2-4 (OPS-OBS-3)** | SSO consume lacks request-id correlation and 500s silently on misconfig | observability/dx | `app/api/sso/consume/route.ts:43-55,119-127` | Never calls `getOrCreateRequestId`, never sets `x-request-id`, uses bespoke `{error}` bodies. The two `audience_not_configured` branches return raw 500 with no cause/audit/log — `onRequestError` doesn't fire because they `return` rather than `throw`. A misconfigured consumer boots clean and fails silently on first handoff. | Mint + echo a request id; convert misconfig 500s to `logServerError` + `captureServerError`; align the body to the RFC7807/admin envelope. | S |
| **P2-5 (OPS-OBS-4 + CSP-2)** | CSP-report sink unauthenticated and un-rate-limited — log-flood / cost vector | security | `app/api/security/csp-report/route.ts:83-126` | Unauthenticated POST emits one `logger.warn` per violation. The 64 KiB body cap doesn't bound the number of batched `reports+json` entries (~1.8k per 64 KiB), and there is no `enforceRateLimit`/sampling. A hostile/buggy client floods the warn stream. Not a breach. | Cap violations processed per request; aggregate to one line per directive per window; apply a coarse IP/global token-bucket floor like the token endpoint. | S |
| **P2-6 (OUTBOX-1)** | Inline send non-atomic, no idempotency key — crash after provider success before `sent` UPDATE duplicates the email | correctness | `lib/email/send.server.ts:136-181`, `lib/email/outbox-worker.server.ts:50-69`, `lib/email/providers.server.ts:55-92` | INSERT `pending` → `deliver()` → separate UPDATE `sent`. A crash after `deliver()` succeeds strands the row `pending`; the drainer re-sends. No `Idempotency-Key` reaches Resend/Mailgun (both support one) → duplicate password-reset mail. | Pass a stable idempotency key derived from the outbox row id to both providers, and/or document the at-least-once contract. | M |
| **P2-7 (DB-3)** | Migration/seed transactions rely on pool MRU connection reuse, not an explicit client checkout | correctness | `db/migrations/run-migrations.ts:72`, `db/seeds/seed-local.ts:31`, `db/reset-database.ts:132` | `begin`/sql/ledger-insert/`commit` are four separate `pool.query()` calls on a `max:10` Pool, not a `pool.connect()` client. Atomicity holds only because sequential awaits reuse the MRU idle connection; a mid-file failure under any concurrency/pool change could leave a half-applied, un-ledgered migration. | Check out one `pool.connect()` client for the begin/statements/commit unit, release in `finally`. | S |
| **P2-8 (MAPI-2)** | Token endpoint mints JWTs for banned principals | security | `app/api/v1/auth/token/route.ts:118` | Issuance gates only on `decideSecureAccess` (status-based), which never reads the Better Auth `banned` flag. A banned-but-active principal mints a JWT. Impact bounded: every *use* flows through `resolveCaller` which rejects banned principals, so the token is dead on arrival — a consistency gap, not usable-credential issuance. | Add an `isBetterAuthUserBanned` check before minting. | S |
| **P2-9 (SUPPLY-1)** | Audit gate is high-only; a moderate dompurify advisory (via mermaid) passes ungated | supply-chain | `.github/workflows/ci.yml:225`, `package.json:85`, `docs/.../doc-article.tsx:53` | `pnpm audit --audit-level high` lets GHSA-cmwh-pvxp-8882 (moderate, dompurify<3.4.11 via mermaid) through. mermaid is a prod dep, client-imported in the docs viewer. Not attacker-reachable in practice: docs are trusted repo-authored markdown rendered with `securityLevel:"strict"`, and the advisory needs attacker-controlled `setConfig()`. Hygiene, not a hole. | Bump mermaid to clear dompurify ≥3.4.11; then lower the gate to `moderate` with a dated, justified allowlist for dev-only moderates. | S |
| **P2-10 (SUPPLY-2)** | SDK-drift CI runs `npx --yes openapi-generator-cli` unpinned and absent from the lockfile | supply-chain | `package.json:29`, `.github/workflows/ci.yml:256`, `openapitools.json:5` | A merge-blocking gate depends on an unpinned, unaudited package fetched from the network at CI time; only the JVM generator is pinned. | Add the wrapper as an exact-pinned devDependency; invoke via `pnpm exec`. | S |
| **P2-11 (SUPPLY-3 + TSQ-2)** | ESLint safety rules are warn-only with no `--max-warnings 0` | dx | `eslint.config.mjs:31-37`, `package.json:12`, `.github/workflows/ci.yml:62` | `no-explicit-any`, `no-unused-vars`, `consistent-type-imports` are all `warn`; `lint` is bare `eslint .`; CI runs `pnpm lint`, which exits 0 on warnings. The tree is warning-clean today, so a new `any` would warn but pass CI and accumulate. *(SUPPLY-3 and TSQ-2 are the same root — merged.)* | Promote the three rules to `error`, or run `eslint --max-warnings 0`. Low-risk since already clean. | S |
| **P2-12 (TSQ-1)** | Runtime/security env vars bypass `env.ts`; pool config can become NaN | correctness | `db/database.ts:20-33`, `lib/client-ip.ts:17`, `lib/admin/enterprise-apps.server.ts:39` | PG pool sizing, `TRUSTED_PROXY_COUNT`, and the SSO origin allow-list are read raw via `process.env`, never validated by `serverEnvSchema`. `database.ts` uses `Number(x ?? N)` — `??` misses NaN, so a non-numeric `PGPOOL_MAX` silently yields `max: NaN` (forwarded to `pg` with no guard). `client-ip.ts:18` correctly guards with `Number.isInteger`. | Validate these in `serverEnvSchema` + read via `getServerEnv`; replace `Number(x ?? N)` with a NaN-safe coerce. | M |
| **P2-13 (FE-ERRBOUND-1)** | Localized error boundary covers only the secure content subtree | dx | `src/app/[locale]/(secure)/app/error.tsx`, `src/app/global-error.tsx` | Only `(secure)/app/error.tsx` is localized. The `(secure)/layout.tsx` fetches data *above* it, and `(auth)`/`(public)` have no `error.tsx`, so those throws hit the English-only `global-error.tsx` (`lang="en"` hardcoded). | Add `error.tsx` to `(auth)`, `(public)`, and the `(secure)` group level reusing `RouteError`. | S |
| **P2-14 (FE-LOADING-1 + I18N-1)** | No `loading.tsx` / `not-found.tsx` / localized 403 anywhere | dx/i18n | `src/app/[locale]/layout.tsx:57` | Zero `loading.tsx`/`not-found.tsx`/`Suspense` repo-wide; `notFound()` (~50 call sites, plus the ADR-0001 404-not-403 pattern) renders the unstyled English built-in 404 outside the shell. No localized 403. | Add localized in-shell `not-found.tsx` (+ optional `forbidden.tsx`) and `loading.tsx` for heavy admin grids. | M |
| **P2-15 (A11Y-1)** | Live shell landmarks have hardcoded English aria-labels on every page | accessibility | `components/app-shell/top-shell-bar.tsx:25`, `(secure)/_components/secure-sidebar.tsx:97`, `components/ui/sidebar.tsx:338`, plus public/workspace/docs/admin/account layouts | TopShellBar "Application brand bar", nav "Primary", main "DevResponse Enterprise Application", "Toggle Sidebar" etc. are fixed English in fr/es/uk; no message keys exist. | Add localized keys + thread through next-intl; derive the main label from a translated app-name; add a non-English axe case. | M |
| **P2-16 (PERF-1 + DB-6)** | CSV export uses growing OFFSET pagination up to 100k rows — O(rows²) scan | performance | `app/api/administrator/export/[resource]/route.ts:174-183,384-400` | Each page is `.limit().offset()` with `offset += rows.length`, up to MAX_EXPORT_ROWS=100k / PAGE_SIZE=1000. OFFSET re-scans all preceding rows; deep pages get progressively slower against `statement_timeout`. Rate-limited + capped, so it can't wedge the DB. | Switch the export inner loop to keyset (seek) pagination on `(sort_col, id)`. List grids may stay on OFFSET (capped at 200). | M |
| **P2-17 (PERF-2)** | Sorting admin grids by computed/aggregate columns forces full materialization before LIMIT | performance | `app/api/administrator/roles/route.ts:48,123`, `app/api/administrator/organizations/route.ts:40,83`, `lib/admin/list-query.server.ts:177` | `permission_count`/`member_count` are correlated scalar sub-selects exposed as sort fields; `orderBy(sql.ref(alias))` makes Postgres evaluate the count for every matching row, sort the whole set, then LIMIT. The `count(*) over()` window already materializes the full set once; the count-then-sort compounds it. Superadmin-only deep grids. | Precompute counts via a `LEFT JOIN (… GROUP BY)` so the planner hash-aggregates once, or document count-sorts as best-effort. Confirm with EXPLAIN. | M |

### P3 — polish / nice-to-have

| id | title | category | files | one-line | fix | effort |
|---|---|---|---|---|---|---|
| **P3-1 (AUTH-IMP-1)** | Impersonate route Set-Cookie forwarding is dead code | correctness | `app/api/administrator/users/[id]/impersonate/route.ts:113-120,170-177` | `impersonateBetterAuthUser` omits `returnHeaders:true`, so `result.headers` is never a `Headers` — the forwarding loop is dead (cookie really delivered by `nextCookies`); still uses the `entries()` pattern AUTH-3 replaced. | Delete the dead loops, or pass `returnHeaders:true` + `getSetCookie()`. | M |
| **P3-2 (AUTH-PROV-1)** | Non-idempotent first-login provisioning can fail sign-in with 500 | correctness | `lib/auth.ts:115-156`, `lib/user-provisioning.server.ts:133-145` | SELECT-then-INSERT on `app_users` with `executeTakeFirstOrThrow`, no `onConflict`, while `better_auth_user_id` is UNIQUE; the `session.create.after` hook re-raises (unlike the sibling audit hook). Two concurrent first logins → unique violation → 500. Narrow race. | `onConflict(...).doUpdateSet(...)` on `better_auth_user_id`; add a concurrency test. | S |
| **P3-3 (AUTHZ-GROUPRES-1)** | Effective-permission resolution doesn't re-verify a conferred role belongs to the active org | security (defense-in-depth) | `lib/auth-status.ts:150-166`, `lib/admin/grantable-permissions.server.ts:31-40` | Both the direct and group branches filter on `*.organization_id = orgId` but never require the *role's* org to match. Route layer enforces same-org bundling, so no reachable exploit today; but the resolution path is the enforcement-of-record and would confer a foreign/global role's perms if such a row ever existed. | Add `r.organization_id = orgId OR r.organization_id IS NULL` to both branches + `permissionKeysForGroup`. | M |
| **P3-4 (SSO-2)** | SSO plugin ignores `banExpires` vs the canonical ban oracle | correctness | `lib/auth-sso-session.ts:45-48` | Reads only raw `banned`; an expired-temp-ban user is wrongly rejected at consume. Fails closed. | Reuse `isBetterAuthUserBanned`; add an expired-ban test. | S |
| **P3-5 (SSO-3)** | Handoff HMAC secret allows 16 chars; not enforced distinct from `BETTER_AUTH_SECRET` | security | `lib/env.ts:45,134-169` | `min(16)`=128 bits < RFC7518 256-bit HS256 guidance; `superRefine` doesn't enforce the distinctness the docs require. | Require 32 chars; `superRefine` fail when equal to `BETTER_AUTH_SECRET` / API JWT key. | S |
| **P3-6 (SSO-4 / DX env)** | Missing `SSO_HANDOFF_APPLICATION_ID` fails late at consume, not at boot | dx | `lib/env.ts:48`, `app/api/sso/consume/route.ts:52` | Optional at boot yet consume 500s without it; a misconfigured consumer boots clean and fails on first handoff. | Gate behind an opt-in flag; `superRefine` requiring audience vars when set. | S |
| **P3-7 (MAPI-3)** | JWKS publishes a single key so rotation breaks all outstanding tokens | architecture | `lib/api-auth/jwt.server.ts:159-162`, `env.ts:100` | `getJwks` returns one key; `verifyAccessToken` uses only it with no `kid` fallback. Rotation invalidates every live token; bounded by ≤1h TTL; no overlap procedure documented. | Publish an optional previous key during overlap, or document a one-TTL drain. | M |
| **P3-8 (OUTBOX-2)** | fr/es/uk email templates unseeded; two drainer edges | docs/correctness | `lib/email/templates.ts`, `outbox-worker.server.ts:52`, `send.server.ts:194` | Only `en` seeded (intentional fallback). Edge A: drainer claim never filters on provider, so a mid-retry `EMAIL_PROVIDER` switch re-sends with the original `from_email`. Edge B: raw provider error bodies persist to `app_outbox.error` (admin-visible, org-scoped). | Seed fr/es/uk; filter drainer claims by active provider; store status+short reason instead of the raw body. | M |
| **P3-9 (RL-2 + PERF-5)** | `enforceRateLimit` 429s omit `request`/`requestId` on ~every admin route, losing `x-request-id` correlation | dx | `lib/admin/rate-limit.server.ts:182`, admin route call sites (users/bulk/export) | Every call uses the 3-arg form, so a 429 mints a fresh request id instead of correlating with the request's audit/log rows. Mechanical. | Thread `request` + `guard.requestId` into every `enforceRateLimit(...)`; extend the invariant to require the 6-arg form. | M |
| **P3-10 (IP-1)** | `getClientIp` doesn't validate the extracted XFF value is a syntactic IP | correctness | `lib/client-ip.ts:22,39` | Returns `ips[idx]` verbatim; if `TRUSTED_PROXY_COUNT` is misconfigured too large, an attacker-controlled non-IP token becomes the rate-limit bucket key (per-request bucket rotation). Bounded: only the IP-keyed token endpoint, which has a global floor. | Validate via `net.isIP`, return null on failure (collapse to shared `anon` bucket); document the `TRUSTED_PROXY_COUNT` requirement. | S |
| **P3-11 (TSQ-3)** | Unsound type casts: status unions, redundant date casts, unvalidated SSO claims | correctness | `lib/auth-status.ts:191`, `app/api/v1/users/[id]/route.ts:49`, `lib/jwt-handoff.server.ts:107` | Status columns cast to unions feeding the security decision (fails closed but breaks on schema drift); redundant `as unknown as Date`; `verifySsoHandoff` validates only jti/sub then casts the whole payload. | Validate status at the boundary (Zod enum → unknown becomes blocked); drop redundant casts; Zod-validate SSO claims. | M |
| **P3-12 (TSQ-4)** | Divergent API error-envelope conventions coexist | architecture | `lib/admin/errors.server.ts:44`, `lib/api-auth/problem.ts`, `app/api/account/profile/route.ts:31`, `preferences/locale/route.ts:27`, `navigation/shell-menu/route.ts:28` | Three styles: admin envelope, v1 RFC7807, and bare `{error}` (account/preferences/navigation) with no requestId/`x-request-id`/i18n key. | Shared envelope helper for non-admin first-party JSON routes carrying requestId + header + i18n key. | M |
| **P3-13 (A11Y-2)** | App-wide prompt dialog close button announces "Close" in English | accessibility | `components/ui/dialog.tsx:49`, `components/ui/dialog-manager.tsx:274` | Hardcoded sr-only "Close"; every `promptText` modal exposes English-only in fr/es/uk. `Sheet` already supports `closeLabel`. | Add a `closeLabel` prop / read a localized key; thread through. | S |
| **P3-14 (A11Y-3)** | Axe sweeps only run against `/en/` | testing | `tests/accessibility/admin-pages.spec.ts:28`, `status-pages.spec.ts:9`, `auth-pages.spec.ts:9` | All targets hardcode `/en/`; fr/es/uk never scanned, so A11Y-1's untranslated landmarks and the required-asterisk-label class (per project memory, only the a11y job catches it) pass CI in other locales. | Parameterize one admin page + the status pages over a second locale (loop en + uk). | S |
| **P3-15 (DB-4)** | Runtime pool sets no `idle_in_transaction_session_timeout` | performance | `db/database.ts:33`, `db/schema-config.ts:46` | `statement_timeout` bounds only a single statement; a tx stalling on an await between statements can pin its connection + locks indefinitely. | Add `idle_in_transaction_session_timeout` (env-tunable, e.g. 30000ms). | S |
| **P3-16 (DB-5)** | Case-insensitive email uniqueness pre-check seq-scans `app_users` | performance/correctness | `app/api/v1/users/route.ts:148`, `app/api/administrator/users/route.ts:201-206` | `where(lower(primary_email) = …)` has only a GIN trigram index (can't serve `lower()` equality) → seq-scan; no b-tree unique on `primary_email`, so **no DB-enforced** case-insensitive uniqueness despite the route comment claiming one. | Add a unique expression index on `lower(primary_email)` (or citext): seek + DB-enforced uniqueness. | S |
| **P3-17 (PERF-3)** | Pool `max=10` per process risks connection exhaustion under the documented serverless model | performance | `db/database.ts:19`, `docs/deployment.md:48-55` | Serverless = 10 × instances; deployment.md already says "use a pooled endpoint." Config-doc gap only, no code defect. | Document a recommended `PGPOOL_MAX` per hosting model; optionally warn at boot if a serverless marker + high `PGPOOL_MAX`. | S |
| **P3-18 (PERF-6)** | Daily-metric GROUP BY on `to_char(date_trunc(...))` isn't index-backed for the day bucket | performance | `lib/admin/metrics.server.ts:69-139` | Bucket expression computed per row, but only over the 7-day windowed slice (cheap today). Only matters if the window widens on a large audit table. | Leave for 1.0; if longer windows arrive, add an expression index or a daily rollup table. | M |
| **P3-19 (DOCS-7)** | README Scripts table omits operational scripts | docs | `README.md:60`, `package.json:26` | `db:prune`, `outbox:drain`, `openapi:export`, `sdk:admin:*` are documented in docs/ and referenced as operator actions but absent from the README table. | Add them to the README Scripts table, or note they live in package.json + the relevant docs. | S |

---

## 4. Categorized index

| Category | id — one-liner |
|---|---|
| **Security** | P2-2 SSO consume login-CSRF · P2-5 CSP-report log-flood · P2-8 banned principal mints JWT · P3-3 resolution path doesn't re-verify role org · P3-5 weak/non-distinct handoff secret · P3-10 unvalidated XFF IP |
| **Correctness** | P1-1 org DELETE FK 500 · P2-1 role DELETE strips group roles · P2-6 email duplicate on crash · P2-7 migration tx connection reuse · P2-12 env vars → NaN pool · P3-1 dead impersonate cookie loop · P3-2 non-idempotent provisioning · P3-4 SSO ignores banExpires · P3-8 outbox drainer edges · P3-11 unsound casts |
| **Observability** | P1-2 uncaught 5xx invisible without Sentry · P2-3 v1 5xx not audited/logged · P2-4 SSO consume no request-id + silent misconfig 500 · P3-9 429s lose x-request-id |
| **Performance** | P2-16 OFFSET export O(n²) · P2-17 count-column sort full materialization · P3-15 no idle-in-tx timeout · P3-16 email uniqueness seq-scan · P3-17 pool max under serverless · P3-18 metric GROUP BY |
| **Architecture** | P3-7 single-key JWKS rotation · P3-12 divergent error envelopes |
| **Testing** | P1-3 invariants miss /api/v1 + RSC + group UNION + WHERE-blind mocks · P3-14 axe en-only |
| **DX** | P2-11 warn-only lint gate · P2-13 error boundary subtree-only · P2-14 no loading/not-found/403 · P3-6 SSO app-id fails late |
| **Docs** | P3-19 README scripts gap |
| **Accessibility** | P2-15 hardcoded English landmarks · P3-13 dialog "Close" en-only |
| **Supply-chain** | P2-9 high-only audit gate (dompurify) · P2-10 unpinned openapi-generator-cli |

---

## 5. Quick wins (S, high-confidence — do first)

1. **P1-2** `logServerError` in `onRequestError` — one call, restores stdout visibility for every uncaught 5xx on the default deploy.
2. **P2-1** add `app_group_roles` to `assertRoleNotInUse` — small diff, closes an authorization-affecting silent strip.
3. **P2-8** `isBetterAuthUserBanned` check before minting — one line, consistency fix.
4. **P2-11** `--max-warnings 0` (or promote 3 rules to `error`) — config-only, tree is already clean.
5. **P2-9** bump mermaid → clear dompurify, then lower the audit gate to `moderate` with a dated allowlist.
6. **P2-10** pin `openapi-generator-cli` as a devDependency, invoke via `pnpm exec`.
7. **P2-4** mint + echo `x-request-id` in SSO consume; log the misconfig 500s.
8. **P3-2** `onConflict.doUpdateSet` on provisioning — removes the first-login race.
9. **P3-19** add the operational scripts to the README table.
10. **P2-13** add `error.tsx` to `(auth)`/`(public)`/`(secure)` reusing `RouteError`.

---

## 6. Development & enhancement plan

### Phase A — Must-fix for 1.0 (the P1s + critical P2s; ~1 eng-week)

Goal: close the two authenticated-admin correctness bugs, restore observability on the default deploy, and seal the regression net.

- **P1-1** org DELETE: catch the FK error → 409 (mirror enterprise-apps) **and** ship the ON DELETE forward migration. *(This migration is also the natural place to add the `lower(primary_email)` unique index from P3-16 and the nonce index pattern — batch the DDL.)*
- **P1-2 + P2-3 + P2-4** observability: route `logServerError` through `onRequestError`, `problemResponse` (≥500), and the SSO consume misconfig branches. Do these together — same root (Sentry-coupled logging).
- **P1-3** extend the route-scope **and** rate-limit invariant walks to `/api/v1/**` and admin RSC `page.tsx`; add the `tests/db` group-UNION + list-filter coverage using the WHERE-recording mock. *(Largest item; the invariant extension is mechanical, the DB tests are the effort.)*
- **P2-1** role DELETE group guard · **P2-8** banned-principal JWT check.

**Dependency note:** P1-1's migration and P3-16's index both want the same forward `0002` ALTER — author one migration covering org ON DELETE + `lower(primary_email)` unique + (optionally) `idle_in_transaction_session_timeout` defaults.

**Exit:** no admin delete returns a raw 500; the default DSN-less deploy logs every 5xx with a correlation id; a new `/api/v1` route or admin RSC page that drops scoping fails CI; the group UNION is exercised against Postgres.

### Phase B — 1.0 polish (remaining P2 + high-value P3; ~1 eng-week, can land at/around the tag)

- **Security/consistency:** P2-2 SSO launch-state binding · P2-5 CSP-report rate limit + aggregation · P3-3 resolution-path org filter · P3-5 handoff secret hardening.
- **Reliability:** P2-6 email idempotency key · P2-7 migration client checkout · P2-12 env-schema validation + NaN-safe coerce · P3-2 provisioning idempotency · P3-4 unify ban oracle.
- **Consistency/DX:** P2-11 lint gate · P2-13/P2-14 error/loading/not-found/403 boundaries · P3-9 thread request-id into 429s · P3-12 unify error envelope.
- **A11y:** P2-15 localized landmarks → then P3-14 add the uk axe sweep (which guards P2-15 from regressing) → P3-13 dialog close label. *(Sequence: localize first, then add the locale axe coverage so it doesn't go red on day one.)*
- **Supply-chain:** P2-9 / P2-10 (if not done as quick wins).

### Phase C — Post-1.0 roadmap (strategic + remaining P3)

- **Shared rate-limit backend** (Redis/Postgres token bucket via the existing `getStore()` seam) — unblocks horizontal scale-out; the in-memory limiter is correctly accepted for the single-instance 1.0 topology.
- **Enforcing CSP** — wire a per-request nonce from `proxy.ts`, propagate to `script-src`/`style-src`, drop `unsafe-inline`/`unsafe-eval`, flip Report-Only → enforce. Gate the cutover on the CSP report sink stabilizing (so fix **P2-5** first to make the sink trustworthy).
- **Performance at scale:** P2-16 keyset export pagination · P2-17 aggregate-sort rework · P3-16/P3-18 indexes/rollups (only if windows widen) · P3-15/P3-17 pool tuning + docs.
- **API maturity:** P3-7 JWKS multi-key rotation · P3-11 boundary type validation · P3-12 envelope unification (if deferred).
- **Cleanup:** P3-1 dead impersonate loop · P3-6 SSO app-id boot gate · P3-8 email locale seeds + drainer edges · P3-19 README.

**Cross-phase dependencies:** P2-5 (trust the CSP sink) precedes the enforcing-CSP cutover. P2-15 (localize landmarks) precedes P3-14 (uk axe). The Phase-A `0002` migration precedes P3-16/P3-15 DDL. P1-3's invariant extension makes every later `/api/v1` and RSC change self-guarding — do it early so Phase B/C additions inherit the net.

---

## 7. Cross-cutting themes & coverage gaps

**Systemic patterns**

1. **Sentry-coupled observability (P1-2, P2-3, P2-4).** The always-on pino stream is fed *only* through `auditEvent`. Any failure that doesn't pass through an audit hop — genuinely uncaught throws, v1 502 branches, SSO misconfig returns — is visible to Sentry or to nothing. On the default DSN-less topology, the system is blind to its own 500s. This is one root cause with three faces; fix it once at the seams (`onRequestError`, `problemResponse`, the bespoke SSO bodies).

2. **Invariant tests anchored to one directory (P1-3, P3-9, P3-14).** The project's best idea — build-time critic tests that fail CI when a route forgets a scope primitive or a rate limit — is scoped to `src/app/api/administrator/**/route.ts` only. `/api/v1`, admin RSC `page.tsx`, the 6-arg `enforceRateLimit` form, and non-en locales all sit outside the net. The surfaces are correct today; the net should cover everywhere the rule must hold, not just where it was first written.

3. **DELETE paths under-exercised (P1-1, P2-1).** Both delete bugs share a shape: a guard that checks one dependency table but not all of them, plus mocked tests that stub out the DB and never hit the FK/cascade. Whenever a table gains a new referencing FK or cascade, the corresponding delete guard and a real-DB test should be revisited.

4. **`process.env` read directly, bypassing `env.ts` (P2-12, P3-5, P3-6, P3-10, P3-17).** A meaningful set of runtime/security knobs (pool sizing, trusted-proxy count, SSO origin suffixes, the handoff secret's distinctness, the SSO app-id) live outside `serverEnvSchema`, so misconfiguration fails late and silently instead of at boot. Centralizing these would make the boot-time fail-fast contract (already strong for email/JWT) complete.

**Under-reviewed areas deserving a dedicated follow-up**

- **Real-DB test depth.** Only one `tests/db` suite exists (access-scope primitives). The ADR-0002 group UNION, every list-route org filter, and the two delete bugs above are mock-only — and the mocks pass regardless of the WHERE clause. A dedicated DB-backed integration tier for the security-critical mutation + scoping paths (templated on the proven `export-org-scope` WHERE-recording mock) is the single highest-leverage testing investment and would have caught P1-1 / P2-1 directly. *(Tracked as P1-3, but the scope is larger than one finding.)*
- **The email outbox under failure.** Retry/backoff exists, but the *exactly-once vs at-least-once* contract (P2-6), provider-switch-mid-retry (P3-8 Edge A), and error-body hygiene (P3-8 Edge B) suggest the failure modes of the worker weren't fully fuzzed. A short chaos pass (kill between `deliver()` and the UPDATE; flip the provider mid-drain) would harden the one channel that carries password-reset mail.
- **Concurrency at first login.** P3-2 is the visible instance, but the broader question — what else in the `session.create.after` hook chain assumes single-flight per new user — wasn't systematically reviewed. The hook re-raises (unlike its audit sibling), so any non-idempotent step there can turn a sign-in into a 500.

---

**Bottom line:** Ship 1.0. The architecture is production-grade and the security core is real. Land Phase A (≈1 week) to remove the two authenticated-admin correctness bugs and the observability blind spot, and the tag is honest and defensible. Phase B/C are the maturation roadmap, not release gates.
