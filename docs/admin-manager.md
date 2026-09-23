---
title: Administrator Console — Specification
description: Canonical spec for the Administrator console — access model, guarded request pipeline, error envelope, permission catalog, per-area behavior, audit model, and Phase 7 (impersonation, bulk, export).
group: Reference
order: 80
visibility: internal
---

# Administrator Console — Specification

_Audience: engineers building, extending, or auditing the Administrator
workspace. This document is the canonical reference for the
`/api/administrator/*` surface and the RSC pages under
`src/app/[locale]/(secure)/app/administrator/**`. The route handlers and the
helpers in `src/lib/admin/**` are authoritative; where this prose and the code
disagree, the code wins — fix the doc._

Source comments across the codebase cite this document by section (for example
`docs/admin-manager.md §12`). The numbered sections below are stable anchors for
those citations. Numbering is therefore intentionally **gappy**: when a section
is removed its number is retired, never reused, so a stale citation can dangle
but can never silently point at the wrong content. Do not renumber existing
sections; new sections take a fresh number (or a sub-number of the section they
belong to).

Related references:

- [API Reference](./api.md) — the full HTTP surface, including the parallel
  machine API (`/api/v1`).
- [ADR-0001 — Three-Tier Access Control](./architecture.md#access-control-design-decisions)
  — the org-boundary model this console enforces.
- [ADR-0002 — Organization Groups](./architecture.md#access-control-design-decisions) — the
  groups feature (§8.6).
- [Security Policy](../SECURITY.md) — reporting, scope, and the threat areas
  this console touches.

---

## 1. Overview

The Administrator console is a multi-tenant admin shell. It exposes two
cooperating layers over the same data and authorization model:

- **RSC pages** under `src/app/[locale]/(secure)/app/administrator/**` render
  the workspace (grids, detail panes, editors). Page and layout entry points
  authorize via `checkAdminPermissionServer` and call `notFound()` on a denial
  (§6.2).
- **API route handlers** under `src/app/api/administrator/**` back every grid,
  mutation, and export. They authorize via `requireAdminPermission` (§4), return
  the standard error envelope (§5.1), enforce per-actor rate limits on mutations
  (§2.5), and write audit rows (§12).

Every handler is `dynamic = "force-dynamic"` — authorized data is never cached.
Every mutating route runs, in order: a permission check, an origin/CSRF guard,
a per-actor rate limit, Zod body validation, the mutation, and an audit write.

### 2.1 Workspace shell

The Administrator app renders inside a nested `ApplicationShell`
(`src/app/[locale]/(secure)/app/administrator/layout.tsx`). The layout
authorizes the caller against the "any admin permission" superset (§6.1) so a
caller who holds no `admin.*` key never sees the shell.

### 2.3 Navigation

The workspace sidebar (`_components/administrator-sidebar.tsx`) lists the admin
areas (§8). It follows the same `FlexSidebar` pattern as the root secure shell
and is filtered server-side by the caller's permissions, so an org admin only
sees the areas they can act on.

### 2.5 Rate limiting of admin mutations

Every Administrator **mutation** (POST / PATCH / PUT / DELETE) is throttled by a
per-actor in-memory **token bucket** (`src/lib/admin/rate-limit.server.ts`).
Read endpoints are unbounded — paging through a grid must never be throttled.
(The in-memory store is per process; that is deliberate for these
authenticated per-actor limits. The unauthenticated **pre-auth floors** —
token endpoint, MCP registration, CSP sink, invitation acceptance — use the
Postgres-backed bucket instead; see [Architecture → Rate limiting](./architecture.md#rate-limiting).)

- The limiter is a **UX / abuse guard layered on top of** authorization, never a
  substitute for it (`requireAdminPermission` runs first).
- Buckets are keyed by `scope:actorId` (`rateLimitKey`) so one noisy admin
  cannot starve another. Mutations key on the resolved Better Auth user id.
- Denials return **429** with a `Retry-After` header (seconds) and the standard
  envelope `{ error: "rate_limited", retryAfter }` (§5.1). Each denial also
  increments a Prometheus counter and writes a **flood-safe** denial audit row
  (`administrator.rate_limited`) gated through its own very-low-rate bucket so a
  sustained 429 flood cannot amplify into unbounded audit rows.

Default budgets (capacity = burst, refill = steady requests/sec):

| Budget | Capacity | Refill / sec | Used by |
| --- | --- | --- | --- |
| `DEFAULT_ADMIN_MUTATION_LIMIT` | 30 | 1 | Per-row mutations (create, status, ban, …) |
| `DEFAULT_ADMIN_BULK_LIMIT` | 6 | 0.2 (≈1 / 5s) | Bulk actions (a single call touches ≤500 rows) |
| `DEFAULT_ADMIN_EXPORT_LIMIT` | 3 | 0.05 (≈1 / 20s) | CSV export (heavy; ≤100k rows) |
| `DEFAULT_SSO_LAUNCH_LIMIT` | 30 | 1 | `GET /api/sso/launch` — keyed per principal (session user id; trusted client IP while signed out) |
| `DEFAULT_SSO_CONSUME_LIMIT` | 30 | 1 | `GET`/`POST /api/sso/consume` — keyed per trusted client IP (no principal exists before the token verifies) |

The bucket is in-memory and process-local: a restart resets it and budgets are
not shared across instances. The supported 1.0 topology is therefore a single
application instance; a shared (Redis) backend is post-1.0 work.

---

## 4. The guarded request pipeline (`requireAdminPermission`)

`src/lib/admin/permissions.server.ts` is the single authorization entry point
for every Administrator server surface. `requireAdminPermission(request,
permission)` returns either an `AdminPermissionGrant` (carrying the resolved
identity and access context) or an `AdminPermissionDenial` (carrying a
ready-to-return `NextResponse`). Callers branch with `isAdminPermissionDenial`.

The pipeline, in order:

1. **Mint / adopt a request id.** `getOrCreateRequestId` honours an inbound
   `x-request-id` only when it came through a trusted proxy hop and is a UUID
   (review #99/#224); otherwise it generates one. It flows onto the response
   header and every audit row this request writes (§5.1, §12).
2. **Origin / CSRF guard.** For unsafe methods on **ambient (cookie)**
   credentials, `checkTrustedOrigin` requires a trusted `Origin`/`Referer`.
   Bearer callers skip this (a token cannot be attached by an attacker's page).
   The check runs **before** caller resolution so an unauthenticated cross-origin
   probe cannot trigger a DB round-trip. A failure audits
   `administrator.access.denied` (`denied`) and returns **403** `untrusted_origin`.
3. **Resolve the caller.** `resolveCaller` validates the session (cookie, API
   key, or JWT) and loads the application access context. No caller → **401**
   `unauthenticated`.
4. **Secure-access decision.** `decideSecureAccess(status, membershipStatus)`
   must return `allow`; a blocked / suspended / inactive caller or membership →
   **403** `forbidden`. A membership in an organization that is not `active`
   never resolves in the first place (F-09, §8.2), so an org admin of a
   suspended tenant is refused here too, and so is a credential bound to one.
5. **Permission + scope check.** The caller must hold the required permission
   **and**, for bearer credentials, the credential's scopes must authorize it
   (`scopesAuthorize` — scopes ⊆ permissions; a key can never out-scope its
   owner). A **superadmin** (§6) passes any admin permission regardless of the
   active org, but a bearer credential they own is still bounded by its scopes.
   A miss audits `administrator.access.denied` (`denied`) and returns **403**.

For an array of permissions, **any one** match satisfies the check (used by the
layout, which only needs "is this caller an admin of some kind").

The pipeline authorizes the **caller**; `[id]` routes then authorize the
**target** in a fixed order right after `resolveTargetUser` (§6, §8.1):
`canAccessUser` (out of scope → 404), then `refuseOutrankingTarget` (the target
outranks a non-superadmin actor → 403 + `admin.user.action_denied`), then the
AUTHZ-2 shared-target rule where the action is account-global. All three run
before the body is parsed or any Better Auth / DB side effect is issued (the
password route included: the rank guard applies before the `mode` is read, so
it covers `set` and `reset_email` alike). The machine API mirrors the same
order — `POST /api/v1/users/[id]/status` applies `canAccessUser` then
`targetOutranksActor` before reaching the shared status core.

`checkAdminPermissionServer(permission)` is the RSC variant: it returns a grant,
`"denied"`, or `"unauthenticated"` so a page/layout can decide whether to call
`notFound()` (§6.2).

---

## 5. Wire contracts

### 5.1 Error envelope

Every admin route returns errors through `adminErrorResponse`
(`src/lib/admin/errors.server.ts`). The body is:

```json
{ "error": "forbidden", "message": "errors.forbidden", "requestId": "5f3c…" }
```

- **`error`** — a machine-readable, snake_case code.
- **`message`** — the i18n key `errors.<code>`; the frontend localizes it via
  `useTranslations("errors")`. This is the **only** user-visible text — backend
  exception messages are never placed here.
- **`requestId`** — the correlation id, also emitted as the `x-request-id`
  response header and written to audit rows (§12).

`extra` fields (e.g. `retryAfter`, `ungrantableScopes`) are merged into the body
when present. For a `status >= 500` with a `cause`, the originating exception is
captured to Sentry tagged with the request id; 4xx responses are not — they are
expected client errors, not incidents. Successful responses echo the request-id
header via `adminJsonResponse`.

Common statuses: `400` invalid body, `401` unauthenticated, `403` forbidden,
`404` not found / out of scope (§6.2), `409` conflict (duplicate key),
`422` invalid scope, `429` rate-limited, `502` upstream identity-provider
failure.

#### List / query semantics

List endpoints share one envelope and one query contract, both implemented in
`src/lib/admin/list-query.server.ts` (§7). The same contract powers CSV export
(§5.2, §19).

### 5.2 CSV export

`GET /api/administrator/export/<resource>` streams a CSV of any list resource
using the **same** filter / sort / `q` contract as the matching list endpoint,
so "Export current view" yields exactly the rows the grid is showing. Mechanics
are detailed in §19 (keyset pagination, org scoping, 100k cap, formula-injection
escaping).

### 5.3 Audit helpers

`src/lib/admin/audit-helpers.server.ts` provides thin per-area wrappers over
`auditEvent` (§12) — `auditUserAction`, `auditRoleAction`, `auditOrgAction` —
that fix the common fields per call-site so handlers stay declarative.

- Helpers **do not swallow errors**; callers MUST `await` them.
- `metadata` MUST NOT include secrets (passwords, tokens, plaintext keys).
- Always pass the `requestId` from the `requireAdminPermission` grant so every
  row a single request writes shares one correlation id.

---

## 6. Access model

### 6.1 Permission catalog

The catalog lives in `src/lib/admin/permissions.ts` as
`ADMIN_PERMISSION_CATALOG` — a single source of truth shared by the runtime
helper and the database seed, so they cannot drift. It holds **35 `admin.*`
keys**, plus the `superuser` marker and the user-level `shell.view` /
`audit.view` markers. `ANY_ADMIN_PERMISSION` is the full set of admin keys, used
by the layout's "any admin" gate.

| Domain | Key | Meaning |
| --- | --- | --- |
| **Users** | `admin.users.read` | Read user lists and details |
| | `admin.users.create` | Create new users |
| | `admin.users.update` | Edit user attributes |
| | `admin.users.delete` | Soft-delete and restore users |
| | `admin.users.manage` | Approve, block, suspend, reactivate users |
| | `admin.users.ban` | Ban / unban via Better Auth |
| | `admin.users.setRole` | Set the Better Auth role on a user |
| | `admin.users.setPassword` | Set or reset a user's password |
| | `admin.users.sessions` | List or revoke user sessions |
| | `admin.users.impersonate` | Impersonate another user (§19) |
| **Roles** | `admin.roles.read` | Read application roles and permissions |
| | `admin.roles.create` | Create application roles |
| | `admin.roles.update` | Edit application roles |
| | `admin.roles.delete` | Delete application roles |
| | `admin.roles.assign` | Assign / unassign roles to users |
| **Groups** | `admin.groups.read` | Read organization groups and their roles/members |
| | `admin.groups.create` | Create organization groups |
| | `admin.groups.update` | Edit organization groups |
| | `admin.groups.delete` | Delete organization groups |
| | `admin.groups.assign` | Manage a group's roles and members |
| **Permissions** | `admin.permissions.manage` | Manage the permission catalog |
| **Organizations** | `admin.orgs.read` | Read organizations and memberships |
| | `admin.orgs.create` | Create organizations |
| | `admin.orgs.update` | Edit organizations |
| | `admin.orgs.delete` | Delete organizations |
| | `admin.orgs.manage` | Manage organization members and bindings |
| **Enterprise apps** | `admin.apps.read` | Read the enterprise application catalog |
| | `admin.apps.manage` | Create and edit enterprise applications |
| **Audit** | `admin.audit.read` | Read the audit event log |
| **Email** | `admin.email.read` | Read the email outbox and templates |
| | `admin.email.manage` | Edit email templates and send test emails |
| **API keys** | `admin.apikeys.read` | Read API keys across users and organizations |
| | `admin.apikeys.manage` | Revoke and manage any user's API keys |
| **OAuth clients** | `admin.clients.read` | Read OAuth client registrations |
| | `admin.clients.manage` | Create, rotate, and revoke OAuth clients |

The `superuser` marker is defined as `SUPERADMIN_PERMISSION`. It is **load-
bearing**: holding it is the *only* thing that bypasses org scoping (§6), checked
explicitly via `isSuperadmin` rather than inferred from "happens to hold every
key". A superuser's authority derives from the marker, so the seeded `superuser`
role no longer enumerates the whole catalog (`SUPERUSER_PERMISSIONS` expands it
at runtime). Machine-API scopes reuse these same keys; a scope ending in `.*`
matches every key under that prefix.

### Three tiers (ADR-0001)

`src/lib/admin/access-scope.server.ts` is the single source of truth for "which
organization may this caller act on". See
[ADR-0001](./architecture.md#access-control-design-decisions) for the full rationale.

| Tier | Identified by | Org boundary |
| --- | --- | --- |
| **SUPERADMIN** | holds the `superuser` marker | none — every org |
| **ORG ADMIN** | holds `admin.*` but **not** `superuser` | their single org (`access.organizationId`) |
| **USER** | no `admin.*` permission | self only |

Key helpers:

- `isSuperadmin(access)` — `access.permissions.includes("superuser")`.
- `resolveOrgScope(access)` → `{ kind: "all" }` (superadmin) | `{ kind: "org",
  organizationId }` (org admin) | `null` (org admin with no resolvable org).
  **`null` means "deny / empty result", never "all".**
- `canAccessOrg(access, resourceOrgId)` — single-resource check for `[id]`
  routes; false → **404** (§6.2). A `null` resource org (platform-level) is
  reachable by superadmin only.
- `canAccessUser(access, appUserId)` — `app_users` has no `organization_id`
  column, so its tenant is its membership; an org admin may act on a user only
  when that user holds a membership in the actor's org.
- `requiresSuperadminForSharedTarget(scope, appUserId)` — account-global actions
  (ban/unban, soft-delete/restore) on a user shared across orgs are reserved for
  a superadmin so the action cannot reach tenants the actor does not administer.
- `userIsGlobalSuperuser(appUserId)` — the global determination used by
  `getUserAccessContext` so an active-org selector can never downgrade a
  superadmin.
- `targetOutranksActor(access, target)` / `refuseOutrankingTarget(guard, target,
  request, action)` (`src/lib/admin/user-target.server.ts`) — **privilege
  ordering** for account-level actions on another user. Scope and the
  shared-target rule say nothing about *rank*: a single-org superadmin passes
  both, so without this an org admin could set that superadmin's password and
  sign in with global authority. A superadmin actor is exempt; otherwise the
  target outranks the actor when the target's effective permissions **in the
  actor's org** (bound-org resolution — never the `active_org` cookie) include
  any permission the actor lacks — which covers a `superuser` holder (expanded
  to the full superuser set, and folded in globally by `userIsGlobalSuperuser`)
  and a more-privileged peer. The same subset test the impersonate guard uses
  (§19). A non-superadmin with no resolvable org fails closed. The comparison
  is over the **whole** effective permission set, not just `superuser` /
  `admin.*`: a plain member who holds a feature permission the org admin lacks
  is also "out of rank" and cannot be banned, suspended, deleted, or have their
  sessions revoked by that admin (fail-closed by design — the same rule the
  impersonate guard applies). If that blocks a legitimate action, grant the
  actor the missing permission or escalate to a superadmin; do not loosen the
  guard.

An org admin **creating** a tenant resource has its `organization_id` forced to
their org; an org admin **issuing a key** may only target a user in their org.

### 6.2 404, not 403, on out-of-scope resources

For `[id]` lookups, a caller who lacks access to a resource in **another** tenant
receives **404**, not 403, so the resource's existence is not leaked. RSC pages
call `notFound()`; API handlers return `adminErrorResponse("not_found", 404,
…)`. This is the standard outcome of a false `canAccessOrg` / `canAccessUser`.

---

## 7. List queries, pagination, and row actions

`parseListQuery` (`src/lib/admin/list-query.server.ts`) normalizes the query
string for every list endpoint into `{ page, pageSize, sort, q, filters }`:

- **`page`** — defaults to 1, clamped to ≥ 1.
- **`pageSize`** — per-endpoint default (commonly 25; audit 50), clamped to
  `[1, maxPageSize]` (commonly 200).
- **`sort`** — repeated `field.dir` values (the separator is `.`, not `:`, to
  keep bookmarked URLs readable). **Unknown sort fields are dropped**; an invalid
  direction falls back to `asc`. A per-endpoint `defaultSort` applies otherwise.
- **`q`** — trimmed global search; empty becomes `null`. Bound via Kysely
  parameters (never string-concatenated) and matched case-insensitively against
  each endpoint's documented columns.
- **`filter[name]=v`** → `filters.name`; repeated values become an array;
  `filter[name][from]` / `[to]` produce a range. **Unknown filters are dropped.**

Allow-listing sort fields and filters is a security property, not just hygiene:
an attacker cannot pivot a query onto an unindexed or unexposed column.

The response envelope (`buildListResponse`) is uniform so the client `DataGrid`
can consume any resource without per-endpoint wiring:

```json
{ "items": [ … ], "page": 1, "pageSize": 25, "total": 42, "sort": [ … ] }
```

The total is computed in the **same scan** as the page via a `count(*) over()`
window column (`windowTotalColumn` + `executeListWithTotal`), avoiding a second
round-trip; a rare past-the-end empty page falls back to a single `count(*)`.

### 7.1 Row actions and selection

Grids support per-row actions and two selection modes (the client state lives in
`_components/grid/use-grid-selection.ts`):

- **page mode** — explicit per-row selection on the current page; the selection
  is the literal set of chosen ids.
- **select-all-matching mode** — selects every row matching the current filter /
  `q`, expressed to the server as `ids: "*"` plus the filter set. The server
  re-applies the **same allow-listed filters** and caps the result, so "select
  all" can never escape the visibility model or pivot to unindexed columns.

Bulk actions and CSV export are surfaced by the grid toolbar
(`_components/grid/data-grid-toolbar.tsx`) and detailed in §13 and §19.

### 7.2 Sortable header accessibility (A11Y-4)

A column is sortable when it declares an `accessorKey` and does not set
`enableSorting: false`; `DataGrid` then wraps its header in the
`DataGridColumnHeader` button. Two rules hold for that button:

- **The accessible name is the column name, and nothing else.** It is computed
  from the rendered header (name-from-content) — the button carries no
  `aria-label`. An `aria-label` overrides the visible text, and the one this
  component used to build collapsed to `"— Not sorted"` for every column,
  because `header` is a function for all of them and the label was only
  composed when `children` was a string. Deriving the name from what is on
  screen cannot drift that way again, and it satisfies WCAG 2.5.3 (Label in
  Name) by construction, so voice control can target the control by the name a
  user can see.
- **The sort state is a separate channel.** `aria-sort` on the wrapping `<th>`
  is the ARIA-designated mechanism (it is not valid on `role=button`), and the
  button additionally points `aria-describedby` at a visually-hidden span for
  assistive technology that under-reports `aria-sort` while focus is on the
  button. That span is `aria-hidden` so it stays out of name-from-content —
  otherwise it would leak the sort state into the `<th>`'s name, which screen
  readers prefix onto every data cell in the column.

Consequently a sortable column **must** render text. Row-action columns have no
`accessorKey`, render their header raw and no button, and may keep
`header: () => ""`. The rule is enforced two ways:
`tests/component/administrator-data-grid.test.tsx` pins the rendering contract
(name, description and `aria-sort` per state) and
`tests/unit/admin-grid-column-label-invariant.test.ts` statically checks every
sortable column definition in every Administrator grid.

---

## 8. Administrator areas

Each area is one or more route groups under `src/app/api/administrator/**` plus
its RSC pages. All endpoints require a cookie session and the noted permission;
mutations are rate-limited (§2.5) and audited (§12). Out-of-scope `[id]` access
returns 404 (§6.2). The committed
[`docs/openapi-admin.json`](./openapi-admin.json) is canonical for exact
request/response shapes.

### 8.0 Overview dashboard

The workspace landing page (`administrator/page.tsx`) — a read-only,
permission-gated summary in three tiers:

1. **Metric cards** (`_components/metric-card.tsx`) — counts for users
   (total / active / pending), organizations, roles, permissions, and
   enterprise apps. Each card is gated on the matching `admin.*.read`
   permission: a card the caller cannot read is hidden entirely **and its
   query never runs**, mirroring the sidebar's gating model (§2.3).
2. **Insight charts** (`_components/metric-bar-chart.tsx`) — most-active
   orgs, daily registrations / logins, and (superadmin-only) audit-event
   volume. Series visibility and scoping are decided server-side by
   `selectDashboardMetrics` (`src/lib/admin/dashboard-metrics.server.ts`),
   shared with `GET /api/administrator/metrics` so the charts and the API
   can never show different data to the same caller.
3. **Recent activity** (`_components/overview-list-card.tsx`) — the latest
   10 registrations, sign-in sessions, audit events, and organizations,
   each gated on its area's read permission. Sessions carry IP addresses,
   so that list gates on `admin.users.sessions`, not the broader
   `admin.users.read`.

Data access lives in `src/lib/admin/overview.server.ts` (pure counting, no
permission checks); the page owns the permissions → slice mapping. Every
slice is bounded by `resolveOrgScope` (ADR-0001): superadmin → system-wide,
org admin → their org only, and a `null` scope renders an empty dashboard
rather than leaking cross-tenant data.

### 8.1 Users

Manages the application user lifecycle and per-user administration.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /users` | `admin.users.read` | List; org-scoped to the actor's org |
| `POST /users` | `admin.users.create` | Create; status defaults to `pending_approval`; `admin.user.created` |
| `GET/PATCH/DELETE /users/[id]` | `.read` / `.update` / `.delete` | Detail, edit, soft-delete / restore. The soft-delete cascade may return 409 `last_superadmin` (REVOKE-2) |
| `POST /users/[id]/status` | `admin.users.manage` | `approve` \| `block` \| `suspend` \| `reactivate`; events `admin.user.approved` / `.blocked` / `.suspended` / `.reactivated`. `block` / `suspend` may return 409 `last_superadmin` (REVOKE-2) |
| `POST /users/[id]/ban`, `/unban` | `admin.users.ban` | Better Auth ban (account-global). A ban also ends the sessions the user opened by impersonating someone (F-08, §19); `admin.user.banned` |
| `POST /users/[id]/password` | `admin.users.setPassword` | Set directly or send reset email. Setting it signs the user out everywhere: their own sessions and the ones they opened by impersonating someone. It also revokes every API key they own and every OAuth client that acts as them, which ends the tokens minted from those too. The reset email changes nothing until the user completes the reset, which does the same (F-08, F-10, §19). A failed step returns 502 and is safe to retry. `admin.user.password_set` / `.password_reset_email_sent`, plus an `api_key.revoked` / `oauth_client.revoked` row per credential with `metadata.reason` `password_set` |
| `POST /users/[id]/role` | `admin.users.setRole` | Set the Better Auth role (`user`/`admin`) |
| `GET/DELETE /users/[id]/sessions`, `…/[sessionId]` | `admin.users.sessions` | List / revoke sessions. The list is a `SessionItem` projection (`id`, timestamps, ip, user-agent, `impersonatedBy`) — the session **token** is never returned; `[sessionId]` is the item's `id`, resolved to the token server-side (review #67/#194). Revoke-all also ends the sessions the user opened by impersonating someone, which belong to the target and are not in this list (F-08, §19). `admin.user.sessions_revoked_all` / `.session_revoked` |
| `POST /users/[id]/impersonate`, `DELETE` (stop) | `admin.users.impersonate` (start only) | See §19 |
| `…/[id]/memberships`, `/app-roles`, `/roles`, `/groups`, `/audit` | per action | User-detail tabs. `PATCH/DELETE …/memberships` are rank-gated, and `DELETE …/app-roles` and `DELETE …/memberships` are conferral-gated (REVOKE-1); both may return 409 `last_superadmin` (REVOKE-2). `DELETE …/memberships` also deletes the user's roles and group memberships in that org (F-12, §8.3) |
| `POST /users/bulk` | per-action key | Batch actions; see §13, §19 |

The Better Auth `role` (`user`/`admin`) is distinct from app roles in
`app_user_roles`. Created passwords are forwarded to Better Auth and never
logged, returned, or placed in audit metadata.

**Target outranks actor (privilege ordering).** Every action that reaches into
*another* user's account — `POST …/password` (both `mode: "set"` and
`mode: "reset_email"`), `POST …/ban`, `…/unban`, `DELETE /users/[id]`
(soft-delete), `POST …/restore`, `POST …/status`, `GET/DELETE …/sessions` and
`DELETE …/sessions/[sessionId]`, plus every `POST /users/bulk` row — calls
`refuseOutrankingTarget` immediately after target resolution (§6). A
**non-superadmin** actor whose target holds any permission they lack (a
superadmin, or a more-privileged peer) receives **403** `forbidden` and an
`admin.user.action_denied` (`denied`, reason `target_outranks_actor`,
`metadata.action`, `requestId`) audit row; nothing is sent to Better Auth or
written to the DB. A superadmin actor is exempt. The check runs **before** the
AUTHZ-2 shared-target rule, which is kept as well. The `reset_email` mode is
rank-gated too: a reset link on an out-ranking target is the first hop of a
two-request chain (trigger the reset, read the live link from the email outbox
with `admin.email.read` (§8.12), set the password), and a superadmin can
self-serve a reset from the sign-in page, so nothing is lost. The machine API
carries the same guard: `POST /api/v1/users/[id]/status` returns a **403**
`forbidden` problem and audits `admin.user.action_denied`
(`metadata.surface: "v1"`) for an out-ranking target, so a bearer credential
cannot do what the console refuses. Self-service `/api/account/*` surfaces are
unaffected.

**Revocation is bounded by the same guards as the grant (REVOKE-1).** The
conferral guard (AUTHZ-3) and the rank guard (§ above, review #7) used to apply
only to paths that *hand out* authority. Four revocation paths had neither, and
a delegated admin of the default organization could use them to dismantle the
platform's own superuser: `DELETE /users/[id]/app-roles`,
`DELETE /roles/[id]/permissions`, `PATCH/DELETE /users/[id]/memberships` and
`PATCH/DELETE /organizations/[id]/members`. They now carry the mirror image of
their grant twin:

- **Conferral symmetry** — `DELETE /users/[id]/app-roles` and
  `DELETE /roles/[id]/permissions` run the AUTHZ-3 subset test
  (`conferrablePermissions` + `unheldPermissionKeys`) against the **removed**
  set. A non-superadmin may only revoke what they could confer; a bearer
  credential is bounded by its scopes and never takes the superadmin fast-path
  (P1-1). **403** `forbidden`, exactly as the POST twin. Since F-12 both
  membership DELETEs run it too, against the roles and group memberships they
  delete with the membership, less what the membership itself implies
  (`shell.view`; §8.3).
- **Rank** — both membership routes call `refuseOutrankingTarget`. The
  org-centric `…/organizations/[id]/members` route never resolves a target
  user, so it resolves the affected members itself and refuses the **whole**
  batch (one unambiguous 403, no half-applied mutation) when any member
  outranks the actor.

**Last superadmin (REVOKE-2).** Global superuser authority is the conjunction of
three revocable rows — an `app_user_roles` assignment, an
`app_role_permissions` link carrying `superuser`, and an **active** membership
pairing them, in an **active** organization (`userIsGlobalSuperuser`; the
organization's status joined the conjunction with F-09) — and no org admin can
confer it back.
`stripsLastGlobalSuperuser` / `wouldStripLastGlobalSuperuser`
(`src/lib/admin/access-scope.server.ts`) is the single predicate: a revocation
that would destroy **every** remaining grant is refused with **409**
`last_superadmin` and an `admin.superuser.revocation_denied` (`denied`, reason
`last_global_superuser`, `metadata.action`) audit row. It is not a "superadmins
are untouchable" rule — a superadmin may still demote a co-superadmin, a
membership PATCH **to** `active` is never gated (it can only add a grant), and a
platform with no such grant today has nothing to protect, so nothing is refused.

It binds the four revocation paths above **and** the account-lifecycle cascades
that move memberships away from `active` by another name. Those cascades are
rank-guarded, but `targetOutranksActor` exempts a superadmin actor outright, so
without the invariant a superadmin could reach the identical unrecoverable state
in one request — including on themselves:

| Path | Where the check lives |
| --- | --- |
| `DELETE /users/[id]/app-roles`, `DELETE /roles/[id]/permissions`, `PATCH\|DELETE /users/[id]/memberships`, `PATCH\|DELETE /organizations/[id]/members` | the route handler |
| `POST /users/[id]/status`, `POST /api/v1/users/[id]/status`, `block`/`suspend` via `POST /users/bulk` | `performAdminStatusChange` (`src/lib/admin-status.server.ts`) — the shared core, so a fourth caller cannot forget it |
| `DELETE /users/[id]`, `soft_delete` via `POST /users/bulk` | inside the soft-delete transaction; the saga's compensating unban runs first, so a refusal leaves the account untouched |
| `PATCH /organizations/[id]` with `status` other than `active` (F-09) | the route handler, in the same transaction as the update. Every grant held in that org stops counting, so suspending the tenant that holds the last ones (out of the box, the default org) is refused. Reactivation is never gated. |

The bulk endpoint reports it as a per-row `last_superadmin` outcome rather than a
status code; `/api/v1` returns the RFC 7807 twin.

**Not covered**, stated so the wording above is not read as wider than it is:

- **`ban` / `unban`.** The invariant is defined on rows, and a ban changes none
  of them — the grant survives and `unban` restores access without re-conferring
  anything. Banning the last superadmin still locks them out of the UI; gating
  that needs a different predicate ("at least one superadmin can still sign in",
  which must also read `app_users.status` and the Better Auth ban flags). Open
  follow-up.
- **Authority conferred through a GROUP.** See §8.3.

**Concurrency.** The check shares the writing transaction, and the grant read
takes `for update of app_user_roles, app_organization_memberships,
app_organizations, app_role_permissions`. The relation list matters: under READ COMMITTED a blocked
`SELECT … FOR UPDATE` re-evaluates its predicate (EvalPlanQual) only for rows of
a **locked** relation that the committing transaction actually changed. Only the
role-assignment revoke writes `app_user_roles`; the membership paths and the
lifecycle cascades write `app_organization_memberships`, and the permission strip
writes `app_role_permissions`. Locking only the assignments would let a second
caller acquire the released lock on an unmodified tuple, skip the recheck, and
still see the other superadmin's membership as `active` in its own pre-commit
snapshot — so two concurrent revocations aimed at two different superadmins could
each conclude that the other survives. With every mutable relation locked, the
recheck drops the row and the second caller is correctly refused. The org status
change writes `app_organizations`, which is why that relation joined the list
with F-09: two superadmins suspending two different tenants, each holding one of
the last two grants, must not each see the other tenant as still active.

**The Better Auth admin plugin's raw HTTP surface is closed.** Every plugin
endpoint (`/api/auth/admin/list-users`, `/set-user-password`,
`/impersonate-user`, `/set-role`, `/remove-user`, …) is mounted on the public
`/api/auth/[...all]` catch-all and, upstream, is gated only by the Better Auth
`admin` role — no permission catalog, no ADR-0001 org scoping, no
privilege-escalation guard, no rate limit, no audit row. A global `hooks.before`
middleware (`src/lib/auth-admin-surface.ts`) therefore returns **404** for any
`/admin/*` request that arrives over HTTP (`ctx.request` set), while the app's
own server-side `auth.api.*` calls (headers only, never `request`;
`src/lib/admin/auth-admin.server.ts`) pass through. The routes in the table
above are the **only** way to reach the plugin, so the app's checks always run.
Consequence for the `admin` role: holding it grants nothing by itself — it is
merely what the plugin's own `hasPermission` requires for the `auth.api.*` calls
those routes make on the actor's behalf. Minting it (`POST /users/[id]/role`)
stays superadmin-only. Never pass `request` to an `auth.api.*` admin call.

**An impersonated session reaches only `/get-session` and `/sign-out` on
`/api/auth/*` (IMP-3, deny-by-default since F-06).** The same `hooks.before`
middleware answers **403** when an impersonated session calls any other mounted
Better Auth endpoint over HTTP, and audits `account.impersonated_access.denied`
against the **impersonator** (the borrowed identity and the endpoint path are in
the metadata). The admin plugin's `/admin/*` (above) and the `disabledPaths`
endpoints (below) answer 404 instead, to every caller and without an audit
row. These endpoints are not `/api/account/*`, so the account guard's default
refusal (§19) never saw them, and Better Auth resolves "the current user" as
the borrowed one. IMP-3 first closed five of them by name (session
listing and revocation, `/update-user`); everything it did not name stayed open
and was attributed to the target — `/list-accounts` then `/get-access-token`
returned the target's provider OAuth tokens, `/unlink-account` stripped a login,
and `/verify-password` and `/change-password` answered password guesses. So the
rule is an allow-list now: `/get-session` (the account panel marks the current
session with it) and `/sign-out` (the admin's way out; **Stop impersonating**
uses the app route below, not Better Auth's endpoint). The app's own
server-side `auth.api.*` calls — e.g. `auth.api.updateUser` behind
`PATCH /api/account/profile` — pass headers and no `request`, so they are
unaffected.

**Vendor endpoints the app never uses are not mounted (F-06).** Better Auth's
`disabledPaths` answers **404** for everyone on `/list-accounts`,
`/get-access-token`, `/refresh-token`, `/account-info`, `/link-social`,
`/unlink-account`, `/verify-password`, `/update-user`, `/update-session`,
`/revoke-sessions`, `/change-email`, `/delete-user` and `/delete-user/callback`
(the list and a reason for each live in `src/lib/auth-admin-surface.ts`).
`tests/security/better-auth-endpoint-classification.test.ts` enumerates every
endpoint the real `auth` instance mounts and fails on any it cannot place — the
admin plugin, the disabled list, the impersonation allow-list, or a reviewed
list of endpoints open to the session's own owner — so a Better Auth upgrade
that adds an endpoint fails CI until someone decides where it belongs.

### 8.2 Organizations

Manages the tenant entity and its memberships.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /organizations` | `admin.orgs.read` | List with member counts; an org admin sees only their own org row |
| `POST /organizations` | `admin.orgs.create` | **Superadmin-only** (the tenant entity); `admin.organization.created` |
| `GET/PATCH/DELETE /organizations/[id]` | `.read` / `.update` / `.delete` | `admin.organization.updated` / `.deleted`; a guarded delete may emit `.delete_blocked`. A PATCH that moves `status` away from `active` may return 409 `last_superadmin` (REVOKE-2, see *Organization status* below) |
| `…/[id]/members` | `admin.orgs.read` / `admin.orgs.update` | Add/update/remove; `admin.organization.member_added` / `.member_updated` / `.members_removed` (+ mirrored `admin.user.membership_*`). PATCH/DELETE are rank-gated (REVOKE-1, whole batch refused with 403) and may return 409 `last_superadmin` (REVOKE-2). DELETE also deletes each member's roles and group memberships in this org and is conferral-gated on them (F-12, §8.3) |
| `…/[id]/provider-bindings` | `admin.orgs.read` / `admin.orgs.update` (POST: + **superadmin**) | IdP org links and email-domain routing; creating one is a platform-wide claim, so POST also requires cross-org reach (F-04) and validates the provider, lowercases an `email` domain and refuses consumer mailbox domains; `admin.organization.provider_bound` / `.provider_bind_denied` / `.provider_unbound` |
| `GET/PATCH/DELETE …/[id]/auth-settings` | `admin.orgs.read` / `admin.orgs.update` | Per-org sign-up policy (0007); GET returns the raw override + the EFFECTIVE resolved policy; PATCH replaces the COMPLETE policy; DELETE reverts to the platform default; `admin.organization.auth_policy_updated` / `.auth_policy_reset` — see [Sign-up Policy](./auth-signup-policy.md) |
| `GET/PATCH /auth-settings/defaults` | `admin.orgs.read` / `.update` + **superadmin** | The platform-default sign-up policy (`organization_id IS NULL`); 403 for org admins; no DELETE (the baseline must always exist); `admin.platform.auth_policy_updated` |
| `GET/POST …/[id]/invitations` | `admin.orgs.read` / `admin.orgs.update` | Organization invitations (0008): paginated list (token hashes never exposed) and create-with-email (outbox-first accept link; 409 `member_exists` / `invitation_exists`, 409 `organization_not_active` while the org is not `active` (F-09), 404 `role_not_found` for a cross-org role; an attached `roleId` is a deferred role assignment under the AUTHZ-3 conferral guard — 403 `forbidden` when the role confers a permission the non-superadmin caller cannot confer, and re-checked against the inviter's current authority at accept time — see [Sign-up Policy §6](./auth-signup-policy.md#6-invitations)); `admin.organization.invitation_created` |
| `DELETE …/[id]/invitations/[invitationId]` | `admin.orgs.update` | Revoke a pending invitation (the link dies immediately); `admin.organization.invitation_revoked` |
| `POST …/[id]/invitations/[invitationId]/resend` | `admin.orgs.update` | Rotate the token + expiry in place and re-send (revives expired-pending); 409 `organization_not_active` while the org is not `active` (the current link is left alone); `admin.organization.invitation_resent` |

Acceptance itself is NOT an administrator surface: invitees land on the public
`/invite?token=…` page, and signed-in users accept via
`POST /api/invitations/accept` (session required — deliberately **not** an
active-membership guard, since activating pending users is the point; the
session's email must equal the invited address). See
[Sign-up Policy §6](./auth-signup-policy.md#6-invitations).

Creating, renaming, and deleting an **organization** is superadmin-only — an org
admin manages the *contents* of their org, not the org record (ADR-0001).

**Organization status is enforced (F-09).** Only an `active` organization
confers anything. While an org is `pending`, `suspended` or `archived`, every
membership in it resolves as if it did not exist
(`getUserAccessContext`, `src/lib/auth-status.ts`), and every surface inherits
that from the one resolver:

- its members and org admins lose the secure shell, the administrator console
  and the account API for it. Someone who belongs only to that org sees the
  pending-approval screen; someone who also belongs to an active org is resolved
  into that one, even if their `active_org` cookie still names the suspended org;
- API keys and OAuth clients **bound** to it stop authenticating, and
  `/api/v1/auth/token` stops minting for them;
- SSO launches stop, since the launch requires a resolved org;
- the org switcher no longer lists it and refuses to switch into it;
- its invitations are dead, and creating or resending one answers 409
  `organization_not_active` (see [Sign-up Policy §6](./auth-signup-policy.md#6-invitations));
- a `superuser` grant held there stops making anyone a platform superadmin
  (`userIsGlobalSuperuser`), including the impersonation reach check.

Nothing is deleted: memberships, roles, credentials and pending invitations are
left as they were, and setting the org back to `active` restores all of it at
once. `pending` behaves like `suspended`.

Superadmins manage a non-active org exactly as before. Loading an org, its
members, providers, sign-up policy and invitations never looks at its status,
so a superadmin can open a suspended tenant and reactivate it from **Settings**.
The one refusal is the lockout guard: a status change away from `active` that
would suspend the platform's **last** superuser grant (out of the box, the
seeded admin's grant in the default org) is refused with 409 `last_superadmin`
(REVOKE-2, §8.1). A superadmin whose own grant lives in the org they suspend
still demotes themselves if other grants survive elsewhere, just as they could by
suspending their own membership. Suspend a tenant from an account whose
authority lives somewhere else.

**Rank does not follow status.** A grant that sleeps in a suspended org comes
back when the org is reactivated, so both rank guards still count it
(`userHoldsSuperuserGrant`): the account-action guard (`targetOutranksActor`)
and the owner-reach bound on the four on-behalf credential paths
(`ownerOutranksActor`: `POST /api-keys`, `POST /api-keys/[id]/rotate`,
`POST /api/v1/admin/oauth-clients` and its `[id]/rotate-secret`). Otherwise a
delegated admin who shares another active tenant with that superuser could, in
the meantime, set their password or mint, rotate or register a credential that
authenticates as them, and hold a platform-superadmin login or credential once
the org is reactivated. The impersonation escalation guards likewise keep
counting authority held in suspended tenants.

### 8.3 Memberships

`GET /api/administrator/memberships` (`admin.orgs.read`) is a read-only cross-org
search of `app_organization_memberships` joined to users and organizations,
scoped to the actor's org. Membership **mutations** happen through the
organization-members and user-memberships sub-routes (§8.2).

**A membership delete takes the member's grants in that org with it (F-12).**
`DELETE /organizations/[id]/members` and `DELETE /users/[id]/memberships`
delete, in the same transaction as the membership row, the user's
`app_user_roles` rows for that org and their `app_group_memberships` in that
org's groups. Neither table references `app_organization_memberships`
(migration `0001-initial-schema.sql`) and nothing cascades, so before F-12 both
routes left those rows behind, invisibly. Re-adding the user
(`POST …/members`, or an invitation they accept) then revived everything they
conferred, `superuser` included, with no conferral check and no audit row: a
junior org admin who could never have conferred those roles got them back to
the user by adding a member. Now a re-added or re-invited user starts with no
roles and no groups in that org.

- **Only that org.** Roles and groups in the user's other orgs are untouched.
  There is no org-less assignment to worry about: `app_user_roles.organization_id`
  is `NOT NULL`, even for a global role, so leaving one org never touches
  authority held in another, including a `superuser` grant held elsewhere.
- **The removal is a revocation, so it is guarded as one.** REVOKE-2 (last
  superadmin) is read first, before anything is deleted. REVOKE-1 then runs the
  AUTHZ-3 subset test on exactly the rows the transaction deleted: a
  non-superadmin may only remove grants they could have conferred, and a bearer
  credential is bounded by its scopes and never takes the superadmin fast-path
  (P1-1). For an org admin at a browser this refuses nothing the rank guard
  (§8.1) does not already refuse; it matters for a bearer key, which the rank
  guard measures against its owner's authority rather than its scopes. A
  refusal is **403** `forbidden` with an `admin.membership.revocation_denied`
  row (`denied`, reason `unheld_permissions`, the refused keys in
  `metadata.unheldPermissions`), and the transaction rolls back: the
  membership and every grant stay. The org-centric route refuses the whole
  batch.
- **What the membership implies is not measured.** No scope can name
  `shell.view`, and every seeded role confers it, so measured like any other
  key it would stop every API key and OAuth token from removing any member
  who holds a role. An active membership implies `shell.view` anyway, so it
  goes with the membership, which the route's own permission authorizes. A
  key outside every scope (a custom app key such as `crm.deals.write`, or
  `audit.view`) is bounded for a bearer credential by what its owner could
  confer: anything, for a superadmin owner, and otherwise only the keys the
  owner holds. That is the rank guard's bound. A key a scope can name
  (every `admin.*` key, including a custom one) and the `superuser` marker stay
  bounded by the credential's scopes, so no bearer credential strips a
  superuser grant. `isScopeNameable` (`src/lib/api-auth/scopes.ts`) and
  `unheldOnMembershipRemoval` (`src/lib/admin/membership-grants.server.ts`)
  hold the rule.
- **Audit.** Each removed role writes `admin.user.role_revoked` and each group
  the member leaves writes `admin.group.members_removed`, the same events the
  single-row routes write, with `metadata.cause: "membership_removed"`. Each
  membership's own row lists the ids it took in `revokedRoleIds` and
  `removedGroupIds`: on the org-centric route that is the per-member
  `admin.user.membership_removed` row (the batch's
  `admin.organization.members_removed` row lists only `membershipIds`); on the
  user-centric route it is the per-org `admin.organization.members_removed`
  row, and the `admin.user.membership_removed` row lists every id removed.

A membership **status** change is different: moving a membership away from
`active` suspends its grants (they stop counting, and REVOKE-2 is read on it)
but keeps the rows, and reactivating the membership brings them back. That is
deliberate, and the rank guard on `PATCH` counts those grants.

**Grants left behind before F-12.** Rows orphaned by a membership delete made
before this change are still there and still revive on re-add. A superadmin can
also assign a role in an org the user does not belong to yet, which takes effect
when the membership is created. To review both, list the assignments and group
memberships that have no membership row in their org, and delete the ones
nobody meant to keep:

```sql
select ur.app_user_id, ur.organization_id, ur.role_id
from app_user_roles ur
where not exists (
  select 1 from app_organization_memberships m
  where m.app_user_id = ur.app_user_id and m.organization_id = ur.organization_id
);

select gm.app_user_id, g.organization_id, gm.group_id
from app_group_memberships gm
join app_groups g on g.id = gm.group_id
where not exists (
  select 1 from app_organization_memberships m
  where m.app_user_id = gm.app_user_id and m.organization_id = g.organization_id
);
```

### 8.4 Roles

Application RBAC roles (`app_roles`). A role is org-scoped (`organization_id`
nullable; `NULL` = a global/platform role, superadmin-only).

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /roles` | `admin.roles.read` | List with permission/member counts; filters `organization`, `scope`, `permission` |
| `POST /roles` | `admin.roles.create` | Org admin may create only within their own org; `admin.role.created` |
| `GET/PATCH/DELETE /roles/[id]` | `.read` / `.update` / `.delete` | Detail / edit / delete |
| `GET/POST/DELETE /roles/[id]/permissions` | `.read` / `.update` | Dual-list permission editor; `admin.role.permissions_changed`. BOTH directions carry the AUTHZ-3 subset test (403 `forbidden`; REVOKE-1 added it to DELETE), and detaching `superuser` from the last role that carries it returns 409 `last_superadmin` (REVOKE-2) |
| `GET /roles/[id]/members` | `admin.roles.read` | Users carrying the role |
| `POST /roles/[id]/duplicate` | `admin.roles.create` | Clone a role |

### 8.5 Permissions

The permission **catalog** (`app_permissions`) is platform-global config,
identical for every tenant.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /permissions` | `admin.roles.read` | List with usage counts (any admin may read it to compose roles) |
| `POST /permissions` | `admin.permissions.manage` | **Superadmin-only**; `admin.permission.created` |
| `PATCH/DELETE /permissions/[id]` | `admin.permissions.manage` | `admin.permission.updated` / `.deleted`; delete is blocked while in use (`.delete_blocked`) |

### 8.6 Groups

Org-scoped cohorts that bundle roles and collect users
([ADR-0002](./architecture.md#access-control-design-decisions)). A user's effective roles =
direct (`app_user_roles`) ∪ group-conferred. Groups grant **roles**, never
permissions directly, so they add zero new authority primitives.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /groups` | `admin.groups.read` | List with role/member counts (org-scoped) |
| `POST /groups` | `admin.groups.create` | Org admin creates only in their org; `admin.group.created` |
| `GET/PATCH/DELETE /groups/[id]` | `.read` / `.update` / `.delete` | `admin.group.updated` / `.deleted`. DELETE carries the AUTHZ-3 subset test against everything the group confers (REVOKE-1, F-11): 403 `forbidden` and an `admin.group.delete_denied` row |
| `GET/POST/DELETE /groups/[id]/roles` | `.read` / `admin.groups.assign` | Bundle roles; `admin.group.roles_changed`. A role must belong to the group's org; bundling a `superuser`-granting role is superadmin-only. **Both** directions carry the AUTHZ-3 subset test (REVOKE-1) |
| `GET/POST/DELETE /groups/[id]/members` | `.read` / `admin.groups.assign` | A user may be added only with an active membership in the group's org; `admin.group.members_added` / `.members_removed`. **Both** directions carry the AUTHZ-3 subset test (REVOKE-1) |

**Group revocation is bounded by the same guard as the grant (REVOKE-1).** The
four routes that take a group-conferred role away —
`DELETE /groups/[id]/roles`, `DELETE /groups/[id]/members`,
`DELETE /users/[id]/groups` and `DELETE /groups/[id]` — and the two membership
deletes, which since F-12 remove the member from that org's groups (§8.3), run
the same
`conferrablePermissions` + `unheldPermissionKeys` subset test their POST twin
does, measured against the permissions the removal destroys (403 `forbidden`; a
bearer credential is bounded by its scopes and never takes the superadmin
fast-path, P1-1). Without it the guard was one-directional: an admin holding
only `admin.groups.assign` could not *build* a high-authority group but could
dismantle one with a single DELETE, and AUTHZ-3 then forbade them from putting
it back.

Deleting the group is the widest of the four (F-11): the cascade removes every
bundled role from every member at once, so it is measured against everything
the group confers, and a refusal is also audited as `admin.group.delete_denied`
(`denied`, reason `unheld_permissions`, the refused keys in
`metadata.unheldPermissions`). A group that bundles no roles confers nothing and
deletes freely. The last-superadmin invariant (REVOKE-2) does not apply here: a
group delete removes only `app_group_roles` and `app_group_memberships` rows,
and REVOKE-2 counts direct assignments alone (see below).
`tests/unit/group-revocation-guard-invariant.test.ts` fails CI when a route
handler deletes group rows without this guard, and pins the reviewed guard on
the deletes whose foreign-key cascade removes group rows (a role delete is
refused while any group bundles the role; a tenant delete is superadmin-only and
needs an empty org).

**Conferring `superuser` through a group is not supported.**
`getUserAccessContext` does union group-conferred roles into the permission set
and expands a bare `superuser` marker to the full superuser set, so inside the
group's org such a principal really does act as a platform superadmin — but
`userIsGlobalSuperuser` (and its rank twin `userHoldsSuperuserGrant`) reads
only direct `app_user_roles`, so they are **not**
a global superuser anywhere rank, machine-credential reach (MACHINE-2) or the
REVOKE-2 last-superadmin invariant is decided. On a platform whose only
superadmin is group-conferred, REVOKE-2 sees zero grants and refuses nothing.
**Confer `superuser` by direct role assignment.** Changing this means teaching
`userIsGlobalSuperuser` and `activeGlobalSuperuserGrants` about
`app_group_roles` in one change, so the two predicates stay identical; until
then the REVOKE-1 guard above is what keeps a delegated admin from building or
dismantling such a group.

### 8.7 Enterprise applications

The SSO-enabled application catalog (`app_enterprise_applications`).

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /enterprise-apps` | `admin.apps.read` | List the catalog |
| `POST /enterprise-apps` | `admin.apps.manage` | `admin.app.created` |
| `GET/PATCH/DELETE /enterprise-apps/[id]` | `.read` / `admin.apps.manage` | `admin.app.updated` / `.deleted`; delete may emit `.delete_blocked` |

`sso_audience` is what a satellite's consume route trusts, so it must be
**unique across the catalog**: `POST` and `PATCH` refuse a value another
application already owns with `409 audience_taken` (the form maps it onto the
audience field). The consumer additionally binds every token to its own
`SSO_HANDOFF_APPLICATION_ID`, so even a colliding audience cannot make one
satellite accept another's tokens. A UNIQUE index is scheduled for a later core
migration; until then the check is route-level (a concurrent create could still
race it).

### 8.8 API keys

The cookie-session governance console for API keys across all users and orgs.
This is the counterpart to the machine `/api/v1/admin/api-keys` surface and
**never returns the secret or its hash**.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /api-keys` | `admin.apikeys.read` | List; filters `status`, `app_user_id`, `organization_id` |
| `POST /api-keys` | `admin.apikeys.manage` | Issue **on behalf of** a user; plaintext returned **once**; `admin.api_key.created` |
| `GET/DELETE /api-keys/[id]`, `POST …/[id]/rotate` | `.read` / `.manage` | Inspect / revoke / rotate (there is no PATCH — a key's name and scopes are immutable; rotate or reissue) |

Requested scopes are validated against the **owner's** authority
(`ungrantableScopes`) — an admin-minted key can never out-scope the user who
will wield it — and against the shared issuance rule (`unissuableScopes`): the
admin may confer only scopes they could grant themselves, and never an
account-writing scope (`account.apikeys.manage`, `account.profile.write`,
`account.preferences.write`) on another person's key — the form does not
offer them. A **rotation** is bound by the same
rule against the key's existing scopes, so an admin can revoke any in-scope
key but can only rotate (and receive) one they could have minted. Minting or
rotating a key whose owner holds a `superuser` grant is refused with **403**
(`owner_outranks_actor`) for anyone but a superadmin at a browser (MACHINE-2),
including when that grant sleeps in a suspended org (§8.2).

### 8.9 OAuth clients

Client-credentials OAuth registrations are governed via the machine surface
`/api/v1/admin/oauth-clients` (`admin.clients.read` / `admin.clients.manage`);
see [api.md §7](./api.md). Secrets are returned once and stored only as hashes.

### 8.10 Audit

`GET /api/administrator/audit` (`admin.audit.read`) is a read-only, paginated
view of `app_audit_events` (§12). Filters: `event_type`, `outcome`, `actor`,
`app_user_id`, `organization_id`, `target_application_id`, and a
`created_at[from|to]` ISO-8601 range. `q` matches `event_type`, `email`, and
`reason`. An org admin sees only their org's events; platform events with a null
org are superadmin-only. The endpoint never returns secret material.

### 8.11 Audit explorer

The audit explorer is the RSC view over §8.10 — the same filter set surfaced as
a grid, with per-row drill-in to the event metadata.

### 8.12 Email

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /email/outbox` | `admin.email.read` | Paginated outbound-email log (org-scoped); **metadata only** — no bodies (review #221) |
| `GET /email/outbox/[id]` | `admin.email.read` | One row with its rendered `body_html` / `body_text`; org-scoped like the list (foreign / org-less row → 404). Bodies are the **redacted** rendering stored at insert time — see below |
| `GET /email/templates` | `admin.email.read` | List editable templates (platform-global catalog) |
| `GET/PUT /email/templates/[id]` | `.read` / `admin.email.manage` | Inspect / edit template content; `admin.email.template_updated` |
| `POST /email/test` | `admin.email.manage` | Send a test email through the outbox pipeline; `admin.email.test_sent` |

**Outbox bodies never carry a live credential (review #21).** Password-reset, email-verification and invitation emails embed a one-time link. `sendAppEmail` stores a **redacted** rendering — the `/reset-password/<token>` path segment and every `token=` query value replaced by `[redacted]` — in `subject` / `body_html` / `body_text` / `variables`, so an org admin holding `admin.email.read` can inspect what was sent to a co-member (a single-org superadmin included) without being able to mint and lift that user's reset link. The real message is delivered from memory on the inline attempt; for a retry it lives only in the DB-only `app_outbox.delivery_payload` column (never selected by any administrator route, nulled once the row is `sent` / `failed`). Consequence for development with no `EMAIL_PROVIDER`: the reset / invite link is no longer readable in the Email workspace — read `delivery_payload` from the database instead (see [Developer onboarding §9.4](./developer-onboarding.md#94-email-in-dev)).

**Why a row can be `failed` (reading the Email workspace).** Three distinct
causes, all visible in the row's `error`:

- **`token_expired: …` (review #90)** — the row carried a one-time link whose
  token had already expired when the retry came due, so it was failed **without**
  a delivery attempt. Delivering it would have handed the recipient a link that
  cannot work. The tokens are short-lived (1h for password reset / email
  verification, 7 days for an invitation) while the serverless drain runs **daily**
  (`vercel.json`), so an inline failure on those templates usually ends here. The
  remedy is the user's own "forgot password" / "resend verification", or the
  invitation **Resend** action — each mints a live token; nothing is re-issued
  automatically by the cron.
- **A permanent provider rejection (review #219)** — a non-retryable 4xx such as
  `422` invalid recipient or `403` unverified sending domain. Terminal on the
  first attempt, because retrying an identical request cannot change the answer.
  Treat a burst of these as a delivery-configuration alarm.
- **Retry budget exhausted** — transient failures (`429`, 5xx, timeouts) up to
  `OUTBOX_MAX_ATTEMPTS`.

### 8.13 MCP agents

The lifecycle console for **self-registered AI agents** (the [MCP agent
gateway](./design-mcp-agent-gateway.md)). An agent is not a new entity — it is
an existing service `app_user` + `mcp` membership + `app_oauth_clients` row — so
this area is a read plus three actions over that surface, org-scoped. Rendered
at `/app/administrator/agents`; nav-gated on `admin.clients.read`.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /mcp-agents` | `admin.clients.read` | Paged list of agents in scope (standard §5.1 envelope: `page` / `pageSize` ≤ 200, `sort=created_at\|name`, `filter[status]=pending\|active\|revoked`) plus a scope-wide `pendingCount`; pending agents always sort first. Each row carries the derived `status`, client id, service-account + client status, and scope ceiling |
| `POST /mcp-agents/[id]/approve` | `admin.clients.manage` | Activate a `pending_approval` service account so it can mint tokens (idempotent); `admin.mcp_agent.approved` |
| `PATCH /mcp-agents/[id]` | `admin.clients.manage` | Set the client's scope **ceiling**, validated against the admin's own authority — and, for a bearer caller, against the calling credential's own scopes, so a narrowly-scoped key or agent token can never lift a ceiling beyond itself (`422` on over-grant); `admin.mcp_agent.scopes_updated` |
| `DELETE /mcp-agents/[id]` | `admin.clients.manage` | Revoke the client (idempotent — leaves the service account for the audit trail); `admin.mcp_agent.revoked` |

Scopes are a **ceiling**, not a grant: per the `permission ∩ scope` invariant a
granted scope is usable only where the service account _also_ holds the matching
permission — assign the service user a role via §8.1 (Users) to make it
effective. The `POST /api/mcp/register` endpoint that creates these agents is
public, lives on the machine surface (audit `mcp.client.registered`), and is
dark unless `MCP_REGISTRATION_ENABLED` — see [Configuration → AI agent gateway
(MCP)](./configuration.md#ai-agent-gateway-mcp) and
[api.md §11](./api.md#11-mcp-agent-gateway-model-context-protocol).

---

## 10. URL as state

For the RSC grids, the **URL is the source of truth** for `page`, `pageSize`,
`sort`, `filters`, and `q` (`_components/grid/use-grid-state.ts`). A grid view is
fully shareable and bookmarkable; the client never holds list state the URL does
not also encode.

---

## 12. Audit model

`auditEvent` (`src/lib/audit.server.ts`) writes one structured row to
`app_audit_events`. Audit logging is **required** for auth failures, status
changes, denied access, and every mutation; the function **surfaces errors to
the caller** (it does not swallow them) so a suppressed failure cannot hide an
attack.

**Outcomes** (`AuditOutcome`):

- **`success`** — the operation completed.
- **`denied`** — authorization (permission / membership / status / origin)
  refused. Written by the pipeline on every deny (§4).
- **`error`** — an unexpected service failure (DB, Better Auth, IO).
- **`failure`** — **deprecated** legacy alias for `error`, kept for historical
  rows. New call sites MUST use `error`.

`error` / `failure` outcomes are additionally mirrored to the structured stdout
logger so a no-Sentry deployment still has a correlated error stream;
`success` / `denied` live in the table only.

**Row fields** include `event_type`, `outcome`, `actor_better_auth_user_id` (the
acting admin — for impersonation this is the **original** admin, never the
impersonated user), `app_user_id`, `organization_id`, `target_application_id`,
`provider`, `email`, `reason`, `request_id` (the §5.1 correlation id), the
trusted-hop `ip_address` and `user_agent`, and a JSON `metadata` blob.

**Impersonation attribution (F-07).** An impersonated session carries the
borrowed identity, so every guard hands its route the **target** as
`betterAuthUserId`. `auditEvent` corrects that itself instead of relying on each
call site: when the request's session is an impersonation, a row whose actor is
the borrowed identity is written with `actor_better_auth_user_id` = the
**impersonating admin** and `metadata.impersonatedBetterAuthUserId` = the
borrowed identity, the shape the impersonation refusals (§8.1, §19) have always
used. This covers the admin console, `/api/v1`, the account and preference
routes, and the RSC denial rows alike. The session read records the
impersonation against the request (`src/lib/impersonation-attribution.server.ts`:
the caller resolver behind every guard, and `getCurrentSession` for the RSC
gate), so a row is attributed whenever it is written with the request that
resolved the session. A row naming some other principal, or none, is left as
written. The same request record keys the per-actor **rate-limit buckets** on
the human. The Better Auth user-id "who" columns a route writes directly also
store the human (`auditEvent` cannot correct those, so each route passes it):
`deactivated_by` (single-row and bulk soft delete), an invitation's
`revoked_by`, and a sign-up policy's `updated_by` (org override and platform
default). The admin test email names the human as its sender too. So the audit explorer, the CSV export and `GET /api/v1/audit-events` show
the admin as the actor, and filtering the explorer by an admin's id finds what
they did while impersonating as well; the borrowed identity is in the row's
metadata (shown in the explorer's detail pane).

**Metadata contract:** callers MUST NOT pass tokens, refresh tokens, plaintext
keys, or raw passwords. Internal exception detail may go in `metadata` (e.g.
`message`) but never secrets.

**Event-type naming.** Per-area, dotted, past-tense for outcomes — for example
`admin.user.created`, `admin.role.permissions_changed`,
`admin.organization.deleted`, `admin.api_key.created`,
`admin.mcp_agent.approved`, `admin.user.impersonation_started`. The pipeline
itself writes
`administrator.access.denied` and `administrator.rate_limited`; the per-target
privilege-ordering guard (§8.1) writes `admin.user.action_denied` with
`reason: "target_outranks_actor"` and the attempted `action` in metadata.

### 12.1 Audit posture (append-only + retention)

The audit log is a tamper-evident compliance record. A row-level
`BEFORE UPDATE OR DELETE` trigger (`app_audit_events_block_mutation`, installed
by `0001-initial-schema.sql` and replaced by `0005-integrity-constraints.sql`)
**raises on any UPDATE or DELETE**; INSERTs are unaffected. The one UPDATE it
permits is the org-deletion `SET NULL` tombstone (organization_id → null with
every other column unchanged).

What the trigger does and does not guarantee (review #83):

- **DELETE is allowed only through the retention function.**
  `app_audit_events_prune(days, batch)` is a `SECURITY DEFINER` function owned
  by the schema owner; `src/lib/retention.server.ts` calls it in batches. The
  trigger lets a DELETE through only when the **effective** role is the table
  owner _and_ the transaction-local marker that function sets is on — the
  marker alone (the pre-0005 escape hatch) no longer suffices, so setting
  `app.audit_retention` from a session connected as the **runtime role** does
  nothing. It still works from a session connected as the **owner** — which is
  what the application does by default, until the operator switches
  `DATABASE_URL` to the runtime role (next bullet); that residual gap is
  documented, tested (`tests/db/schema-integrity.db.test.ts`), and closed only
  by the role switch.
- **The retention window is owner-controlled, not caller-controlled.** The
  function clamps the `days` it is asked for to a floor of **30 days** baked
  into its owner-owned body (and caps each batch at 10 000 rows), so a
  compromised runtime credential calling `app_audit_events_prune(1, …)` in a
  loop cannot erase anything younger than a month; `AUDIT_RETENTION_DAYS`
  below 30 is honoured as 30 (the worker logs the clamp). Shortening the floor
  is a new migration run as the owner, never an application setting.
- **The privilege boundary is the runtime role, not the trigger.** When the
  application connects as the least-privilege `<DB_SCHEMA>_runtime` role
  ([Deployment §8](./deployment.md#8-least-privilege-runtime-role-optional-recommended))
  it holds `INSERT`/`SELECT` only on `app_audit_events` — no `UPDATE`,
  `DELETE` or `TRUNCATE` — and executes the prune function by grant. Until an
  operator switches the runtime to that role, the application still connects
  as the owner, which can disable the trigger like any owner; the trigger then
  guards against accidental or scripted mutation, not against a compromised
  owner credential.

Rejected attempts name the login and effective roles in the error
(`session_user=…, current_user=…`).

---

## 13. Bulk row actions

`POST /api/administrator/users/bulk` applies one action to a batch of users. It
shares the per-row mutation core with the single-row endpoints (§8.1), so both
paths emit identical per-row audit events.

Body: `{ action, ids, reason?, expiresInSeconds?, filters? }` where `action` is
one of `approve | block | suspend | reactivate | ban | unban | soft_delete |
restore`, and `ids` is either an explicit UUID array **or** the literal `"*"`
("select all matching", which **requires** `filters`).

- **Permission per action.** The caller must hold the action's specific key
  (`BULK_USER_ACTION_PERMISSIONS`); a miss → 403 + denied audit.
- **Cap & dedup.** `ids` is capped at **500** (`MAX_BULK_IDS`). Explicit ids are
  **de-duplicated** (a repeated id would otherwise double-audit, inflate counts,
  and re-apply the action — e.g. a second ban resetting the expiry).
- **`"*"` re-applies the allow-listed filters.** Select-all re-runs the same
  filter set the list endpoint uses against `app_users`, capped at 500 — it
  cannot pivot to unindexed columns or escape the visibility model (§7.1).
- **Org scoping.** The batch is confined by `resolveOrgScope` (ADR-0001): a null
  scope touches no one; an org admin's batch is filtered to users with a
  membership in their org, so a foreign-org id simply resolves to `not_found`.
- **Privilege ordering per row.** `executeBulkUserAction` applies
  `targetOutranksActor` to every row before dispatch (§8.1): a row whose target
  outranks a non-superadmin actor resolves to
  `forbidden_target_outranks_actor` and audits `admin.user.action_denied`
  (`bulk: true`, `requestId` = the batch call's `x-request-id`), so neither the
  batch endpoint nor the machine API (`POST /api/v1/users/[id]/status`, which
  carries the same guard) can be used to bypass the `[id]` route guard. The
  AUTHZ-2 `forbidden_shared_target` refusal follows it.
- **Partial failure.** Each row's outcome is captured; one row failing does not
  abort the batch. A summary `admin.users.bulk_action` row is written alongside
  the per-row events. The bulk budget (§2.5) throttles the whole call.

---

## 19. Phase 7 — impersonation, bulk actions, CSV export

### Impersonation

`POST /api/administrator/users/[id]/impersonate` starts a Better Auth
impersonation session as the target user. Cookies are delivered by Better Auth's
`nextCookies` plugin, so the handler returns a plain JSON body.

- Caller MUST hold `admin.users.impersonate`. Self-impersonation is rejected
  (400 `cannot_impersonate_self`).
- **Privilege-escalation guard (IMP-1).** Impersonation grants the actor the
  target's session. A **non-superadmin** actor may not assume a session carrying
  any permission they do not already hold (an org admin cannot impersonate a
  superadmin or a more-privileged peer); a mismatch audits
  `admin.user.impersonation_failed` and returns 403. A superadmin already holds
  every power, so the check is skipped for them. The same subset test guards
  the other account-level actions via `targetOutranksActor` (§6, §8.1).

  The comparison is against the target's authority in **every organization they
  are an active member of** (`permissionKeysHeldInAnyOrg`), not just the actor's
  current one. It used to be single-org, which was sound only if an impersonated
  session were genuinely tenant-confined — and it was not: `active_org` is an
  unsigned cookie that `getUserAccessContext` reads for whichever user the
  session names, i.e. the **target**, so the admin holding the browser could
  rewrite it and land in a tenant this guard never evaluated. The union is
  deliberately conservative: a non-superadmin cannot impersonate someone who
  administers an unrelated tenant. A superadmin can.
- **Per-tenant rank bound (IMP-2).** The union and the confinement below
  measure **different axes** and so do not cover each other: the confinement
  caps *which* tenants a borrowed session may resolve and says nothing about
  rank inside them, while the union compares the target's cross-org total
  against the actor's authority in *one* org. An actor who administers org A
  and is an ordinary role-less member of org B therefore passed the union
  against a target who is a plain member of A and an **admin of B**, and the
  confinement then admitted B. So the guard additionally requires, for every
  organization **both** parties are active members of, that the target hold
  nothing there the actor does not also hold **there**
  (`permissionKeysByActiveOrg`). A mismatch audits
  `admin.user.impersonation_failed` with reason
  `privilege_escalation_in_shared_org` and returns 403. Tenants the actor does
  not belong to are deliberately not judged by this bound — the confinement
  makes them unreachable — with one exception the union is what covers: a
  target who is a **global superuser**, whose marker expands for the principal
  whichever single tenant the session lands in. Do not replace the union with
  this bound.
- **No nested impersonation (F-02).** Impersonation cannot start from an
  impersonated session. When the borrowed identity holds
  `admin.users.impersonate`, `POST /users/[id]/impersonate` returns 403
  `forbidden_while_impersonating` and audits `admin.user.impersonation_failed`
  (outcome `denied`, reason `nested_impersonation`) against the **human**
  impersonator; when it does not, the permission guard refuses first, as it
  would for that user. The
  confinement below is keyed on the session's `impersonatedBy`; a second hop
  would make Better Auth stamp the *borrowed* identity there, re-basing the
  next session on that identity's reach — any tenant the borrowed co-admin
  belongs to and the human does not. The route also requires the cookie
  session Better Auth will act on to be the very principal the guards
  evaluated, on an ordinary session (`session_principal_mismatch` otherwise).
  Stop the current impersonation first.
- **Tenant confinement (IMP-1/IMP-2).** An impersonated session may only
  resolve an organization the **impersonator could already reach as
  themselves** — applied in `getUserAccessContext`, to both the `active_org`
  cookie lookup and the earliest-membership fallback. An empty intersection
  resolves no membership at all (fail closed). Every cookie caller therefore
  resolves its context through `getSessionAccessContext`, which is enforced by
  a source scan (`tests/unit/session-access-context-invariant.test.ts`).

  "Could reach as themselves" is **reach, not membership**
  (`src/lib/impersonation-reach.server.ts`). For every principal but one the
  two are the same thing; the exception is an unbound **global superuser**,
  whose reach is conferred by permission — `canAccessUser` returns true for any
  user, and creating an organization does not enrol the creator, so supporting
  a customer tenant the superadmin does not belong to is the *normal* case.
  Measured by membership rows it produced an empty intersection, i.e. a
  borrowed session with no org, no permissions and not even `shell.view`:
  `pending_approval` everywhere, and a redirect to a page outside the `(secure)`
  group that renders neither the Stop control nor a sign-out button. A
  superadmin impersonator is therefore **unconfined**, which cannot reopen the
  pivot — the attack needs a non-superadmin actor, since a superadmin already
  holds every permission in every organization. Everyone else keeps the
  intersection, and it is measured against an **active account** as well as
  active memberships, so a suspended admin's borrowed session fails closed
  rather than keeping its reach until the session expires. A Better Auth
  **ban** writes none of those rows, so it is checked separately and wins over
  everything, the superadmin exemption included: a banned impersonator reaches
  nothing (F-08).
- **Containing the impersonator ends the borrowed session (F-08).** An
  impersonation session belongs to the **target**: Better Auth stores it under
  the target's user id and names the admin only in `impersonatedBy`, and every
  vendor call that ends "a user's sessions" deletes by user id. So a ban (single
  or bulk), a soft-delete, **Revoke all sessions** or a completed password
  reset used to end the admin's own sessions and leave the one they were
  driving as someone else, which does not appear on the admin's Sessions tab.
  Each of those actions, and `POST …/password` with `mode: "set"`, now also
  deletes every session whose `impersonatedBy` is that admin
  (`revokeSessionsImpersonatedBy`, `src/lib/impersonation-sessions.server.ts`,
  called from the wrappers in `src/lib/admin/auth-admin.server.ts`, from
  `onPasswordReset`, and, since F-10, after a user signs out their other
  sessions). If that delete fails, the admin action reports failure
  (the route's 502 and failure audit row, or a failed row in a bulk batch) so
  the operator retries; every one of these actions is safe to repeat. A
  password reset or a self-service sweep has already done its own work, so
  there the failure is logged instead. Suspending or blocking an admin deletes no sessions, theirs
  or borrowed ones; the reach check above already confines a non-active
  impersonator to nothing.
- **A new password ends everything that used the old one (F-10).**
  Better Auth's `setUserPassword` deletes no session, so `POST …/password`
  with `mode: "set"` used to leave a browser already signed in as the admin
  with that admin's full authority. It now also ends all of the admin's own
  sessions (the same call as **Revoke all sessions**, which includes the ones
  opened as someone else). It also revokes every API key the admin owns and
  every OAuth client that acts as them (`revokeBearerCredentialsOf`,
  `src/lib/api-auth/credential-eviction.server.ts`), because a key minted with
  a stolen cookie would otherwise outlive the new password. A completed
  password reset does the same from `onPasswordReset`, and there a failure is
  logged rather than reported. Credentials the admin minted for **other**
  principals, such as a service user's key, are left alone: they act as someone
  whose password did not change. Find them through the `api_key.created` /
  `oauth_client.created` audit rows whose actor is the admin. Setting an
  admin's own password through this route signs out the session making the
  request too.
- **"Sign out other sessions" reaches the borrowed session (F-10).** When a
  user changes their own password (the form always sends
  `revokeOtherSessions`) or clicks **Sign out other sessions**, Better Auth
  deletes their other sessions by user id. That leaves out any session they
  opened as someone else. The single `hooks.after` in `src/lib/auth.ts`
  (`src/lib/auth-session-sweep.ts`) ends those too, after the sweep succeeded.
  A password *change* does not revoke API keys or OAuth clients: it needs the
  current password, which a cookie thief does not have, and it happens on every
  routine change. A user who thinks the account is compromised should use the
  forgot-password reset, or revoke keys on **Account → API keys**. For the
  operator's side of a leaked key (expiry defaults, kill switches), see
  [API security §6](./api-security.md#6-revocation--incident-response).
- **One hour, hard (F-08).** An impersonation session is refused and deleted
  one hour after it was **created**, at the same chokepoint as
  `SESSION_ABSOLUTE_LIFETIME_HOURS` (`getCurrentSession`), whatever that
  variable says. Better Auth's own one-hour expiry
  (`impersonationSessionDuration`, set to the same constant) is not a bound:
  the plugin skips the rolling refresh only while its signed `dont_remember`
  cookie is present, and a holder who drops that cookie and calls
  `/get-session` has the row extended by 8 hours every 15 minutes. That
  endpoint and `/sign-out` are all the borrowed session reaches in Better Auth
  over HTTP; everything else it can do goes through `getCurrentSession`.
- **The self-service surface is closed while impersonating (IMP-1).** The
  account guard refuses an impersonated session by default, so
  `POST /api/v1/me/api-keys`, `DELETE …/[id]` and `POST …/[id]/rotate` answer
  403 and audit `account.impersonated_access.denied` against the **original
  admin**. Rotation was the sharp edge: ownership passes (the session *is* the
  target), and the re-mint keeps the existing organization and scopes, so an
  admin would have walked away with a standalone bearer credential carrying the
  borrowed user's authority. Routes that neither issue nor destroy credentials
  opt back in explicitly with `{ allowImpersonation: true }`; the key **listing**
  stays available but is confined to the impersonated session's organization.

  That default covers the app's **own** routes only. Better Auth's endpoints
  are mounted on the `/api/auth/[...all]` catch-all and never reach this guard,
  so they are closed separately (see **IMP-3 / F-06** in §8.1). An impersonated
  session reaches only `/get-session` and `/sign-out` there. Every other
  mounted endpoint answers **403** in the `hooks.before` middleware, audited
  against the impersonator. The endpoints in `disabledPaths` (provider tokens,
  account linking, `/verify-password`, …) and the admin plugin's `/admin/*`
  answer **404** to everyone before the session is checked, so they write no
  audit row.
- This route is the **only** path to Better Auth's `impersonateUser` — the raw
  `POST /api/auth/admin/impersonate-user` endpoint is closed (404; see §8.1).
  The plugin is configured with `allowImpersonatingAdmins: true` on purpose:
  Better Auth would otherwise refuse any target holding its `admin` role, which
  org admins hold by design, so a superadmin could not impersonate an org admin
  (a legitimate support action). With the HTTP surface closed, the guard above
  is strictly finer-grained than that blanket block, so the block would only
  add false negatives. Pinned by
  `tests/security/better-auth-admin-http-surface.test.ts`.
- The UI presents a double-confirm; the server cannot enforce that but caps the
  call rate via the mutation bucket so a missing confirm cannot loop.
- Both success and failure are audited, with the **original** admin as the actor
  (`admin.user.impersonation_started`).
- **What the admin does while impersonating is audited against the admin
  (F-07).** Every audit row the impersonated session writes (bans, password
  resets, approvals, role changes, profile edits, v1 calls, denied probes) names
  the impersonating admin as the actor, with the borrowed identity in
  `metadata.impersonatedBetterAuthUserId`. The rate-limit buckets are charged
  to the admin too, so impersonating several users does not give the admin
  several budgets, and the "who" columns (`deactivated_by`, an invitation's
  `revoked_by`, a sign-up policy's `updated_by`) name the admin. See §12.

`DELETE /api/administrator/users/[id]/impersonate` ends impersonation and
restores the original actor's cookies. **The stop endpoint is deliberately NOT
gated on `requireAdminPermission`** — while impersonating, the live session *is*
the target user, usually a plain member with no admin permissions; gating "stop"
on the impersonated identity's permissions would 403 the admin and strand them
in the impersonated view with no way back. Instead, the authority to stop derives
from the session **being** an impersonation session:

- Better Auth set `impersonatedBy` (the original admin) at **start**, which
  already passed the permission and privilege-escalation checks.
- `stopImpersonating` only restores that admin's own session, so there is no
  escalation.
- Stop keeps working even if the admin's impersonate permission was revoked
  mid-session — they must always be able to return to their own account.

The stop path still applies the origin/CSRF guard and the rate limit and audits
with the original actor (`admin.user.impersonation_stopped`). The `[id]` segment
is ignored — the impersonated identity comes from the live session, not the URL.
The UI returns the admin to `/app` (not `/`) after stopping.

### Bulk actions

See §13. Bulk is a Phase 7 capability: dedup of explicit ids, `"*"` select-all
re-applying the allow-listed filters, org scoping, per-row + summary audit, and
the tighter bulk rate-limit budget.

### CSV export

`GET /api/administrator/export/<resource>` streams a CSV using the same query
contract as the matching list endpoint (§5.2). Supported resources: `users`,
`audit`, `organizations`, `roles`, `permissions`, `memberships`,
`enterprise-apps`.

- **Permission.** Caller MUST hold the resource's `read` permission; a miss →
  403 + denied audit. The export rate-limit budget (§2.5) applies.
- **Org scoping (ADR-0001).** The export is confined by `resolveOrgScope`:
  superadmin → all orgs; org admin → their org only; no resolvable org → an empty
  export. The org filter is applied inside every per-resource exporter.
- **Keyset (seek) pagination.** Rows are streamed in pages of 1,000, walked by
  **keyset** pagination on `(…sort, id)` rather than a growing `OFFSET`: each
  page seeks past the previous page's last row, so reading row 99,000 costs the
  same as reading row 0, and the `id` tiebreaker makes the order total so no row
  is dropped or duplicated across a page boundary
  (`applyKeyset` / `buildKeysetSort` / `keysetCursorFrom`).
- **Hard cap.** Exports are capped at **100k rows** (`MAX_EXPORT_ROWS`,
  operator-tunable via `ADMIN_EXPORT_MAX_ROWS`). On truncation the CSV appends a
  `# export_truncated: <limit>` sentinel line (truncation is only known
  mid-stream, after the 200 + headers are sent) which the client strips and
  surfaces as a banner; `X-Export-Limit` carries the cap.
- **CSV-injection escaping.** `csvEscape` neutralizes spreadsheet formula
  injection (CWE-1236): a cell beginning with `=`, `+`, `-`, `@`, or a leading
  control char is prefixed with `'` so it imports as literal text — untrusted
  values such as a user's `display_name` or a recorded `User-Agent` cannot
  execute when the CSV is opened in Excel / Sheets. RFC-4180 quoting is then
  applied.
- A `admin.export.completed` (or `admin.export.failed`) audit row is written so
  ops can answer "who exported the user list at 11:42"; a truncated export is
  recorded as `success` with `truncated: true`.

---

## 20. Operational limits

### 20.1 Hard limits

- Bulk batch size: **500** rows per call (§13).
- CSV export: **100k** rows per call, streamed in 1,000-row pages (§19).
- List page size: capped per-endpoint (commonly **200**) (§7).
- Rate-limit budgets per actor: see §2.5.

---

_Authoritative sources: `src/lib/admin/**` (helpers), `src/app/api/administrator/**`
(handlers), `src/db/migrations/0001-initial-schema.sql` (audit posture — the
audit append-only trigger), [`docs/openapi-admin.json`](./openapi-admin.json) (wire shapes)._
