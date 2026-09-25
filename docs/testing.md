---
title: Testing
description: The layered test strategy, how to run each suite, the security suites, the coverage ratchet, and a manual QA checklist.
group: Reference
order: 70
---

# Testing

_Audience: developers and QA. The test strategy, how to run each suite, what the security suites guarantee, the coverage ratchet, and a manual QA checklist._

---

## 1. Strategy

The suite is layered, with **security and tenant-isolation invariants treated as first-class tests**:

| Layer | Tool | Location | Focus |
| --- | --- | --- | --- |
| **Unit** | Vitest | `tests/unit` (~105 files) | Pure logic, guards, scope primitives, permission resolution, and **invariant tests** (route scope, rate-limit, locale parity, catalog count). |
| **Component** | Vitest + Testing Library (jsdom) | `tests/component` (~51 files) | Client React components (grids, forms, comboboxes) rendered against real primitives. |
| **Integration** | Vitest + mocked DB/auth | `tests/integration` (~50 files) | Route handlers end-to-end at the HTTP boundary (auth, validation, scoping, audit). |
| **Security** | Vitest | `tests/security` (~14 files) | Cross-tenant isolation, privilege-escalation guards, schema hardening, secret handling — including **property/fuzz tests** (fast-check) over the permission algebra and injection surfaces. See [§5](#5-security-suites). |
| **DB-backed** | Vitest + real Postgres | `tests/db` (~40 suites, `pnpm test:db`) | Suites that run against a live, migrated Postgres (`vitest.db.config.ts`): `DATABASE_TEST_URL`, else `DATABASE_URL`, and never a non-local host unless overridden ([which database](#the-db-backed-suites-database)). |
| **E2E** | Playwright | `tests/e2e` (`.spec.ts`) | Full browser flows against a running, seeded app ([journeys](#end-to-end-journeys)). |
| **Accessibility** | Playwright + axe-core | `tests/accessibility` (`.spec.ts`) | WCAG checks on key screens. |
| Shared helpers / setup | — | `tests/helpers`, `tests/setup` | Render harness, factories, jsdom polyfills. |

Vitest unit/component/integration/security tests **mock** the database and auth layers (table-aware proxies, session/access mocks) — they do **not** need a live database. The `tests/db` suites are the exception: they exercise the real query layer against Postgres.

### End-to-end journeys

The Playwright suite is the only layer where the real caller resolver, Better Auth, the database and a browser run together. The route suites mock at least one of those, which is how F-13 (every bearer caller got a 502 on a Better Auth-backed write) passed every check: until F-43, no journey used a bearer to change anything. Specs run in both projects in [`playwright.config.ts`](../playwright.config.ts), desktop Chrome and Pixel 7, with names and emails unique per project. A test skips the mobile project only where it would add nothing: the sidebar specs set their own viewport, and the bearer-mutation, API-key and cross-org bearer journeys are pure HTTP.

| Journey | Spec |
| --- | --- |
| Sign in through the form and reach the dashboard | `admin-sign-in` |
| Anonymous visitors are sent to sign-in with a `returnTo`, including the signed-out SSO launch | `anonymous-redirect` |
| Self sign-up → "check your inbox" → the emailed verification link → sign in → the dashboard or pending approval, as the default org's policy decides, with the account placed in that org (F-40). Sign-up starts no session, and the right password for an unverified account is refused with `EMAIL_NOT_VERIFIED` | `self-sign-up` |
| Invited sign-up from the emailed link lands active; the invitation survives a language switch | `invitations`, `locale-switch` |
| Password reset from the form through the emailed link; the outbox redacts the live link | `email-outbox` |
| Sign-out revokes the session on the server | `sign-out-revocation` |
| Client credentials: register → mint a JWT → call `/api/v1` → revoke → minting refused | `machine-credentials` |
| A JWT alone creates a user (201), approves it (200), and bans and unbans it (200) | `machine-credentials` |
| API key: mint from the session → list and create users with the key → rotate → the old key gets 401, the new one works | `machine-credentials` |
| A bearer bound to the default org gets 404 for a user who exists only in another org, and cannot find them by search (MACHINE-2) | `machine-credentials` |
| The MCP gateway accepts an MCP-audience JWT and refuses a v1-audience JWT and a session cookie | `mcp-bearer-only` |
| SSO handoff: launch → consume → confirm → replay refused | `sso-handoff` |
| Signed-out SSO launch → sign-in form → the `/{locale}/sso/launch` trampoline → the application's consume URL (#464) | `sso-handoff` |
| Tenant and permission boundaries in the admin workspace; impersonation confinement | `admin-cross-org-404`, `admin-permission-denied`, `impersonation-confinement` |
| Admin workspace and account screens: overview, users grid, create permission, account edits, sidebar | `admin-overview`, `admin-users-grid`, `create-permission`, `account`, `sidebar-*` |

The `browser` job in [`ci.yml`](../.github/workflows/ci.yml) turns on what these journeys need: `API_JWT_ENABLED` with an ephemeral signing key, `API_KEYS_ENABLED`, `MCP_ENABLED`, an ephemeral `SSO_HANDOFF_PRIVATE_KEY`, `AUTH_RATE_LIMIT_DISABLED`, and dummy social-provider credentials. A journey whose switch is off fails; it does not skip. A local run needs the same variables.

## 2. Frameworks

- **Vitest 4** — unit/component/integration/security; coverage via `@vitest/coverage-v8`.
- **Testing Library** (`@testing-library/react`, `user-event`, `jest-dom`) for component tests in **jsdom**.
- **Playwright** + **axe-core** for browser e2e and accessibility.
- **MSW** and **supertest** are available for HTTP mocking/assertions.
- **fast-check** — property-based/fuzz testing, used in the security suites (permission algebra, credential codec, injection surfaces).
- **Stryker** — mutation testing on the security core (`pnpm test:mutation`); runs as an **advisory** CI workflow ([`mutation.yml`](../.github/workflows/mutation.yml)) that proves the security tests actually assert (not just execute). The scope is the PURE security algebra: a module joins it only when no DB/network/Next plumbing stands between its unit tests and its logic (review #229). The mutated set is exactly ([`stryker.config.mjs`](../stryker.config.mjs) is the source of truth; `tests/unit/mutation-scope.test.ts` pins this list to it):
  - `src/lib/api-auth/scopes.ts` — scope matching
  - `src/lib/safe-return-to.ts` — the safe-return-to guard
  - `src/lib/admin/list-query.server.ts` — admin list-query parsing
  - `src/lib/api-auth/api-key.ts` — the API-key codec
  - `src/lib/trusted-origins.ts` — trusted-origin parsing
  - `src/lib/admin/origin-guard.server.ts` — the admin origin guard

  `src/lib/jwt-handoff.server.ts` (the SSO handoff codec) is **deliberately OUT of scope**: it would more than double the run — already the slowest advisory job in CI — because every one of its mutants re-runs jose Ed25519 sign/verify. Its assertions are covered by dedicated unit suites (`jwt-handoff*`, `sso-server`) plus fast-check property tests instead; `stryker.config.mjs` carries the full rationale and the conditions for revisiting it. Besides Stryker's aggregate `break` threshold, `scripts/check-mutation-floors.mjs` enforces a **per-file floor** at each file's measured score, so one module cannot hide behind another. Its sandbox (`.stryker-tmp/`) and the JSON report (`reports/`) are gitignored.

## 3. Running tests

```bash
# Vitest suites
pnpm test            # sharded runner (scripts/test-shards.mjs) — the canonical way
pnpm test:unit       # vitest run tests/unit
pnpm test:component  # vitest run tests/component
pnpm test:integration
pnpm test:security
pnpm test:db         # DB-backed suite vs a real Postgres: DATABASE_TEST_URL, else DATABASE_URL (local hosts only)
pnpm test:coverage   # full run WITH the coverage ratchet (what CI gates on)
pnpm test:serial     # plain `vitest run` (no sharding) — for debugging only
pnpm test:mutation   # Stryker mutation testing on the security core (slow; advisory in CI)

# Browser suites (need browsers + a running, seeded app)
pnpm test:e2e        # Playwright e2e
pnpm test:a11y       # Playwright + axe-core

# Everything (the full local gate)
pnpm test:all        # typecheck + lint + format:check + coverage + e2e + a11y
```

Run a single file or test:

```bash
pnpm exec vitest run tests/integration/administrator-phase7.test.ts
pnpm exec vitest run tests/unit/admin-permissions.test.ts -t "catalog"
```

### The DB-backed suite's database

`pnpm test:db` writes to the database it runs against. It creates and deletes users and organizations, and it briefly changes the platform sign-up policy. `vitest.db.config.ts` chooses that database once, when it loads, before any suite connects (F-44):

1. `DATABASE_TEST_URL`, when it is set. The suites receive it as their `DATABASE_URL`, the only variable the db layer reads.
2. Otherwise `DATABASE_URL`. CI's `quality` job sets only this one, to its Postgres service on `localhost`.
3. Either way, a host that is not local stops the run before it starts. Local means `localhost`, `127.0.0.1`, `::1`, `0.0.0.0` or no host, and a URL that does not parse counts as remote ([`src/db/guards.ts`](../src/db/guards.ts), the same classification `db:seed:dev` and `db:reset` use). Only `DB_TEST_ALLOW_REMOTE=1` lifts it, and only a disposable database deserves it. `CI` does not lift it.

With neither variable set, the run stops and asks for `DATABASE_TEST_URL`. Every run prints its target before the first suite starts, for example `[test:db] target  host=localhost  database=devresponse_db_test  (from DATABASE_TEST_URL)`. When the target comes from `DATABASE_TEST_URL`, a second line points back to this section.

[`.env.example`](../.env.example) points `DATABASE_TEST_URL` at `devresponse_db_test` on the Compose Postgres, and nothing creates that database for you. An `.env` copied before F-44 sets it too, and `pnpm test:db` used to ignore it, so the first run after F-44 fails every suite with `database "devresponse_db_test" does not exist` until you create it. Create and migrate it once, then re-run both migrate commands whenever a migration lands. The suites need the migrations only, as in CI, not a seed:

```bash
docker compose exec postgres createdb -U devresponse devresponse_db_test
DATABASE_URL=postgresql://devresponse:devresponse@localhost:5444/devresponse_db_test pnpm db:app:migrate
DATABASE_URL=postgresql://devresponse:devresponse@localhost:5444/devresponse_db_test pnpm db:auth:migrate
```

A variable already in the shell beats `.env` (dotenv never overrides one), which is what points the two migrate commands at the test database. Without `DATABASE_TEST_URL`, the suites run against your development database. On a seeded one, two `organization-auth-settings` tests fail, because they expect the platform default the migrations create (`admin_approval`) and `pnpm db:seed` changes it to `auto_active`.

### Why the sharded runner

`pnpm test` runs Vitest in **independent shard processes** (`scripts/test-shards.mjs`). Within a single Vitest process, the SSR module runner can race on the shared transform server under this dependency graph (Better Auth + Kysely + pg + next-intl), producing spurious `"… is not a function"` failures. Each shard gets its own isolated transform server, which removes the race.

- Shard count: `min(6, max(1, floor(cpuCount / 2)))`, overridable with `TEST_SHARDS=N`.
- Each shard runs single-worker; output is buffered and printed on completion; any failed shard fails the run.

> If you see odd "not a function" errors from a plain `vitest run`, use `pnpm test` (sharded) instead.

## 4. Coverage (the ratchet)

`pnpm test:coverage` enforces global thresholds in [`vitest.config.ts`](../vitest.config.ts):

| Metric | Threshold |
| --- | --- |
| Statements | 60% |
| Branches | 54% |
| Functions | 56% |
| Lines | 61% |

These are a **ratchet**: pinned just below the current measured values and meant to be **raised over time, never lowered**. A change that adds untested code and drops coverage below a floor fails CI even if every test passes — add tests to compensate. The §29.2 spec target (90/90/90/82) is the long-term destination; the Phase 1–5 plan in [§5](#5-security-suites) and later production-readiness work lifted the floor from an initial 38/36/34 to today's numbers.

**Per-file floors.** The same `thresholds` block also pins floors on single files: the security-load-bearing modules (the guards, the access-scope helpers, the credential stores) and, since F-42, **every route file under `src/app/api/v1/`** plus the five `/api/administrator` route files in which F-42 found a method that no test called. Vitest applies a glob threshold to the *total* of the files it matches (`perFile` is a global-only switch), so a single `src/app/api/v1/**` key would let one untested handler hide behind fifteen tested ones. `vitest.config.ts` therefore reads the v1 tree and gives each route file a key of its own. A v1 route added later is floored as soon as it lands. The floor that matters is `functions: 100`: every exported method is its own named function (`withV1Route(async function GET(…))`, F-29), so a method that no test calls takes its file below 100 and fails CI. A floored file that measures below the shared route floor is named in `ROUTE_FLOOR_EXCEPTIONS`, pinned at its measured value with the reason. Raise an exception as its tests land and never add one to let a handler in untested.

> The **sharded runner does not compute coverage.** Reproduce the CI coverage gate locally with `pnpm test:coverage` (it runs single-process — `maxWorkers: 1` — because coverage must aggregate in one process). Page/layout files, generated files, migrations/seeds, and shadcn primitives are excluded from the gate (see the `exclude` list in `vitest.config.ts`).

## 5. Security suites

The security suites (`tests/security/**`, plus security-relevant suites in `tests/integration/**` and `tests/unit/**`) protect the cross-tenant isolation and privilege-escalation guarantees of the three-tier access-control model, so future enhancements cannot silently re-open them. Coverage numbers below were measured with `pnpm test:coverage` (v8 provider) and are a **point-in-time snapshot** — re-run that command and recompute from `coverage/lcov.info` to refresh them.

### 5.1 What the security suites assert

- **Authorization / privilege escalation** — `administrator-organizations`, `administrator-roles`, `administrator-users-list`, `roles-subresources`, `user-app-roles` (integration) assert the full decision matrix per handler: `SUPERADMIN` allowed across orgs; `ORG ADMIN` allowed for their own org; `ORG ADMIN` gets **404** (not 403) for a foreign org's resource (no existence leak); and escalation guards reject (e.g. a non-superadmin granting `superuser`, attaching the `superuser` permission, or writing a global role).
- **Tenant isolation** — `export-org-scope.test.ts` covers each of the 7 org-scoped CSV export resources (`users`, `audit`, `organizations`, `roles`, `permissions`, `memberships`, `enterprise-apps`): an org admin's query is org-filtered, and a null scope yields a **header-only** CSV (never "all rows"). `admin-list-org-scope`, `user-memberships`, and `administrator-memberships` assert that list queries are org-scoped and that mutations touch **only the resolved ids**. `tenant-handler-reach.test.ts` (F-42) exercises handler methods whose tenant boundary no test exercised. Some were never called by the coverage-gated suite: `GET`/`DELETE /api/v1/admin/oauth-clients/[id]`, and on the console `GET /users/[id]`, `DELETE /api-keys/[id]`, `GET /groups/[id]/roles`, `GET /email/templates/[id]` and `GET /permissions`. (The live-Postgres `tests/db` suite calls the console `DELETE /api-keys/[id]` and `GET /permissions` for audit and paging checks, but it does not feed coverage.) The rest were called, but never across a tenant boundary: `GET /api/v1/audit-events` and `PATCH /api/v1/admin/oauth-clients/[id]` only behind a mocked guard, `PATCH /users/[id]` only for input validation, and `DELETE /api/v1/admin/api-keys/[id]` only for the caller's own org. The suite drives the real guards, access-scope helpers and credential stores over a database stub that records every builder call. The checks depend on the kind of handler:
  - **Tenant resources** (the `[id]` methods on oauth clients, API keys, users and groups): another org's resource is a **404** that **writes nothing**, and a superuser-owned key bound to one org gets the same 404 (MACHINE-2). `PATCH /api/v1/admin/oauth-clients/[id]` also cannot widen a client past the caller's issuable scopes (**403** `invalid_scope`, no write).
  - **Tenant lists** (`GET /api/v1/audit-events`, `GET /api/v1/users?q=`): the caller's org predicate reaches SQL, and a search narrows it rather than replacing it. For audit events, a superuser-owned key bound to one org is confined to that org (MACHINE-2), a caller with no org gets an empty page without a query, and a missing `admin.audit.read` is a 403 before any query.
  - **Platform catalogs** (`GET /email/templates/[id]`, `GET /permissions`): these have no tenant column, so there is no org 404 or MACHINE-2 case. Their boundary is the read permission, pinned as a **403** that never queries.

  Each 404, 403 and predicate case fails when the guard line it pins is removed. Beside the deny cases, the same request succeeds for the caller's own org (for a catalog, for a holder of its read permission), and most tenant methods also succeed for a superadmin at a browser, so the suite cannot pass by denying everyone.
- **Schema / input hardening** — `handler-input-validation.test.ts` is table-driven across every mutating handler: it rejects unknown fields (`.strict()`), malformed UUIDs, oversized strings past the documented `max()` caps (a DoS guard), and invalid enums — each with a `400`. This pins the zod contracts that sit between request bodies and the database.
- **Secrets & tokens** — `no-tokens-in-menu-api`, `no-tokens-in-zustand` assert no secrets leak into API responses or client state; `jwt-handoff` (EdDSA sign/verify, algorithm confusion, `kid` selection, receiver-side `maxTokenAge`, key rotation, minimised claims), `jwt-handoff-remote-jwks` (a consumer with no signing key verifying against the issuer's `/api/sso/jwks.json`) and `jwt-handoff-jti` cover the handoff JWT and `jti` replay protection; `safe-return-to` and `locale-switch-protection` guard open-redirect and locale-switch surfaces; `account-linking-config` pins the account-linking policy (empty `trustedProviders` — no provider may bypass the incoming profile's verified-email requirement) and `account-linking-behavior` exercises Better Auth's real implicit-linking decision against that policy.
- **Machine API (v1)** — `api-v1-admin-oauth-clients`, `api-v1-me-api-keys`, `api-v1-users-status` (integration) assert the permission/scope gates, self-ownership enforcement (a key cannot act outside its owner/scope), and 404-vs-403 discipline on cross-tenant ids.
- **Client IP normalization** — `client-ip` (unit) pins what `getClientIp` hands every consumer: `ip:port` and `[v6]:port` stripped, garbage and zone ids `null`, IPv4-mapped IPv6 mapped, never a hop other than the trusted one. It adds fast-check properties: every output is `null` or a canonical address that `net.isIP` accepts, with no zone id, and the limiter's IPv6 /64 grouping puts two addresses in one bucket exactly when Better Auth's own resolver does. `proxy-client-ip`, `audit-server` and `api-resolve-caller` pin the stamped header, the audit `ip_address` and the API-key `last_used_ip`. `tests/db/client-ip-inet.db.test.ts` is what shows `inet` accepts the output: it drives the real `auditEvent` against Postgres (the raw hops fail with `22P02`, the normalized ones insert) and checks a few hundred generated `normalizeClientIp` outputs with `pg_input_is_valid(…, 'inet')` (F-16). `edge-import-graph` keeps `node:net`, which the normalizer needs, out of the Edge instrumentation bundle.
- **Audit write amplification** — `pre-auth-refusals-not-audited` scans every `checkTrustedOrigin` call site in `src/` (each refusal branch must call `logPreAuthRefusal` and must not audit) and drives the admin and account guards and both SSO endpoints over the real `auditEvent` with a database stub that records inserts: a refusal decided before the caller is authenticated inserts nothing and is counted, while an authenticated denial still writes its row, with the `User-Agent` capped at 512 characters (F-15).
- **Server helpers** — `user-actions-server`, `auth-admin-server` (unit) cover the per-row bulk-action executor (ban/suspend/delete/…) and the Better Auth admin wrappers, including the impersonation `Set-Cookie` forwarding contract. `admin-wrappers-real-plugin` (security) drives every wrapper against the real `auth` instance on the memory adapter, as a bearer caller and as two kinds of cookie caller, and asserts the stored result; the route suites mock that seam, which is how every bearer caller getting a 502 stayed green (F-13).

### 5.2 Where the risk lives

The security **primitives are already well covered** — `lib/admin/access-scope.server.ts` (the org-boundary core), `lib/admin/user-target.server.ts`, `lib/auth-guard.ts`, `lib/audit.server.ts`, `lib/jwt-handoff.server.ts`, `lib/safe-return-to.ts`, and the `lib/api-auth/**` guards all sit at or near 100% lines. The historical gap was one layer up, in the **route handlers that enforce tenancy and RBAC by calling those primitives** — exactly the files changed in the cross-tenant hardening work. A handler can keep its deny path tested while the `canAccessOrg`-**allow** branch, the null-scope-empty return, and the "mutate only the resolved ids" constraint stay unexecuted, so a refactor could drop a scope check and CI would stay green. The suites in §5.1 close those branches.

### 5.3 The ratchet-gated plan

The remaining work is staged so each phase is independently shippable and lands as its own PR. **After every phase: re-run `pnpm test:coverage`, then raise the `vitest.config.ts` thresholds to just under the new measured values** so the gains cannot regress. New handler tests follow the established proxy-mock pattern in `tests/integration/administrator-organization-members.test.ts` and `tests/integration/org-scoped-admin-routes.test.ts` (mock `@/lib/auth-guard`, `@/lib/auth-status`, `@/lib/audit.server`, and the `db`).

The cross-tenant matrix, server-helper, machine-API, and schema-hardening suites (Phases 1–4 of the original plan) have **landed** as the files listed in §5.1. The open items are:

- **Phase 5 — residual primitive branches:** lift `lib/admin/access-scope.server.ts` to 100% branch (the `userHasMembershipInOrg` / null guards), plus `api-auth/jwt.server.ts`, `api-auth/scopes.ts`, and `lib/admin/roles.server.ts`.
- **Targets & guardrails:** per-area floor for `api/administrator`, `lib/admin`, `lib/api-auth` of **≥ 85% line / ≥ 75% branch**; keep raising the global ratchet toward the §29.2 minimums. Every `/api/v1` route file already has a per-file floor ([§4](#4-coverage-the-ratchet), F-42). Extending it to the rest of `/api/administrator` means an exception each for the route files that measure below the shared route floor (about a third of them when F-42 landed).
- **Optional companion invariant** (not yet implemented): assert each tenant route has at least one foreign-tenant **deny** test, so a new route cannot ship without a scoping test. This complements `tests/unit/admin-route-scope-invariant.test.ts`, which already requires every `/api/administrator/**` route to reference a scope primitive, and the per-file `functions: 100` floors, which already require every floored handler method to be called by some test.

## 6. Notable invariant tests

These encode project rules and will fail the build if violated:

| Test | Enforces |
| --- | --- |
| `tests/unit/admin-route-scope-invariant.test.ts` | Every `/api/administrator/**` route references a tenant-scope primitive. It is a tripwire: it reads each route file as text, so it cannot see one method of a multi-method route dropping its check. The behaviour is pinned by the route tests (`tenant-handler-reach`, [§5.1](#51-what-the-security-suites-assert)) and the per-file floors ([§4](#4-coverage-the-ratchet)), F-42. |
| Admin rate-limit invariant | Every admin mutation calls `enforceRateLimit`. |
| `tests/unit/route-request-id-invariant.test.ts` | Every `src/app/api/**` route handler is exported through `withAdminRoute` (or `withV1Route` under `/api/v1`), so every response carries `x-request-id` and a thrown handler answers an id-stamped `500 internal_error` (F-29). A route that must not be wrapped is named in its `EXEMPT` map with a reason. |
| `tests/unit/rate-limit-shared-floors-invariant.test.ts` | Every pre-auth floor consumes from the shared Postgres bucket (review #98). Derived, not listed (F-19): it walks the TypeScript AST of every file under `src/` and fails on an in-memory `consumeToken` / `enforceRateLimit` whose key comes from the client IP (`clientIpKey`, `getClientIp`, the removed `actorIdFromRequest`) — directly, in a ternary arm, or through a same-file const or helper — with a negative control that plants each shape. Invitation acceptance, keyed on a principal anyone can self-register, is named. A deployment-wide floor is charged only through `consumeSourceThenGlobal`, after the request's per-IP bucket admitted it, so `__global__` is spelled nowhere else under `src/` (F-18). |
| `tests/unit/breakpoints.test.ts` | One mobile/desktop breakpoint (F-36). The shell CSS, `useIsMobile` and Tailwind's `md` all use the two queries in `src/lib/breakpoints.ts`, `(width < 48rem)` and `(width >= 48rem)`. The test compiles the real `globals.css` with Tailwind and fails on any other width query in a stylesheet or a TS/TSX string literal (including `min-[…]:` / `max-[…]:` variants). A responsive-image `sizes` hint is exempt, because it picks a download and hides nothing. `tests/component/sidebar-breakpoint.test.tsx` proves the trigger reaches the navigation at 767.5px, 768px and at a 20px default font, and `tests/e2e/sidebar-breakpoint.spec.ts` covers 768×1024 and 767×1024 in a real browser. |
| `tests/unit/intl-formatter-invariant.test.ts` | Every date, time and number the UI shows goes through the app formatter (F-37): `useAppFormatter` in a client component, `getAppFormatter` in a server one. It walks the TypeScript AST of `src/app`, `src/components` and `src/hooks` and fails on `Intl.DateTimeFormat` / `NumberFormat` / `RelativeTimeFormat` / `DurationFormat`, a `.toLocale*String()` call, or an import of next-intl's `useFormatter` / `getFormatter` (they apply the zone but not the saved date or number format). An exempt file is named in `ALLOWED` with its reason, and a stale entry fails. `tests/component/app-formatter.test.tsx` server-renders under one `TZ` and hydrates under another to prove the text matches, with the pre-F-37 formatter as the failing control. The scan cannot see a count shown with `String(n)` or a day bucketed in the wrong zone, so `tests/unit/admin-overview-page.test.tsx` renders the Administrator overview with a saved zone, date format and number format, and `tests/db/dashboard-metrics-zone.db.test.ts` runs its daily charts' zoned day buckets against Postgres. |
| Locale message parity | Every text key exists in **all eight** locales (`en`/`fr`/`es`/`uk`/`pt`/`zh`/`hi`/`ja`). |
| Permission catalog count | The `ADMIN_PERMISSION_CATALOG` has the expected number of keys (currently **35**). |
| `tests/unit/gitleaks-config.test.ts` | The secret-scan config (`.gitleaks.toml`) detects the app's own credential formats at their real lengths, no fixture in the tree reaches those lengths, and the seed-admin default password is allowlisted only in the files that document it (never globally). See [SECURITY.md → Secret scanning](../SECURITY.md#secret-scanning). |
| `tests/unit/help-capture-tooling.test.ts` | `help/capture.mjs` takes credentials from `CAPTURE_*` env vars only (fails fast when unset), holds no credential literal, resolves entity ids at run time and refuses a non-2xx page (#237), and is excluded from the Docker build context. |
| `tests/unit/db-transaction-discipline.test.ts` | The migration runner, seed and reset scripts open every transaction on a **checked-out** client, never through the pool (#84). The behavioural half is `tests/db/migration-transaction.db.test.ts` — a failing migration leaves neither DDL nor a ledger row. |
| `tests/unit/db-test-target.test.ts` | `pnpm test:db` runs against `DATABASE_TEST_URL`, else `DATABASE_URL`, and refuses a non-local host of either unless `DB_TEST_ALLOW_REMOTE=1` (F-44). It loads the real `vitest.db.config.ts` too, so a config that stops calling the check, or stops handing its answer to the workers, fails here. |
| `tests/unit/migration-catalog-scoping.test.ts` | Every migration's system-catalog lookup is schema-scoped (`conrelid = '…'::regclass`, an `nspname` join, or `table_schema = current_schema()`), with one documented exception in the frozen `0001` (#88). |

When you add a route, permission, or string, expect to update the corresponding invariant.

## 7. Test data

- Vitest unit/component/integration/security tests **mock** the database and auth layers (table-aware proxies, session/access mocks) — they do **not** need a live database.
- The `tests/db` suites need a **migrated** database, not a seeded one: CI's `quality` job migrates its Postgres service and runs them without a seed. See [which database they use](#the-db-backed-suites-database).
- The Playwright suites need a **running, seeded app / database**. CI does this by migrating and running `pnpm db:seed` against the Postgres service, then `pnpm start`. Locally, mirror that: `pnpm db:reset:reload` (or migrate + seed), `pnpm build && pnpm start`, then run `pnpm test:e2e`.
- CI sets `AUTH_RATE_LIMIT_DISABLED=1` for the browser job so the suites don't trip Better Auth's sign-in rate limiter. Never set this on a real deployment.

## 8. Manual QA checklist

When automated coverage isn't enough (e.g. a visual or flow change), walk these:

**Authentication**
- [ ] Sign up → verify-email screen → click link → sign in → the dashboard under the seeded `auto_active` default (automated in `self-sign-up`), or pending-approval under `admin_approval`; admin approves → can access the app.
- [ ] Invite a user (org Members tab) → open the emailed `/invite` link → create account → land **active** in the inviting org, no approval step.
- [ ] Org **Authentication** tab: switch the policy (e.g. auto-active or invite-only) and confirm a new sign-up follows it.
- [ ] Sign in / sign out; session persists across reload.
- [ ] Forgot password → reset link → new password works.
- [ ] Social login (if enabled) for each configured provider.

**Tenancy & access**
- [ ] Org admin sees only their organization; out-of-scope ids return 404.
- [ ] Super admin sees all organizations.
- [ ] Switching active organization recalculates visible permissions.

**Administration**
- [ ] Create org, user, role (assign permissions), group (bundle roles, add members).
- [ ] Bulk action on users (approve/block) behaves and is audited.
- [ ] CSV export downloads and respects the row cap.
- [ ] Each admin action appears in the audit log with the `x-request-id` its response carried (successes included).

**Platform**
- [ ] SSO launch→consume into a registered app.
- [ ] Mint an API key/token and call `/api/v1/me`.
- [ ] Switch UI language to `fr`/`es`/`uk`; no missing strings.
- [ ] Email: trigger a reset; confirm the outbox row (and delivery if a provider is set).

**Accessibility / responsiveness**
- [ ] Keyboard navigation through forms and the admin grid.
- [ ] Dark mode and small-viewport layouts render correctly.

## 9. CI workflows and required checks

Every workflow lives in [`.github/workflows/`](../.github/workflows/) and pins its actions by commit SHA (Dependabot proposes the bumps). The **check name** column is the job `name:` — it is what branch protection on `main` requires, so renaming a job silently un-gates it.

| Workflow | Check name | Required | Runs on |
| --- | --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | `Typecheck, lint, format, tests` | yes | pull_request, push to `main` |
| [`ci.yml`](../.github/workflows/ci.yml) | `E2E + accessibility (Playwright)` | yes | pull_request, push to `main` |
| [`ci.yml`](../.github/workflows/ci.yml) | `OpenAPI + admin SDK drift` | yes | pull_request, push to `main` |
| [`ci.yml`](../.github/workflows/ci.yml) | `Better Auth schema drift` | yes | pull_request, push to `main` |
| [`ci.yml`](../.github/workflows/ci.yml) | `Markdown links` | — | pull_request, push to `main` |
| [`dependency-audit.yml`](../.github/workflows/dependency-audit.yml) | `Dependency audit` | yes | pull_request, push to `main`, **weekly** (Mon 05:13 UTC), manual |
| [`dependency-audit.yml`](../.github/workflows/dependency-audit.yml) | `Dependabot alerts` | — | **weekly** (Mon 05:13 UTC), manual |
| [`codeql.yml`](../.github/workflows/codeql.yml) | `Analyze (javascript-typescript)` | yes | pull_request, push to `main`, weekly (Mon 04:27 UTC) |
| [`secret-scan.yml`](../.github/workflows/secret-scan.yml) | `gitleaks` | yes | pull_request, push to `main` |
| [`docker-scan.yml`](../.github/workflows/docker-scan.yml) | `trivy` | yes | pull_request, push to `main`, weekly (Mon 06:00 UTC), manual |
| [`mutation.yml`](../.github/workflows/mutation.yml) | `Stryker (security core)` | advisory | pull_request touching the security core, manual |

The three scheduled workflows exist because a gate that only runs when a commit lands never re-checks an **idle** `main`: the dependency audit sat red for weeks in mid-2026 with nobody the wiser (review #227). The weekly run re-audits the unchanged tree with `pnpm audit --audit-level high`, covering **both** lockfiles: the app's, and the deploy CLI's in `vercel-cli/`, which handles `VERCEL_TOKEN` and the production database URL and went unaudited until F-28. The same run's `Dependabot alerts` job lists GitHub's open high/critical Dependabot alerts, because GitHub's advisory database reports advisories `pnpm audit` misses. That job runs only on the schedule and on manual dispatch, since alerts describe `main` and a PR that fixes one would otherwise stay red until it merged. A **failed scheduled run** opens a GitHub issue titled "Dependency audit failing on main" (or comments on the open one) naming what failed, and marking **NOT AUDITED** any lockfile whose audit a setup or install failure skipped, so a setup fault is never read as an advisory. A PR or push failure is already in front of its author, so only the schedule notifies. Fix it the way [SECURITY.md → Dependency advisory allowlist](../SECURITY.md#dependency-advisory-allowlist) describes: bump or floor the package; mute only a dev/build/test-only advisory with no fix. Dependabot security-update PRs depend on a repository setting that no workflow can read; [SECURITY.md → Repository security settings](../SECURITY.md#repository-security-settings) is the operator check for it. `tests/unit/dependency-governance.test.ts` pins that the audit workflow keeps its schedule, its job name, its SHA-pinned actions, an audit step for every lockfile in the repository, a read-only alerts job kept apart from the job that installs PR code, and, by executing the notify script against fakes, what the tracking issue says for each failing, unaudited or alerting case.

A workflow file is never executed by the test suite, so anything load-bearing in one is pinned the same way. [`deploy.yml`](../.github/workflows/deploy.yml) — the only workflow that can apply DDL to production or promote a build — is covered by `tests/unit/deploy-workflow-guards.test.ts` (**DEPLOY-1**, and the fork guard from review 2026-09-04 #10): that its `preflight` job **fails the run** when only *some* of the four deploy credentials are set and skips green only when *none* are, and that the fork/trigger guard is restated on `deploy` itself — the job that checks out the triggering sha and holds `PRODUCTION_DIRECT_DATABASE_URL` — rather than inherited through `needs:`. See [Deployment §1.2](./deployment.md#12-the-actions-pipeline-optional-and-not-configured-deploy-1).

---

_Next: [Troubleshooting](./troubleshooting.md)_
