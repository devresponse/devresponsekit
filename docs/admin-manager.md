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
   `x-request-id` or generates one. It flows onto the response header and every
   audit row this request writes (§5.1, §12).
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
   **403** `forbidden`.
5. **Permission + scope check.** The caller must hold the required permission
   **and**, for bearer credentials, the credential's scopes must authorize it
   (`scopesAuthorize` — scopes ⊆ permissions; a key can never out-scope its
   owner). A **superadmin** (§6) passes any admin permission regardless of the
   active org, but a bearer credential they own is still bounded by its scopes.
   A miss audits `administrator.access.denied` (`denied`) and returns **403**.

For an array of permissions, **any one** match satisfies the check (used by the
layout, which only needs "is this caller an admin of some kind").

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
| `GET/PATCH/DELETE /users/[id]` | `.read` / `.update` / `.delete` | Detail, edit, soft-delete / restore |
| `POST /users/[id]/status` | `admin.users.manage` | `approve` \| `block` \| `suspend` \| `reactivate`; events `admin.user.approved` / `.blocked` / `.suspended` / `.reactivated` |
| `POST /users/[id]/ban`, `/unban` | `admin.users.ban` | Better Auth ban (account-global); `admin.user.banned` |
| `POST /users/[id]/password` | `admin.users.setPassword` | Set directly or send reset email; `admin.user.password_set` / `.password_reset_email_sent` |
| `POST /users/[id]/role` | `admin.users.setRole` | Set the Better Auth role (`user`/`admin`) |
| `GET/DELETE /users/[id]/sessions`, `…/[sessionId]` | `admin.users.sessions` | List / revoke sessions; `admin.user.sessions_revoked_all` |
| `POST /users/[id]/impersonate`, `DELETE` (stop) | `admin.users.impersonate` (start only) | See §19 |
| `…/[id]/memberships`, `/app-roles`, `/roles`, `/groups`, `/audit` | per action | User-detail tabs |
| `POST /users/bulk` | per-action key | Batch actions; see §13, §19 |

The Better Auth `role` (`user`/`admin`) is distinct from app roles in
`app_user_roles`. Created passwords are forwarded to Better Auth and never
logged, returned, or placed in audit metadata.

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

### 8.2 Organizations

Manages the tenant entity and its memberships.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /organizations` | `admin.orgs.read` | List with member counts; an org admin sees only their own org row |
| `POST /organizations` | `admin.orgs.create` | **Superadmin-only** (the tenant entity); `admin.organization.created` |
| `GET/PATCH/DELETE /organizations/[id]` | `.read` / `.update` / `.delete` | `admin.organization.updated` / `.deleted`; a guarded delete may emit `.delete_blocked` |
| `…/[id]/members` | `admin.orgs.read` / `admin.orgs.update` | Add/update/remove; `admin.organization.member_added` / `.member_updated` / `.members_removed` (+ mirrored `admin.user.membership_*`) |
| `…/[id]/provider-bindings` | `admin.orgs.read` / `admin.orgs.update` | IdP org links; `admin.organization.provider_bound` / `.provider_unbound` |
| `GET/PATCH/DELETE …/[id]/auth-settings` | `admin.orgs.read` / `admin.orgs.update` | Per-org sign-up policy (0007); GET returns the raw override + the EFFECTIVE resolved policy; PATCH replaces the COMPLETE policy; DELETE reverts to the platform default; `admin.organization.auth_policy_updated` / `.auth_policy_reset` — see [Sign-up Policy](./auth-signup-policy.md) |
| `GET/PATCH /auth-settings/defaults` | `admin.orgs.read` / `.update` + **superadmin** | The platform-default sign-up policy (`organization_id IS NULL`); 403 for org admins; no DELETE (the baseline must always exist); `admin.platform.auth_policy_updated` |
| `GET/POST …/[id]/invitations` | `admin.orgs.read` / `admin.orgs.update` | Organization invitations (0008): paginated list (token hashes never exposed) and create-with-email (outbox-first accept link; 409 `member_exists` / `invitation_exists`, 404 `role_not_found` for a cross-org role); `admin.organization.invitation_created` |
| `DELETE …/[id]/invitations/[invitationId]` | `admin.orgs.update` | Revoke a pending invitation (the link dies immediately); `admin.organization.invitation_revoked` |
| `POST …/[id]/invitations/[invitationId]/resend` | `admin.orgs.update` | Rotate the token + expiry in place and re-send (revives expired-pending); `admin.organization.invitation_resent` |

Acceptance itself is NOT an administrator surface: invitees land on the public
`/invite?token=…` page, and signed-in users accept via
`POST /api/invitations/accept` (session required — deliberately **not** an
active-membership guard, since activating pending users is the point; the
session's email must equal the invited address). See
[Sign-up Policy §6](./auth-signup-policy.md#6-invitations).

Creating, renaming, and deleting an **organization** is superadmin-only — an org
admin manages the *contents* of their org, not the org record (ADR-0001).

### 8.3 Memberships

`GET /api/administrator/memberships` (`admin.orgs.read`) is a read-only cross-org
search of `app_organization_memberships` joined to users and organizations,
scoped to the actor's org. Membership **mutations** happen through the
organization-members and user-memberships sub-routes (§8.2).

### 8.4 Roles

Application RBAC roles (`app_roles`). A role is org-scoped (`organization_id`
nullable; `NULL` = a global/platform role, superadmin-only).

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /roles` | `admin.roles.read` | List with permission/member counts; filters `organization`, `scope`, `permission` |
| `POST /roles` | `admin.roles.create` | Org admin may create only within their own org; `admin.role.created` |
| `GET/PATCH/DELETE /roles/[id]` | `.read` / `.update` / `.delete` | Detail / edit / delete |
| `GET/POST/DELETE /roles/[id]/permissions` | `.read` / `.update` | Dual-list permission editor; `admin.role.permissions_changed` |
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
| `GET/PATCH/DELETE /groups/[id]` | `.read` / `.update` / `.delete` | `admin.group.updated` / `.deleted` |
| `GET/POST/DELETE /groups/[id]/roles` | `.read` / `admin.groups.assign` | Bundle roles; `admin.group.roles_changed`. A role must belong to the group's org; bundling a `superuser`-granting role is superadmin-only |
| `GET/POST/DELETE /groups/[id]/members` | `.read` / `admin.groups.assign` | A user may be added only with an active membership in the group's org; `admin.group.members_added` / `.members_removed` |

### 8.7 Enterprise applications

The SSO-enabled application catalog (`app_enterprise_applications`).

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /enterprise-apps` | `admin.apps.read` | List the catalog |
| `POST /enterprise-apps` | `admin.apps.manage` | `admin.app.created` |
| `GET/PATCH/DELETE /enterprise-apps/[id]` | `.read` / `admin.apps.manage` | `admin.app.updated` / `.deleted`; delete may emit `.delete_blocked` |

### 8.8 API keys

The cookie-session governance console for API keys across all users and orgs.
This is the counterpart to the machine `/api/v1/admin/api-keys` surface and
**never returns the secret or its hash**.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /api-keys` | `admin.apikeys.read` | List; filters `status`, `app_user_id`, `organization_id` |
| `POST /api-keys` | `admin.apikeys.manage` | Issue **on behalf of** a user; plaintext returned **once**; `admin.api_key.created` |
| `GET/PATCH/DELETE /api-keys/[id]`, `…/[id]/rotate` | `.read` / `.manage` | Inspect / revoke / rotate |

Requested scopes are validated against the **owner's** authority
(`ungrantableScopes`), never the admin's — an admin-minted key can never
out-scope the user who will wield it.

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
| `GET /email/outbox` | `admin.email.read` | Paginated outbound-email log (org-scoped) |
| `GET /email/templates` | `admin.email.read` | List editable templates (platform-global catalog) |
| `GET/PUT /email/templates/[id]` | `.read` / `admin.email.manage` | Inspect / edit template content; `admin.email.template_updated` |
| `POST /email/test` | `admin.email.manage` | Send a test email through the outbox pipeline; `admin.email.test_sent` |

### 8.13 MCP agents

The lifecycle console for **self-registered AI agents** (the [MCP agent
gateway](./design-mcp-agent-gateway.md)). An agent is not a new entity — it is
an existing service `app_user` + `mcp` membership + `app_oauth_clients` row — so
this area is a read plus three actions over that surface, org-scoped. Rendered
at `/app/administrator/agents`; nav-gated on `admin.clients.read`.

| Method & path | Permission | Notes / audit |
| --- | --- | --- |
| `GET /mcp-agents` | `admin.clients.read` | List agents in scope (client id, service-account + client status, scope ceiling) |
| `POST /mcp-agents/[id]/approve` | `admin.clients.manage` | Activate a `pending_approval` service account so it can mint tokens (idempotent); `admin.mcp_agent.approved` |
| `PATCH /mcp-agents/[id]` | `admin.clients.manage` | Set the client's scope **ceiling**, validated against the admin's own authority (`422` on over-grant); `admin.mcp_agent.scopes_updated` |
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

**Metadata contract:** callers MUST NOT pass tokens, refresh tokens, plaintext
keys, or raw passwords. Internal exception detail may go in `metadata` (e.g.
`message`) but never secrets.

**Event-type naming.** Per-area, dotted, past-tense for outcomes — for example
`admin.user.created`, `admin.role.permissions_changed`,
`admin.organization.deleted`, `admin.api_key.created`,
`admin.mcp_agent.approved`, `admin.user.impersonation_started`. The pipeline
itself writes
`administrator.access.denied` and `administrator.rate_limited`.

### 12.1 Audit posture (append-only + retention)

The audit log is a tamper-evident compliance record. `0001-initial-schema.sql`
installs a row-level `BEFORE UPDATE OR DELETE` trigger
(`app_audit_events_block_mutation`) that **raises on any UPDATE or DELETE** —
the application database role cannot silently mutate or remove audit
rows. INSERTs are unaffected.

The single sanctioned exception is the **retention job**
(`src/lib/retention.server.ts`), which sets the transaction-local GUC
`app.audit_retention = 'on'` immediately before pruning rows older than the
retention window; the trigger permits a DELETE only under that flag. (The
folded-in `0005` section also extends the trigger to permit the org-deletion
`SET NULL` tombstone.)
Append-only enforcement therefore lives in the database, independent of any
application-layer discipline.

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
- **Privilege-escalation guard.** Impersonation grants the actor the target's
  session. A **non-superadmin** actor may not assume a session carrying any
  permission they do not already hold (an org admin cannot impersonate a
  superadmin or a more-privileged peer); a mismatch audits
  `admin.user.impersonation_failed` and returns 403. A superadmin already holds
  every power, so the check is skipped for them.
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
