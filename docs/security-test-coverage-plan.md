---
title: Security Test-Coverage Plan
description: Where the security-relevant code is under-tested, and a phased, ratchet-gated plan to close the gaps so future enhancements cannot silently break tenant isolation or RBAC.
group: Reference
order: 70
---

# Security Test-Coverage Plan

This document records the state of unit/integration test coverage for the
**security-critical** code paths — database access, tenant isolation, RBAC
(roles/permissions), and request validation (schemas) — and lays out a
ready-to-execute plan to raise that coverage so future enhancements cannot
silently re-open the cross-tenant and privilege-escalation holes that the
ADR-0001 hardening closed.

Coverage numbers below were measured with `pnpm test:coverage`
(`vitest run --coverage`, v8 provider) and are a **point-in-time snapshot**;
re-run that command to refresh them. Per-file figures come from
`coverage/lcov.info`.

---

## 1. How the test suite is organized

There are three test tiers (plus Playwright e2e/a11y, out of scope here):

| Tier | Location | What it holds |
| --- | --- | --- |
| Unit | `tests/unit/**` | Pure helpers and server modules with the DB/auth layers stubbed. |
| Integration | `tests/integration/**` | Route handlers imported directly; `db`, `getCurrentSession`, and `getUserAccessContext` are mocked (proxy-`db` pattern). |
| Security | `tests/security/**` | Cross-cutting invariants — no-secrets-in-API, safe `returnTo`, JWT `jti` replay, locale-switch protection, the route-scope invariant. |

The runner shards across processes (`scripts/test-shards.mjs`); coverage runs
single-process (`vitest.config.ts` pins `maxWorkers: 1`).

The coverage **ratchet** in `vitest.config.ts` (`thresholds`) is currently
pinned far below the measured values (lines 38 / branches 36 / functions 34).
It therefore only catches a *regression below today's floor* — it does **not**
push coverage up. Raising it after each phase below is the mechanism that makes
these gains permanent.

---

## 2. Key finding — the gap is in the handlers, not the primitives

The security **primitives are already well covered**. The risk is one layer up,
in the **route handlers that enforce tenancy and RBAC by calling those
primitives** — exactly the files changed in the ADR-0001 cross-tenant work.

**Well-covered (leave alone):**

| Module | Line % | Notes |
| --- | --- | --- |
| `lib/admin/access-scope.server.ts` | 100 (branch 86) | the org-boundary core |
| `lib/admin/user-target.server.ts` | 100 | scoped target resolution |
| `lib/auth-guard.ts`, `lib/audit.server.ts`, `lib/admin-status.server.ts` | 100 | |
| `lib/jwt-handoff.server.ts`, `lib/client-ip.ts`, `lib/safe-return-to.ts` | 100 | |
| `lib/admin/list-query.server.ts` | 98 | sort/filter allow-listing |
| `lib/sso.server.ts`, `lib/user-provisioning.server.ts` | 96 | |
| `lib/admin/permissions.server.ts` | 93 | |
| `lib/admin/roles.server.ts` | 84 | |
| `lib/api-auth/**` (guard, jwt, scopes, resolve-caller) | ~90 | |

**Under-covered and security-relevant (the work list):**

| Handler / module | Line % | Branch % | Why it matters |
| --- | --- | --- | --- |
| `api/administrator/export/[resource]` | 30 | **14** | 7 org-scoped CSV builders (bulk-exfil surface); 142 uncovered lines |
| `api/administrator/users/[id]/app-roles` | 9 | 3 | role-org match + `superuser`-grant guard (P0-2) |
| `api/administrator/users/[id]/memberships` | 0 | 0 | body-org scope + mutate-only-resolved-ids (P0-4) |
| `api/administrator/roles/[id]/permissions` | 0 | 0 | `superuser`-attach guard + foreign-role 404 (P0-7) |
| `api/administrator/roles/[id]/members` · `.../duplicate` | 0 | 0 | foreign/global-role 404 (P0-7) |
| `api/administrator/memberships` | 0 | 0 | global memberships list scoping |
| `api/administrator/permissions` · `permissions/[id]` | 20 / 10 | 15 / 5 | SUPERADMIN-only catalog writes (P0-10) |
| `api/administrator/organizations/[id]/provider-bindings` | 20 | 12 | per-org scope on all verbs (P0-5) |
| `api/administrator/organizations/[id]` · `.../members` | 23 / 46 | 20 / 43 | org `[id]` scope (P0-3, P0-8) |
| `api/administrator/roles/[id]` · `roles` | 50 / 73 | 37 / 54 | global-role = SUPERADMIN-only; org-create restriction (P0-7) |
| `api/administrator/users/bulk` | 63 | 45 | org-membership filter on explicit ids **and** `"*"` |
| `lib/admin/user-actions.server.ts` | **4** | 0 | per-row bulk action executor (ban/suspend/delete/…) |
| `lib/admin/auth-admin.server.ts` | **0** | 0 | Better Auth admin wrappers (impersonate/ban/password) |
| `api/v1/admin/oauth-clients/**` | 0 | 0 | machine-API credential CRUD + secret rotation |
| `api/v1/me/api-keys/**` | 0 | 0 | self-service API-key issuance/rotate/revoke |
| `api/v1/users/[id]/status` · `api/v1/audit-events` | 0 | 0 | v1 permission/scope gates |

**Why this is the priority:** the deny path for a handful of these is exercised
by `tests/integration/org-scoped-admin-routes.test.ts`, but the
`canAccessOrg`-**allow** branches, the `superuser` escalation guards, the
null-scope-empty returns, and the "mutate only the resolved ids" constraints are
**unexecuted**. A future refactor could drop a `canAccessOrg(...)` call and CI
would stay green. Closing these branches is what protects the ADR-0001 guarantee
during future enhancements.

---

## 3. The plan (phased, ratchet-gated)

Each phase is independently shippable and **should land as its own PR**. After
every phase: re-run `pnpm test:coverage`, then raise the `vitest.config.ts`
thresholds to just under the new measured values so the gains cannot regress.

New handler tests follow the established proxy-mock pattern in
`tests/integration/administrator-organization-members.test.ts` and
`tests/integration/org-scoped-admin-routes.test.ts` (mock `@/lib/auth-guard`,
`@/lib/auth-status`, `@/lib/audit.server`, and `@/db/database`).

### Phase 1 — Cross-tenant isolation matrix *(highest value)*

For **every** tenant-scoped admin handler, assert the full decision matrix
rather than a single case:

- `SUPERADMIN` → allowed across orgs (incl. global/org-less resources),
- `ORG ADMIN` → allowed for their own org,
- `ORG ADMIN` → **404** for a foreign org's resource (no existence leak),
- null scope → empty result, never "all",
- privilege-escalation guards reject (e.g. non-superadmin granting `superuser`).

Files:

- **`tests/security/export-org-scope.test.ts`** — for each of the 7 export
  resources (`users`, `audit`, `organizations`, `roles`, `permissions`,
  `memberships`, `enterprise-apps`): org admin's query is org-filtered; null
  scope yields a header-only CSV. *Largest single win (+142 lines, branch
  14 → ~85%).*
- **`tests/integration/roles-subresources.test.ts`** — `[id]/permissions`
  (`superuser`-attach → 403, foreign role → 404, happy-path add/remove),
  `[id]/members`, `[id]/duplicate`.
- **`tests/integration/user-app-roles.test.ts`** — assign/revoke: org match,
  role-org match (404), `superuser`-grant → 403, happy-path 201/200.
- **`tests/integration/user-memberships.test.ts`** — list org-scoped; POST body
  `organizationId` via `canAccessOrg`; PATCH/DELETE mutate only resolved ids.
- **`tests/integration/administrator-memberships.test.ts`** — global memberships
  list scoping.
- Extend `administrator-organizations.test.ts` / `administrator-roles.test.ts`
  for `provider-bindings`, `permissions` (+`[id]`) SUPERADMIN-only writes, and
  the org-create restriction on `roles`.
- Extend `administrator-phase7.test.ts` — bulk org-membership filter on explicit
  ids **and** `"*"`.

### Phase 2 — Security server helpers at ~0%

- **`tests/unit/user-actions-server.test.ts`** — each action
  (`approve`/`block`/`suspend`/`reactivate`/`ban`/`unban`/`soft_delete`/`restore`)
  routes to the correct Better Auth/db call; partial-failure handling; the
  per-row outcome shape.
- **`tests/unit/auth-admin-server.test.ts`** — wrappers forward arguments and
  handle the plugin response/`headers` shape (incl. the impersonation
  `Set-Cookie` forwarding contract).

### Phase 3 — Machine API (v1) admin & self-service (all 0%)

- **`tests/integration/api-v1-admin-oauth-clients.test.ts`**,
  **`api-v1-me-api-keys.test.ts`**, **`api-v1-users-status.test.ts`** —
  permission/scope gates, self-ownership enforcement (a key cannot act outside
  its owner/scope), and 404-vs-403 discipline on cross-tenant ids.

### Phase 4 — Schema / input-validation hardening *(the "schemas" surface)*

- **`tests/security/handler-input-validation.test.ts`** — table-driven across
  every mutating handler: rejects unknown fields (`.strict()`), malformed UUIDs,
  **oversized strings past the documented `max()` caps** (a DoS guard), and
  invalid enums — each with `400`. This pins the zod contracts that stand between
  request bodies and the database.

### Phase 5 — Residual primitive branches

- `lib/admin/access-scope.server.ts` 86 → 100 branch (the
  `userHasMembershipInOrg` / null guards), `api-auth/jwt.server.ts` 74 branch,
  `api-auth/scopes.ts`, `lib/admin/roles.server.ts` 84.

---

## 4. Targets & guardrails

- **Per-area floor:** `api/administrator`, `lib/admin`, `lib/api-auth` →
  **≥ 85% line / ≥ 75% branch**.
- **Global ratchet:** realistically **38 → ~60%** after Phases 1–3; bump
  `vitest.config.ts` thresholds after each phase.
- **Keep** `tests/unit/admin-route-scope-invariant.test.ts` (every
  `/api/administrator/**` route must reference a scope primitive). Optional
  companion invariant: assert each tenant route has at least one foreign-tenant
  **deny** test, so a new route cannot ship without a scoping test.

---

## 5. Refresh procedure

```bash
pnpm test:coverage          # regenerates coverage/lcov.info
```

Then recompute the per-file table from `coverage/lcov.info` (`SF:` / `LF:` /
`LH:` / `BRF:` / `BRH:` records) and update §2. When a phase lands, raise the
`thresholds` block in `vitest.config.ts` to just under the new global numbers.
