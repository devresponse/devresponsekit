# Administrator (User / Role / Org Manager) — Implementation Plan

> Status: Plan / specification. This document defines the full
> production-grade plan for the **Administrator** application that ships as
> part of the existing `devresponsekit` framework. It does not yet describe
> code that exists in the repository; everything here is to be built per
> this plan.

---

## 1. Goals & scope

### 1.1 Goal

Deliver a production-grade in-app **Administrator** application that gives
holders of `admin.users.manage` (and adjacent admin permissions) a single
place to manage:

- **Users** — Better Auth identity records and the linked `app_users`
  application records (status, roles, sessions, sign-in methods).
- **Roles & Permissions** — application-managed roles in `app_roles`
  with their `app_permissions` mapping and per-organization scoping.
- **Organizations** — `app_organizations`, provider-organization
  bindings, default-org assignment, members and their statuses.
- **Memberships** — `app_organization_memberships` lifecycle (invite /
  approve / suspend / block / remove).
- **Audit** — read-only browser over `app_audit_events` produced by the
  admin actions themselves.
- **Sessions** — list/revoke Better Auth sessions per user via the
  `admin()` plugin.

The application MUST be a real **workspace application** that mounts under
`src/app/[locale]/(secure)/app/administrator`, uses the nested
`ApplicationShell` (workspace shell, distinct from the root shell) and
exposes its own left navigation. All UI is built from shadcn primitives
already present in `src/components/ui/`.

### 1.2 Functional scope

In scope:

1. Full CRUD on Better Auth users via `auth.api` / `authClient.admin.*`.
2. Full CRUD on application objects (roles, permissions, role-permission
   assignments, user-role assignments, organizations, memberships,
   provider-organization bindings, enterprise-application metadata).
3. Advanced grids on every list view: server-side pagination, sorting,
   multi-column filtering, column visibility, density toggle, row
   selection, bulk actions, CSV export.
4. Detail pages for User, Role, Organization with tabbed sections.
5. Action dialogs (approve / block / suspend / reactivate / ban / unban /
   revoke session / impersonate / set-password / set-role) as confirm
   dialogs with reason capture.
6. Audit log explorer.
7. i18n via `next-intl`; locale switcher inherited from root shell.
8. Strict permission gating per page and per action.

Out of scope (explicitly):

- New auth providers (managed by the existing `lib/auth.ts`).
- Schema-changing migrations beyond the existing `0001-app-core.sql`
  (this plan only adds a small read-optimization migration if profiling
  warrants it; see §13).
- MFA management (project-wide decision per `specs.md` §2).
- Email/notification delivery (administrator only triggers status
  changes; downstream notifications are a separate workstream).

### 1.3 Non-functional requirements

| Concern | Requirement |
|---|---|
| Performance | Each list view P95 ≤ 400 ms server time at 100k users / 10k roles per organization. Server pagination only — never load the full set into memory or the browser. |
| Security | Every mutation goes through `applyAdminStatusAction`-style guards (caller must hold `admin.users.manage` or finer-grained permission; deny attempts are themselves audited). |
| Auditing | Every mutation produces an `app_audit_events` row with actor, target, reason, and request metadata. |
| Accessibility | WCAG 2.1 AA. All grids keyboard-navigable; all dialogs trap focus. |
| Internationalization | All strings come from `messages/*.json` under namespace `administrator.*`. |
| Resilience | Optimistic concurrency on user/role/org updates via `updated_at` check; concurrent edits surface a friendly conflict toast. |

---

## 2. Architecture overview

```
src/app/[locale]/(secure)/app/administrator/
├── layout.tsx                # Workspace ApplicationShell (nested)
├── page.tsx                  # Administrator landing / KPIs
├── _components/
│   ├── administrator-sidebar.tsx
│   ├── administrator-breadcrumbs.tsx
│   ├── grid/
│   │   ├── data-grid.tsx
│   │   ├── data-grid-toolbar.tsx
│   │   ├── data-grid-pagination.tsx
│   │   ├── data-grid-column-header.tsx
│   │   ├── data-grid-faceted-filter.tsx
│   │   └── use-grid-state.ts
│   └── confirm-action-dialog.tsx
├── users/
│   ├── page.tsx              # Users list (advanced grid)
│   ├── new/page.tsx          # Create user form
│   └── [userId]/
│       ├── page.tsx          # User detail tabs
│       ├── overview/...
│       ├── roles/...
│       ├── memberships/...
│       ├── sessions/...
│       └── audit/...
├── roles/
│   ├── page.tsx
│   ├── new/page.tsx
│   └── [roleId]/page.tsx     # Role detail (members, permissions)
├── permissions/
│   └── page.tsx              # Read-mostly catalog + assign-to-role flow
├── organizations/
│   ├── page.tsx
│   ├── new/page.tsx
│   └── [orgId]/
│       ├── page.tsx
│       ├── members/page.tsx
│       ├── roles/page.tsx
│       └── provider-bindings/page.tsx
├── memberships/page.tsx       # Cross-org membership search
├── enterprise-apps/page.tsx   # `app_enterprise_applications` admin
└── audit/page.tsx             # Audit explorer
```

### 2.1 Shell composition

- The **root** secure layout (`(secure)/layout.tsx`) already renders the
  outer `ShellContainer`, `TopShellBar`, locale switcher, sign-out, and
  the root `SecureSidebar`. The Administrator app does **not** render a
  second `TopShellBar` (per shell contract — the brand bar lives at root
  depth only; see `application-shell.tsx`).
- `administrator/layout.tsx` renders an `ApplicationShell`
  (`@/components/app-shell/application-shell`) with:
  - `left` = `<AdministratorSidebar/>` — the workspace navigation,
    distinct from the root shell sidebar. Decision: the Administrator
    workspace is fully self-contained and renders its own left rail in
    addition to the root `SecureSidebar` (the two are intentionally
    separate; the root sidebar exposes the application launcher entry,
    the workspace sidebar exposes the in-app navigation).
  - `header` = a slim per-app context bar: breadcrumbs + global search
    box. There is **no** global organization scope picker — every grid
    carries its own per-grid `organization` filter (decision: filtering
    is per-grid only).
  - `children` = the active page's content.
- The nested shell automatically picks up the `data-variant="nested"`
  CSS variables (per `application-shell.tsx`), giving the workspace its
  smaller chrome.
- `administrator/layout.tsx` re-validates that the caller holds at least
  one `administrator.*` permission via `getUserAccessContext` before
  rendering — defense-in-depth on top of the route guard in §6.

### 2.2 Routing

- Path: `/[locale]/app/administrator/...`. This is classified as
  `secure` by `src/config/route-regions.ts` (no change required;
  `/[locale]/app/*` is already secure).
- All admin pages export `export const dynamic = "force-dynamic"` per
  the secure-layout convention.
- All page components are RSC (Server Components) that perform the
  initial query for the grid and pass page-1 data plus query-string
  state to the client `DataGrid`.

### 2.3 Workspace navigation (left sidebar)

`AdministratorSidebar` is a Client Component built from `Sidebar`
(`@/components/ui/sidebar`) and `NavigationMenu` primitives. It reads
the caller's permissions from a small `<AdminAccessProvider>` that is
populated by the layout (server → client via props) so it can hide items
the caller cannot use.

Sidebar groups (every entry localized, every entry permission-gated):

- **Overview** — `administrator/`
- **Identity**
  - Users — `administrator/users` (req: `admin.users.read`)
  - Sessions (cross-user search) — `administrator/users?tab=sessions`
- **Access**
  - Roles — `administrator/roles` (req: `admin.roles.read`)
  - Permissions — `administrator/permissions` (req: `admin.roles.read`)
- **Tenancy**
  - Organizations — `administrator/organizations` (req: `admin.orgs.read`)
  - Memberships — `administrator/memberships` (req: `admin.orgs.read`)
  - Provider bindings — under each organization
- **Apps**
  - Enterprise applications — `administrator/enterprise-apps`
    (req: `admin.apps.read`)
- **Activity**
  - Audit log — `administrator/audit` (req: `admin.audit.read`)

---

## 3. Data model (existing tables only)

The plan reuses tables already defined in
`src/db/schema/app-schema.ts` and the SQL in
`src/db/migrations/0001-app-core.sql`:

- `app_users` — application user; pivoted off `better_auth_user_id`.
- `app_organizations` / `app_provider_organizations`
- `app_organization_memberships`
- `app_roles`, `app_permissions`, `app_role_permissions`,
  `app_user_roles`
- `app_enterprise_applications`
- `app_audit_events`
- `app_user_locale_preferences`

Better Auth tables (`user`, `account`, `session`, `verification`) are
**read** through `authClient.admin.*` / `auth.api.*` only; the
Administrator app never writes to them through Kysely.

A read-optimization migration `0002-administrator-indexes.sql` is delivered up-front (decision: add the indexes from the beginning,
without waiting on profiling evidence) and adds:

- `pg_trgm` extension (`CREATE EXTENSION IF NOT EXISTS pg_trgm`).
- Partial / btree indexes:
  - `app_users (status)`, `app_users (created_at desc)`.
  - `app_audit_events (created_at desc)`,
    `app_audit_events (event_type, created_at desc)`,
    `app_audit_events (actor_better_auth_user_id, created_at desc)`.
  - `app_organization_memberships (app_user_id)`,
    `app_organization_memberships (organization_id, status)`.
  - `app_user_roles (app_user_id)`,
    `app_user_roles (role_id)`.
- Trigram (`pg_trgm`) GIN indexes on `app_users(primary_email)` and
  `app_users(display_name)` for the global search box.

---

## 4. Better Auth `admin()` plugin coverage

The application MUST surface every action exposed by Better Auth's
`admin()` plugin (already enabled in `src/lib/auth.ts`) and the matching
client helpers (already enabled in `src/lib/auth-client.ts` via
`adminClient()`). For each, the plan defines the use case, the UI
surface, the required permission, and where the call is made (server vs.
browser).

| Auth API call | Use case | UI surface | Permission | Caller |
|---|---|---|---|---|
| `admin.listUsers` | Browse all auth users with filters | Users list grid | `admin.users.read` | server (RSC) and client (refresh) |
| `admin.getUser` (via list w/ id filter) | User detail header | User detail page | `admin.users.read` | server |
| `admin.createUser` | Create user with email/password and initial role | "New user" dialog/form | `admin.users.create` | client |
| `admin.updateUser` | Edit name / email / role | User overview tab | `admin.users.update` | client |
| `admin.setRole` | Change Better Auth role (`admin` / `user`) | Inline select on user row + detail | `admin.users.setRole` | client |
| `admin.setUserPassword` | Force-reset password (direct set, or trigger reset email) | "Set password" dialog with two modes: **Set new password** (admin types it) and **Send reset email** (triggers password-reset link via Better Auth) | `admin.users.setPassword` | client |
| `admin.banUser` | Revoke auth access with reason + optional duration | Ban dialog (reason + expires-at) | `admin.users.ban` | client |
| `admin.unbanUser` | Restore auth access | Confirm dialog | `admin.users.ban` | client |
| `admin.removeUser` | **Not used.** v1 uses **soft delete** only — see §4.1 | — | — | — |
| `admin.listUserSessions` | View active sessions for one user | Sessions tab | `admin.users.sessions` | client |
| `admin.revokeUserSession` | Revoke a specific session | Row action | `admin.users.sessions` | client |
| `admin.revokeUserSessions` | Force sign-out everywhere | Sessions toolbar action | `admin.users.sessions` | client |
| `admin.impersonateUser` | Start impersonation session | "Impersonate" action (gated, double-confirm, audited) | `admin.users.impersonate` | client |
| `admin.stopImpersonating` | End impersonation | Banner button | `admin.users.impersonate` | client |
| `admin.hasPermission` | Pre-flight UI gating | Used inside `useAdminAccess()` | n/a | client |

In addition, the Administrator app exposes **application-level**
mutations that are not part of the `admin()` plugin but layer on top of
the same Better Auth users:

- `app_users` status: approve / block / suspend / reactivate
  (already implemented at `/api/admin/users/{approve,block,suspend,reactivate}`).
  Decision: the **legacy console and its endpoints stay unchanged for
  now**. The new Administrator app introduces its own endpoints under
  `/api/administrator/users/[id]/status` that wrap the same shared
  `applyAdminStatusAction` helper; the old endpoints continue to serve
  the legacy console untouched.
- Role assignment in `app_user_roles`.
- Membership lifecycle in `app_organization_memberships`.
- Organization CRUD.
- Role and permission catalog management.

### 4.1 Soft-delete policy (decision)

v1 **never hard-deletes** a Better Auth user. `auth.api.removeUser` is
not called from the Administrator app. "Delete user" instead performs a
two-step soft delete in a single Kysely transaction:

1. `auth.api.banUser({ userId, banReason: "deleted", banExpiresIn: null })`
   — indefinite ban so the user cannot sign in.
2. `update app_users set status = 'deactivated', deactivated_at = now(),
   deactivated_by = <actor>, deactivated_reason = <reason>` (status
   value already supported by the existing schema; if a dedicated
   `deactivated_*` column does not yet exist, the seed migration adds
   it as part of `0002-administrator-indexes.sql`).

A "Restore" action is the inverse (unban + clear status). Audit events
use `event_type = "admin.user.soft_deleted"` /
`"admin.user.restored"`. The `admin.users.delete` permission gates
both.

---

## 5. Server API surface

All admin server APIs live under `src/app/api/administrator/` and follow
the existing `admin-status.server.ts` pattern: validate session →
validate permission → validate body with Zod → mutate in a Kysely
transaction → audit → respond JSON. The legacy
`/api/admin/users/{approve,block,suspend,reactivate}` endpoints remain
untouched (decision: legacy console fate is unchanged for now); the new
endpoints share the underlying `applyAdminStatusAction` helper rather
than calling the legacy HTTP routes.

### 5.1 Conventions

- Methods: `GET` for queries, `POST` for create, `PATCH` for partial
  update, `DELETE` for delete. Bulk endpoints accept a JSON `ids[]`
  array.
- Pagination contract (uniform):

  ```
  GET /api/administrator/<resource>?
    page=1&pageSize=25&
    sort=field:asc&sort=other:desc&
    q=<global-search>&
    filter[status]=active&filter[role]=admin&
    filter[createdAt][from]=2025-01-01&filter[createdAt][to]=2025-12-31
  ```

  Response:

  ```json
  {
    "items": [...],
    "page": 1,
    "pageSize": 25,
    "total": 12345,
    "sort": [{"field":"createdAt","direction":"desc"}]
  }
  ```

- Error contract: `{ "error": "<machine_code>", "message": "<i18n key>" }`.
- All endpoints require `admin.<area>.<verb>` permission and audit on
  both success and denial via `auditEvent()`.
- All endpoints use the shared `requireAdminPermission(request, perm)`
  helper to centralize authz (replaces ad-hoc copies of the check in
  `admin-status.server.ts`).

### 5.2 Endpoints (summary)

| Endpoint | Verbs | Permission | Notes |
|---|---|---|---|
| `/api/administrator/users` | GET | `admin.users.read` | Paginated; joins `app_users` with Better Auth list (page-by-page join, never full table). |
| `/api/administrator/users` | POST | `admin.users.create` | Server-side wrapper around `auth.api.createUser`. |
| `/api/administrator/users/[id]` | GET, PATCH, DELETE | `admin.users.read/update/delete` | PATCH supports name/email/locale; DELETE performs **soft delete only** (indefinite Better Auth ban + `app_users.status = 'deactivated'`); see §4.1. |
| `/api/administrator/users/[id]/restore` | POST | `admin.users.delete` | Inverse of soft delete: unban + clear `deactivated_*`. |
| `/api/administrator/users/[id]/status` | POST | `admin.users.manage` | Wraps existing `applyAdminStatusAction`. |
| `/api/administrator/users/[id]/ban` | POST | `admin.users.ban` | Wraps `auth.api.banUser`; persists reason in `app_audit_events.reason`. |
| `/api/administrator/users/[id]/unban` | POST | `admin.users.ban` | Wraps `auth.api.unbanUser`. |
| `/api/administrator/users/[id]/password` | POST | `admin.users.setPassword` | Body `{ mode: "set", password }` wraps `auth.api.setUserPassword`; body `{ mode: "reset_email" }` triggers a password-reset email via Better Auth. |
| `/api/administrator/users/[id]/role` | POST | `admin.users.setRole` | Better Auth role; separate from app_roles. |
| `/api/administrator/users/[id]/sessions` | GET, DELETE | `admin.users.sessions` | List / revoke-all. |
| `/api/administrator/users/[id]/sessions/[sessionId]` | DELETE | `admin.users.sessions` | Revoke one. |
| `/api/administrator/users/[id]/impersonate` | POST, DELETE | `admin.users.impersonate` | Start / stop. |
| `/api/administrator/users/[id]/app-roles` | GET, POST, DELETE | `admin.roles.assign` | Manages `app_user_roles`. |
| `/api/administrator/users/[id]/memberships` | GET, POST, PATCH, DELETE | `admin.orgs.manage` | Manages `app_organization_memberships`. |
| `/api/administrator/roles` | GET, POST | `admin.roles.read/create` | |
| `/api/administrator/roles/[id]` | GET, PATCH, DELETE | `admin.roles.read/update/delete` | DELETE blocked when role still assigned. |
| `/api/administrator/roles/[id]/permissions` | GET, POST, DELETE | `admin.roles.update` | Manages `app_role_permissions`. |
| `/api/administrator/roles/[id]/members` | GET | `admin.roles.read` | Paginated. |
| `/api/administrator/permissions` | GET | `admin.roles.read` | Read-mostly catalog. |
| `/api/administrator/permissions` | POST, PATCH, DELETE | `admin.permissions.manage` | Optional; deletion blocked when used. |
| `/api/administrator/organizations` | GET, POST | `admin.orgs.read/create` | |
| `/api/administrator/organizations/[id]` | GET, PATCH, DELETE | `admin.orgs.*` | DELETE blocks if non-empty or `is_default`. |
| `/api/administrator/organizations/[id]/members` | GET, POST, PATCH, DELETE | `admin.orgs.manage` | Wraps membership table; bulk supported. |
| `/api/administrator/organizations/[id]/provider-bindings` | GET, POST, DELETE | `admin.orgs.manage` | Manages `app_provider_organizations`. |
| `/api/administrator/memberships` | GET | `admin.orgs.read` | Cross-org search. |
| `/api/administrator/enterprise-apps` | GET, POST | `admin.apps.read/manage` | Manages `app_enterprise_applications`. |
| `/api/administrator/enterprise-apps/[id]` | GET, PATCH, DELETE | `admin.apps.manage` | |
| `/api/administrator/audit` | GET | `admin.audit.read` | Paginated read of `app_audit_events`. Supports range and filter on `event_type`, `outcome`, `actor`, `target`. |
| `/api/administrator/export/<resource>` | GET | corresponding `read` perm | Streams CSV using same filter/sort. Capped at 100k rows. |

### 5.3 Shared server modules

- `src/lib/admin/permissions.server.ts` — `requireAdminPermission()`
  helper consolidating the duplicated check in `admin-status.server.ts`.
- `src/lib/admin/list-query.server.ts` — generic Kysely query builder
  that takes the parsed `ListQuery` (page, sort, filter, q) and applies
  it to a typed `SelectQueryBuilder`. Returns `{ items, total }`.
- `src/lib/admin/audit-helpers.server.ts` — wraps `auditEvent()` with
  per-area shortcuts: `auditUserAction`, `auditRoleAction`,
  `auditOrgAction`.
- `src/lib/admin/auth-admin.server.ts` — thin server-side wrappers over
  `auth.api.*` admin calls so the route handlers stay declarative.

---

## 6. Authorization model

### 6.1 Permission catalog (seeded into `app_permissions`)

Decision: the 24-key catalog below is adopted in full as the v1 set.
Permissions are **platform-wide** (decision: a single privileged user
holding `admin.platform` — or any `admin.*.read/manage` permission —
can see and manage **every** organization, not only orgs they are a
member of). Per-org scoping for non-platform admins is left to a
future iteration.

```
admin.users.read
admin.users.create
admin.users.update
admin.users.delete
admin.users.manage         # legacy, retained — covers status changes
admin.users.ban
admin.users.setRole
admin.users.setPassword
admin.users.sessions
admin.users.impersonate
admin.roles.read
admin.roles.create
admin.roles.update
admin.roles.delete
admin.roles.assign
admin.permissions.manage
admin.orgs.read
admin.orgs.create
admin.orgs.update
admin.orgs.delete
admin.orgs.manage
admin.apps.read
admin.apps.manage
admin.audit.read
```

A **seed** script (`src/db/seeds/seed-admin-permissions.ts`) inserts
these rows idempotently and bundles them into a built-in role
`admin.platform` that is granted to seeded local admin accounts.

### 6.2 Enforcement layers

1. **Route guard** — `administrator/layout.tsx` calls
   `requireSecureSession(...)` then asserts the caller holds **any**
   `admin.*` permission. If not, return `notFound()` so the route is
   indistinguishable from a non-existent page.
2. **Per-page guard** — each page calls `requireAdminPermission(perm)`
   matching the most-restrictive read needed (e.g. `admin.users.read`
   on `/users`).
3. **API guard** — every route handler calls `requireAdminPermission`.
4. **UI gating** — `useAdminAccess()` exposes `can(perm)`; toolbars and
   row actions hide buttons for permissions the caller lacks. This is a
   UX nicety only; the server is the source of truth.
5. **Better Auth `hasPermission`** — for actions that hit the auth
   plugin directly (ban, setRole, etc.), an extra
   `auth.api.userHasPermission` pre-check is performed server-side to
   produce a friendly error before the plugin would itself reject.

---

## 7. Advanced data grids

A reusable `DataGrid` is built once and reused on every list view.
Decision: the grid is implemented on top of **`@tanstack/react-table`**
(headless) — it is the only new runtime dependency introduced by this
plan. The visible UI is composed exclusively from existing shadcn
primitives in `src/components/ui/` (`table`, `pagination`, `popover`,
`command`, `dropdown-menu`, `checkbox`, `calendar`, etc.) so the look
and feel matches the rest of the application by default.

### 7.1 Capabilities

- Server-side **pagination** (page/pageSize) — uses
  `@/components/ui/pagination` for the page bar.
- Server-side **sorting** — multi-column with shift-click; encoded as
  repeating `sort=field:dir` query params.
- Server-side **filtering**:
  - Per-column **text** filter with operators (`contains`,
    `equals`, `startsWith`).
  - Per-column **faceted** filter (multi-select from a fixed set, e.g.
    user status, role) using `@/components/ui/popover` +
    `@/components/ui/command` + `@/components/ui/checkbox`.
  - **Date range** filter using `@/components/ui/calendar` and
    `@/components/ui/popover` (single component
    `DateRangeFacet`).
  - **Global search** input bound to `?q=` (debounced 250 ms).
- **Row selection** with "select all on page" + "select all matching"
  (issues `?ids=*` to the bulk endpoint).
- **Bulk actions** — destructive bulk actions go through
  `ConfirmActionDialog` (`AlertDialog`).
- **Column visibility** menu with persistent per-grid local-storage
  state keyed by `grid:<name>`.
- **Density** toggle (compact / comfortable) — defaults to compact
  inside the secure shell per `specs.md` §28.4.
- **Export** — "Export current view" button emits the same
  filter/sort/q to `/api/administrator/export/<resource>` and downloads
  a CSV.
- **Empty state** built on `@/components/ui/empty`.
- **Loading state** uses `@/components/ui/skeleton` rows.
- **Error state** with retry button; surfaces `error.message` from the
  API contract.
- **Persistence** — pagination, sort, filters, and column visibility
  are reflected in the URL (`useSearchParams`) so views are
  bookmarkable and reload-safe.
- **Keyboard** — full row navigation, `Space` to toggle selection,
  `Enter` to open detail, arrow keys to move, `?` to open shortcut
  help.

### 7.2 Components (under `_components/grid/`)

- `DataGrid<TRow>` — orchestrates state, fetches, renders
  `Table` from `@/components/ui/table`. Internally uses
  `@tanstack/react-table` (`useReactTable`) in **manual** mode for
  pagination/sorting/filtering (server is the source of truth).
- `DataGridToolbar` — search input, faceted filters, density, export,
  column visibility, bulk-actions menu.
- `DataGridPagination` — wraps `Pagination` plus a page-size
  `Select`.
- `DataGridColumnHeader` — clickable sort indicator with
  `DropdownMenu` (sort asc/desc, hide column, filter…).
- `DataGridFacetedFilter` — popover/command-based multi-select.
- `useGridState` — hook that owns the URL ↔ TanStack state mapping
  (`PaginationState`, `SortingState`, `ColumnFiltersState`,
  `VisibilityState`, `RowSelectionState`) and runs the fetch via
  `useEffect` + `AbortController` (no SWR/React Query added).
- `useGridSelection` — selection state wrapper supporting "select all
  matching" mode in addition to TanStack's per-page selection.

### 7.3 Per-grid configuration

Each list page declares:

```ts
{
  name: "administrator.users",
  columns: [...],            // typed column descriptors
  filters: [...],            // filter descriptors with type + options loader
  defaultSort: [{ field: "created_at", direction: "desc" }],
  defaultPageSize: 25,
  rowActions: [...],         // action descriptors (label, icon, perm, onClick, destructive)
  bulkActions: [...],
  fetcher: "/api/administrator/users",
  exporter: "/api/administrator/export/users",
}
```

Column descriptors include `id`, `header` (i18n key), `accessor`,
`sortable`, `filter` (descriptor or `null`), `cell` (render function),
`hiddenByDefault`. This keeps page files small and focused.

---

## 8. Page specifications

All forms use `react-hook-form` + `zod` + `@hookform/resolvers` and the
shadcn `Form` primitives (`@/components/ui/form`). Every dialog uses
`Dialog` or `AlertDialog`. Every confirm-with-reason flow uses
`ConfirmActionDialog`.

### 8.1 Overview (`administrator/page.tsx`)

- Cards (using `Card`) showing:
  - Total users / active / pending / blocked / banned.
  - Total organizations / total roles / total permissions.
  - Latest 10 audit events with link to the explorer.
- Each card is permission-gated; missing permission renders an
  `Empty` placeholder.

### 8.2 Users (`administrator/users/page.tsx`)

Grid columns: avatar+name, email, Better Auth role, app status (badge
via `Badge`), banned (badge), org count, last sign-in, created.
Filters: status, role, banned, organization, created-range, global
search by email/name.
Row actions: view, edit, set role, set password, ban/unban, manage
sessions, impersonate (gated), delete.
Bulk actions: approve, block, ban (with reason), set role, delete.

### 8.3 New user (`administrator/users/new/page.tsx`)

Form fields: name, email, password, Better Auth role
(`user`/`admin`), initial app status (default `pending_approval`),
initial organization, initial app role(s). Submits to
`/api/administrator/users` which calls `auth.api.createUser`, then in
the same transaction inserts membership and `app_user_roles`.

### 8.4 User detail (`administrator/users/[userId]`)

Tabs (built from `@/components/ui/tabs`):

- **Overview** — name, email, locale, app status, status reason,
  banned state, Better Auth role, created/updated. Inline editable
  with `react-hook-form`.
- **Roles** — list of `app_user_roles` per organization, with
  add/remove. Roles loader calls `/api/administrator/roles?orgId=...`.
- **Memberships** — `app_organization_memberships` rows with
  status; row actions: approve, suspend, block, remove, change-status
  (with reason).
- **Sessions** — list from `admin.listUserSessions`; revoke single,
  revoke all.
- **Audit** — read-only grid of `app_audit_events` filtered by
  `app_user_id` or `actor_better_auth_user_id`.

### 8.5 Roles (`administrator/roles/page.tsx`)

Grid: key, name, organization (or "Global"), permission count, member
count, created. Filters: organization, scope (global/org), permission.
Row actions: edit, delete (blocked if assigned), duplicate.

### 8.6 Role detail (`administrator/roles/[roleId]`)

Tabs:

- **Permissions** — dual-list editor (assigned vs available). Drag,
  arrows, search. Built from `@/components/ui/command` and
  `@/components/ui/scroll-area`. Saves diff to
  `/api/administrator/roles/[id]/permissions`.
- **Members** — paginated grid of users carrying this role.
- **Settings** — name, description, organization scope.

### 8.7 Permissions (`administrator/permissions/page.tsx`)

Read-mostly catalog grid. Holders of `admin.permissions.manage` can
add/edit/delete entries (deletion blocked while referenced). Each row
exposes a "Roles using this" drawer (via `Sheet`).

### 8.8 Organizations (`administrator/organizations/page.tsx`)

Grid: slug, name, status, default flag, member count, created.
Row actions: view, edit, mark default, suspend, delete.
Detail page tabs:

- **Overview** — slug/name/status/default flag.
- **Members** — paginated grid with row actions for status,
  add member dialog, bulk remove.
- **Roles** — org-scoped roles grid + create-role.
- **Provider bindings** — list of `app_provider_organizations`
  rows with add/remove (no edit; binding is a tuple).

### 8.9 Memberships (`administrator/memberships/page.tsx`)

Cross-organization search grid useful for support: filter by user,
org, status, source provider; bulk approve/suspend.

### 8.10 Enterprise apps (`administrator/enterprise-apps/page.tsx`)

Manages `app_enterprise_applications`: id, label, origin,
subdomain, sso_audience, status, sort_order, organization scope.
Form validates that `subdomain` is hostname-safe and `origin` is
HTTPS.

### 8.11 Audit (`administrator/audit/page.tsx`)

Paginated grid over `app_audit_events`. Filters: event_type
(faceted from `select distinct`), outcome, actor, app_user_id,
organization_id, target_application_id, date range. Each row opens a
`Sheet` with the full JSON `metadata`, IP, user agent, reason. Read-only.

---

## 9. shadcn/ui component mapping

The Administrator app uses **only** components already present in
`src/components/ui/`:

- Layout: `card`, `tabs`, `separator`, `scroll-area`,
  `resizable`, `sheet`, `dialog`, `alert-dialog`, `drawer`,
  `accordion`, `collapsible`.
- Data: `table`, `pagination`, `badge`, `avatar`, `progress`,
  `chart`.
- Inputs: `input`, `textarea`, `select`, `checkbox`, `radio-group`,
  `switch`, `slider`, `toggle`, `toggle-group`, `combobox` via
  `command` + `popover`, `calendar` for dates, `input-otp` (not
  used), `form` with `field`/`label`.
- Navigation: `navigation-menu`, `breadcrumb`, `menubar`, `kbd`,
  `sidebar`, `dropdown-menu`, `context-menu`, `tooltip`, `hover-card`.
- Feedback: `alert`, `toast`, `toaster`, `sonner`, `spinner`,
  `skeleton`, `empty`, `item`.
- Buttons: `button`, `button-group`.

If a primitive is missing, the component is built locally inside
`administrator/_components/` from existing primitives. The only new
runtime dependency introduced by this plan is **`@tanstack/react-table`**
(headless), per §7. No additional UI library is added.

---

## 10. State management

- URL is the source of truth for grid state (page, pageSize, sort,
  filters, q). On mount, `useGridState` parses search params; on
  change, it pushes to the URL via `useRouter().replace` to keep the
  back stack clean.
- Per-grid local-storage stores only ephemeral preferences (column
  visibility, density).
- No new global Zustand stores are introduced; the existing shell
  store handles density/visibility for the shell itself.
- Server data is re-fetched on URL change; in-flight requests are
  cancelled with `AbortController`. Stale-while-revalidate UI is
  implemented locally without adding SWR/React Query.

---

## 11. Internationalization

- New namespace `administrator` added to **every** locale file under
  `src/messages/` (`en.json`, `es.json`, `fr.json`, `uk.json`).
  Decision: **all four locales ship with complete translations from
  the start** — no English-only placeholders, no machine-translation
  follow-up. Sub-namespaces:
  `administrator.nav`, `administrator.users`, `administrator.roles`,
  `administrator.permissions`, `administrator.orgs`,
  `administrator.memberships`, `administrator.apps`,
  `administrator.audit`, `administrator.grid`,
  `administrator.actions`, `administrator.errors`.
- Status labels (`active`, `pending_approval`, `blocked`, …) live in a
  shared sub-namespace `administrator.status` so badges and filters
  reuse the same keys.
- Date and number formatting via `next-intl` formatters with the
  caller's `preferred_locale`; the dates persisted as `timestamptz` are
  formatted in the user's time zone (read from
  `app_user_locale_preferences.time_zone`, fallback browser tz).

---

## 12. Audit & observability

- Every mutation calls `auditEvent()` with structured fields:
  `event_type` = `admin.<area>.<verb>` (e.g. `admin.role.assigned`),
  `outcome` ∈ `success` / `denied` / `error`, `actor_better_auth_user_id`,
  `app_user_id` (target where applicable), `organization_id`,
  `target_application_id`, `provider`, `email`, `ip_address`,
  `user_agent`, `reason`, `metadata` (free-form JSON capturing the
  diff).
- Denied attempts (permission missing) are audited identically with
  `outcome: "denied"`.
- Impersonation start/stop and ban/unban produce additional events
  with elevated severity and are highlighted in the audit grid.
- A small client-side `<AdministratorErrorBoundary/>` reports unhandled
  render errors via `console.error` and a toast; server errors include
  a request id (`x-request-id` header echoed back in the JSON body) to
  correlate with audit and server logs.

---

## 13. Database access patterns

- All reads use Kysely `selectFrom().select(...)` with explicit column
  lists — no `selectAll()` on user-facing list endpoints (avoid
  shipping unused columns).
- Counts for grids use a separate `select count(*) over () as total`
  trick or a `count` query in the same transaction depending on
  cardinality; `list-query.server.ts` chooses based on the resource.
- Membership/role counts on the user grid use `lateral` subqueries to
  avoid N+1.
- Joins with Better Auth `user` table are not done in SQL (different
  abstraction layer); instead the server fetches the page from
  `auth.api.listUsers`, then in a single Kysely query fetches matching
  `app_users` rows by `better_auth_user_id IN (...)` and merges. This
  keeps Better Auth as the system of record for identity.
- Decision: **no optimistic-concurrency / `If-Match` checks in v1.**
  PATCH/DELETE accept the request and apply last-write-wins. (May be
  re-introduced later if conflicting-edit incidents emerge.)

---

## 14. Security considerations

- All endpoints require an authenticated session and the matching
  `admin.*` permission (§6.2).
- Bodies are validated with Zod; unknown keys rejected
  (`.strict()`).
- Search and filter inputs are passed as bound parameters via Kysely
  (no string concatenation).
- CSV export streams rows; output cells are sanitized to prevent CSV
  injection (`=`, `+`, `-`, `@` at the start of a cell are prefixed
  with `'`).
- Impersonation is gated behind a separate permission, requires
  double-confirm with a reason, is audited as
  `admin.user.impersonation_started` / `..._stopped`, and the active
  impersonation banner is rendered in the workspace header (and root
  shell via existing context).
- Set-password uses Better Auth's API; the new password is never
  logged or echoed; the audit row records only the action and target.
- Bulk endpoints cap at 500 ids per request; larger selections require
  the "select all matching" server-side path that re-evaluates the
  filter on the server.
- Rate-limit hooks: place a simple in-memory token bucket on the
  mutation endpoints (per-IP and per-actor). Pluggable so it can be
  replaced by Redis when needed.
- CSRF is provided by Better Auth's same-site cookies; mutation
  endpoints additionally require an `Origin`/`Referer` header that
  matches a `trustedOrigins` entry.

---

## 15. Performance & scale

1. Server-side pagination only; default page size 25, max 200.
2. Grids never load all rows; CSV export is streamed and capped at
   100k rows with a clear toast.
3. Faceted filter option lists are loaded lazily on popover open.
4. Audit explorer queries always include a date range (defaults to
   last 30 days).
5. The `0002-administrator-indexes.sql` migration (delivered up-front,
   per §3) installs the indexes for hot paths:
   - `app_users (status)`, `app_users (created_at desc)`.
   - `app_audit_events (created_at desc)`,
     `app_audit_events (event_type, created_at desc)`,
     `app_audit_events (actor_better_auth_user_id, created_at desc)`.
   - `pg_trgm` GIN indexes on `app_users.primary_email` and
     `app_users.display_name`.

---

## 16. Accessibility

- All grids are keyboard-navigable; `aria-rowcount`,
  `aria-rowindex`, `aria-sort` attributes are set.
- Sort buttons announce the active sort direction.
- Faceted filters use `role="listbox"` semantics from the underlying
  `Command` primitive.
- Dialogs use `AlertDialog` for destructive actions to ensure the
  destructive button is the focus default.
- Toasts are `role="status"` (non-blocking) or `role="alert"` for
  errors.
- Color is never the sole signal for status; badges include text.
- All tests in `tests/accessibility/` add coverage for the
  Administrator pages (axe + keyboard-only walk).

---

## 17. Test plan

| Layer | Coverage |
|---|---|
| **Unit** (`tests/unit/`) | `list-query.server.ts` parsing & query building; `requireAdminPermission`; CSV escaper; `useGridState` URL round-trip; reducers in `useGridSelection`. |
| **Component** (`tests/component/`) | Each grid renders empty / loading / error / data states; toolbar filters update URL; column visibility persists; bulk actions open `AlertDialog`; create/edit forms validate via zod; user detail tabs render under each permission set. |
| **Integration** (`tests/integration/`) | Each `/api/administrator/*` endpoint: happy path, permission denied (audited), validation error, bulk caps. |
| **Security** (`tests/security/`) | Endpoints reject unauthenticated callers; reject callers missing the required permission; reject cross-origin requests; CSV cells with `=+-@` are escaped; impersonation gated. |
| **E2E** (`tests/e2e/`) | Admin signs in → opens Administrator → searches a user → approves → bans → revokes session → opens audit and finds events. Includes role and org CRUD round-trips. |
| **A11y** (`tests/accessibility/`) | axe pass on landing, users grid, user detail, role detail, audit. Keyboard-only flow to approve a user. |

Coverage gates align with the existing repo policy in `specs.md` §29.

---

## 18. Validation commands

The application MUST pass the standard repo gates already in use:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:unit`
- `pnpm test:component`
- `pnpm test:integration`
- `pnpm test:security`
- `pnpm build` (with `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
  `SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_AUDIENCE_PREFIX` set)
- `pnpm test:e2e` and `pnpm test:a11y` against a `pnpm db:up` +
  `pnpm db:app:migrate` + `pnpm db:auth:migrate` + `pnpm db:seed`
  environment.

---

## 19. Phased delivery (single final PR)

Decision: the work is implemented in the phases below for sequencing
and review clarity, but is delivered as a **single pull request** that
contains every phase. There are no intermediate PRs. Each phase below
must be green (lint + typecheck + tests + build) before moving to the
next inside the working branch.

### Phase 1 — Skeleton, guards & i18n
- Add the complete `administrator.*` namespace with **fully translated
  strings** to `en.json`, `es.json`, `fr.json`, and `uk.json` (decision:
  no English-only placeholders).
- Create `administrator/layout.tsx` (workspace shell), landing page,
  `AdministratorSidebar` with permission gating.
- Add `requireAdminPermission` and migrate
  `admin-status.server.ts` to use it (the legacy
  `/api/admin/users/*` endpoints continue to work unchanged).
- Seed admin permissions catalog (24 keys, §6.1) and the
  `admin.platform` built-in role.

### Phase 2 — DataGrid foundation & indexes
- Add `@tanstack/react-table` dependency.
- Build `DataGrid` and helpers under `_components/grid/` on top of
  `@tanstack/react-table` with shadcn primitives.
- Build `list-query.server.ts` and `/api/administrator/users` GET.
- Build users list page using the new grid.
- Ship `0002-administrator-indexes.sql` (decision: indexes added
  up-front, not deferred).
- Tests: unit for query builder, component for grid, integration for
  GET endpoint.

### Phase 3 — Users module
- POST/PATCH/DELETE for users (DELETE = **soft delete** per §4.1; no
  call to `auth.api.removeUser`).
- Status, ban/unban, password (set / reset-email modes), role,
  sessions, restore endpoints.
- New-user form, user detail tabs (overview, roles, memberships,
  sessions, audit).
- Decision: the legacy `AdminUsersConsole` and its `/api/admin/users/*`
  endpoints remain untouched — the new app lives alongside them.

### Phase 4 — Roles & permissions
- Roles list/detail; permission catalog; role-permission editor;
  role-member grid.

### Phase 5 — Organizations & memberships
- Organization list/detail with member/role/provider-binding tabs;
  cross-org membership search. Platform-admin permissions allow viewing
  and managing **every** organization (§6.1).

### Phase 6 — Enterprise apps & audit explorer
- Enterprise applications grid; audit grid with filters and detail
  sheet.

### Phase 7 — Polish
- Impersonation flow (decision: included in v1, gated by
  `admin.users.impersonate`, double-confirm, audited as
  `admin.user.impersonation_started/_stopped`).
- Bulk actions (cap 500 ids), CSV export (cap 100k rows), "select all
  matching" selection mode, in-memory token-bucket rate limit on
  mutation endpoints.
- Full a11y and e2e suites.

The single final PR ends with a green run of the validation commands
in §18 across all phases combined.

---

## 20. Resolved decisions & remaining future work

### 20.1 Resolved (locked in for v1)

| # | Topic | Decision |
|---|---|---|
| 1 | Legacy `/admin/users` console + `/api/admin/users/*` endpoints | Stay unchanged for now; new app lives alongside |
| 2 | Permission catalog | Adopt the 24 `admin.*` keys in §6.1 |
| 3 | Better Auth role vs. app roles | Surface as two distinct concepts in the UI |
| 4 | Workspace shell | Fully self-contained — its own left rail in **addition** to the root `SecureSidebar` |
| 5 | Path | `/[locale]/app/administrator` |
| 6 | Filtering | Per-grid filters only — **no** global org scope picker |
| 7 | Cross-org visibility | Platform-admin model — privileged users see/manage **all** organizations |
| 8 | Indexes | `0002-administrator-indexes.sql` (incl. `pg_trgm`) shipped up-front in Phase 2 |
| 9 | Optimistic concurrency | **Skipped** for v1 (no `If-Match`) |
| 10 | Impersonation | **Included** in v1, gated + double-confirm + audited |
| 11 | User deletion | **Soft delete only** (§4.1) — never call `auth.api.removeUser` |
| 12 | Set password | Admin can set directly **and** can optionally trigger a password-reset email |
| 13 | Grid library | Adopt `@tanstack/react-table` (headless), styled with shadcn defaults |
| 14 | CSV export cap | 100k rows |
| 15 | Bulk action cap | 500 ids per request; "select all matching" for larger sets |
| 16 | Rate limiting | In-memory token bucket (pluggable for Redis later) |
| 17 | Notifications on status changes | Deferred — no emails in v1 |
| 18 | Audit | Per plan §12 |
| 19 | Delivery | **Single final PR** containing all phases |
| 20 | Localization | All four locales (`en`, `es`, `fr`, `uk`) translated **in full** from Phase 1 |

### 20.2 Remaining future work

- **Notifications** — outbound emails on approve / block / ban /
  password change. Owned by a separate notification workstream.
- **Webhooks** — outbound webhooks for admin events. Out of scope.
- **MFA enrollment** — when MFA is added project-wide
  (`specs.md` §2 currently excludes it), the Sessions tab will surface
  enrolled factors and a reset flow.
- **Per-org admin permissions** — current model is platform-wide. A
  follow-up may introduce per-organization scoping for the `admin.*`
  permissions for delegated org admins.
- **Optimistic concurrency** — re-introduce `If-Match` if conflicting
  edits become a real-world problem.
- **Hard delete / GDPR erasure** — if/when retention requirements
  demand it, layer a true erasure flow on top of the soft-delete state
  introduced in §4.1.

---

*End of plan.*
