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
| **Unit** | Vitest | `tests/unit` (~88 files) | Pure logic, guards, scope primitives, permission resolution, and **invariant tests** (route scope, rate-limit, locale parity, catalog count). |
| **Component** | Vitest + Testing Library (jsdom) | `tests/component` (~50 files) | Client React components (grids, forms, comboboxes) rendered against real primitives. |
| **Integration** | Vitest + mocked DB/auth | `tests/integration` (~41 files) | Route handlers end-to-end at the HTTP boundary (auth, validation, scoping, audit). |
| **Security** | Vitest | `tests/security` (~13 files) | Cross-tenant isolation, privilege-escalation guards, schema hardening, secret handling. See [§5](#5-security-suites). |
| **DB-backed** | Vitest + real Postgres | `tests/db` (~8 suites, `pnpm test:db`) | Suites that run against a live Postgres (`vitest.db.config.ts`, needs `DATABASE_TEST_URL`). |
| **E2E** | Playwright | `tests/e2e` (`.spec.ts`) | Full browser flows against a running, seeded app. |
| **Accessibility** | Playwright + axe-core | `tests/accessibility` (`.spec.ts`) | WCAG checks on key screens. |
| Shared helpers / setup | — | `tests/helpers`, `tests/setup` | Render harness, factories, jsdom polyfills. |

Vitest unit/component/integration/security tests **mock** the database and auth layers (table-aware proxies, session/access mocks) — they do **not** need a live database. The `tests/db` suites are the exception: they exercise the real query layer against Postgres.

## 2. Frameworks

- **Vitest 4** — unit/component/integration/security; coverage via `@vitest/coverage-v8`.
- **Testing Library** (`@testing-library/react`, `user-event`, `jest-dom`) for component tests in **jsdom**.
- **Playwright** + **axe-core** for browser e2e and accessibility.
- **MSW** and **supertest** are available for HTTP mocking/assertions.

## 3. Running tests

```bash
# Vitest suites
pnpm test            # sharded runner (scripts/test-shards.mjs) — the canonical way
pnpm test:unit       # vitest run tests/unit
pnpm test:component  # vitest run tests/component
pnpm test:integration
pnpm test:security
pnpm test:db         # DB-backed suite vs a real Postgres (vitest.db.config.ts, needs DATABASE_TEST_URL)
pnpm test:coverage   # full run WITH the coverage ratchet (what CI gates on)
pnpm test:serial     # plain `vitest run` (no sharding) — for debugging only

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

> The **sharded runner does not compute coverage.** Reproduce the CI coverage gate locally with `pnpm test:coverage` (it runs single-process — `maxWorkers: 1` — because coverage must aggregate in one process). Page/layout files, generated files, migrations/seeds, and shadcn primitives are excluded from the gate (see the `exclude` list in `vitest.config.ts`).

## 5. Security suites

The security suites (`tests/security/**`, plus security-relevant suites in `tests/integration/**` and `tests/unit/**`) protect the cross-tenant isolation and privilege-escalation guarantees of the three-tier access-control model, so future enhancements cannot silently re-open them. Coverage numbers below were measured with `pnpm test:coverage` (v8 provider) and are a **point-in-time snapshot** — re-run that command and recompute from `coverage/lcov.info` to refresh them.

### 5.1 What the security suites assert

- **Authorization / privilege escalation** — `administrator-organizations`, `administrator-roles`, `administrator-users-list`, `roles-subresources`, `user-app-roles` (integration) assert the full decision matrix per handler: `SUPERADMIN` allowed across orgs; `ORG ADMIN` allowed for their own org; `ORG ADMIN` gets **404** (not 403) for a foreign org's resource (no existence leak); and escalation guards reject (e.g. a non-superadmin granting `superuser`, attaching the `superuser` permission, or writing a global role).
- **Tenant isolation** — `export-org-scope.test.ts` covers each of the 7 org-scoped CSV export resources (`users`, `audit`, `organizations`, `roles`, `permissions`, `memberships`, `enterprise-apps`): an org admin's query is org-filtered, and a null scope yields a **header-only** CSV (never "all rows"). `admin-list-org-scope`, `user-memberships`, and `administrator-memberships` assert that list queries are org-scoped and that mutations touch **only the resolved ids**.
- **Schema / input hardening** — `handler-input-validation.test.ts` is table-driven across every mutating handler: it rejects unknown fields (`.strict()`), malformed UUIDs, oversized strings past the documented `max()` caps (a DoS guard), and invalid enums — each with a `400`. This pins the zod contracts that sit between request bodies and the database.
- **Secrets & tokens** — `no-tokens-in-menu-api`, `no-tokens-in-zustand` assert no secrets leak into API responses or client state; `jwt-handoff` and `jwt-handoff-jti` cover the handoff JWT and `jti` replay protection; `safe-return-to` and `locale-switch-protection` guard open-redirect and locale-switch surfaces; `account-linking-config` pins the account-linking policy.
- **Machine API (v1)** — `api-v1-admin-oauth-clients`, `api-v1-me-api-keys`, `api-v1-users-status` (integration) assert the permission/scope gates, self-ownership enforcement (a key cannot act outside its owner/scope), and 404-vs-403 discipline on cross-tenant ids.
- **Server helpers** — `user-actions-server`, `auth-admin-server` (unit) cover the per-row bulk-action executor (ban/suspend/delete/…) and the Better Auth admin wrappers, including the impersonation `Set-Cookie` forwarding contract.

### 5.2 Where the risk lives

The security **primitives are already well covered** — `lib/admin/access-scope.server.ts` (the org-boundary core), `lib/admin/user-target.server.ts`, `lib/auth-guard.ts`, `lib/audit.server.ts`, `lib/jwt-handoff.server.ts`, `lib/safe-return-to.ts`, and the `lib/api-auth/**` guards all sit at or near 100% lines. The historical gap was one layer up, in the **route handlers that enforce tenancy and RBAC by calling those primitives** — exactly the files changed in the cross-tenant hardening work. A handler can keep its deny path tested while the `canAccessOrg`-**allow** branch, the null-scope-empty return, and the "mutate only the resolved ids" constraint stay unexecuted, so a refactor could drop a scope check and CI would stay green. The suites in §5.1 close those branches.

### 5.3 The ratchet-gated plan

The remaining work is staged so each phase is independently shippable and lands as its own PR. **After every phase: re-run `pnpm test:coverage`, then raise the `vitest.config.ts` thresholds to just under the new measured values** so the gains cannot regress. New handler tests follow the established proxy-mock pattern in `tests/integration/administrator-organization-members.test.ts` and `tests/integration/org-scoped-admin-routes.test.ts` (mock `@/lib/auth-guard`, `@/lib/auth-status`, `@/lib/audit.server`, and the `db`).

The cross-tenant matrix, server-helper, machine-API, and schema-hardening suites (Phases 1–4 of the original plan) have **landed** as the files listed in §5.1. The open items are:

- **Phase 5 — residual primitive branches:** lift `lib/admin/access-scope.server.ts` to 100% branch (the `userHasMembershipInOrg` / null guards), plus `api-auth/jwt.server.ts`, `api-auth/scopes.ts`, and `lib/admin/roles.server.ts`.
- **Targets & guardrails:** per-area floor for `api/administrator`, `lib/admin`, `lib/api-auth` of **≥ 85% line / ≥ 75% branch**; keep raising the global ratchet toward the §29.2 minimums.
- **Optional companion invariant** (not yet implemented): assert each tenant route has at least one foreign-tenant **deny** test, so a new route cannot ship without a scoping test. This complements `tests/unit/admin-route-scope-invariant.test.ts`, which already requires every `/api/administrator/**` route to reference a scope primitive.

## 6. Notable invariant tests

These encode project rules and will fail the build if violated:

| Test | Enforces |
| --- | --- |
| `tests/unit/admin-route-scope-invariant.test.ts` | Every `/api/administrator/**` route references a tenant-scope primitive. |
| Admin rate-limit invariant | Every admin mutation calls `enforceRateLimit`. |
| Locale message parity | Every text key exists in **all eight** locales (`en`/`fr`/`es`/`uk`/`pt`/`zh`/`hi`/`ja`). |
| Permission catalog count | The `ADMIN_PERMISSION_CATALOG` has the expected number of keys (currently **35**). |

When you add a route, permission, or string, expect to update the corresponding invariant.

## 7. Test data

- Vitest unit/component/integration/security tests **mock** the database and auth layers (table-aware proxies, session/access mocks) — they do **not** need a live database.
- The `tests/db` and Playwright suites need a **running, seeded app / database**. CI does this by migrating and running `pnpm db:seed` against the Postgres service, then `pnpm start`. Locally, mirror that: `pnpm db:reset:reload` (or migrate + seed), `pnpm build && pnpm start`, then run `pnpm test:e2e`.
- CI sets `AUTH_RATE_LIMIT_DISABLED=1` for the browser job so the suites don't trip Better Auth's sign-in rate limiter. Never set this on a real deployment.

## 8. Manual QA checklist

When automated coverage isn't enough (e.g. a visual or flow change), walk these:

**Authentication**
- [ ] Sign up (default policy) → verify-email screen → click link → pending-approval; admin approves → can access the app.
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
- [ ] Each admin action appears in the audit log with a matching `x-request-id`.

**Platform**
- [ ] SSO launch→consume into a registered app.
- [ ] Mint an API key/token and call `/api/v1/me`.
- [ ] Switch UI language to `fr`/`es`/`uk`; no missing strings.
- [ ] Email: trigger a reset; confirm the outbox row (and delivery if a provider is set).

**Accessibility / responsiveness**
- [ ] Keyboard navigation through forms and the admin grid.
- [ ] Dark mode and small-viewport layouts render correctly.

---

_Next: [Troubleshooting](./troubleshooting.md)_
