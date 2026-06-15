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
9. API-key governance: a cross-user / cross-org inventory of
   `app_api_keys` with full CRUD for administrators — issue a key on
   behalf of a user, inspect scopes and usage, rotate, and revoke
   (soft-delete). Secrets are surfaced exactly once at create/rotate and
   never stored in clear (see §8.12).

Out of scope (explicitly):

- New auth providers (managed by the existing `lib/auth.ts`).
- Schema-changing migrations beyond the consolidated
  `0001-initial-schema.sql` (the administrator indexes and audit columns
  this plan called for are folded into that single schema file; see §3).
- MFA management (project-wide decision per `specs.md` §2).
- Email/notification delivery (administrator only triggers status
  changes; downstream notifications are a separate workstream).

### 1.3 Non-functional requirements

| Concern | Requirement |
|---|---|
| Performance | Each list view P95 ≤ 400 ms server time at 100k users / 10k roles per organization. Server pagination only — never load the full set into memory or the browser. |
| Security | Every mutation goes through `requireAdminPermission` (origin guard → session → status → permission; deny attempts are themselves audited) before reaching the `performAdminStatusChange`-style mutation cores. |
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
- **Communication**
  - Email outbox — `administrator/email` (req: `admin.email.read`)
  - Email templates — `administrator/email/templates`
    (req: `admin.email.read`; editing req: `admin.email.manage`)
- **Activity**
  - Audit log — `administrator/audit` (req: `admin.audit.read`)

---

## 3. Data model (existing tables only)

> **Note:** the application schema is now consolidated into a single
> file, `src/db/migrations/0001-initial-schema.sql`, which provisions
> every `app_*` table, index, and baseline row (the historical
> `0001`–`0006` migrations referenced throughout this document were
> merged into it). A first-time setup needs only that one file — no
> further application migrations.

The plan reuses tables already defined in
`src/db/schema/app-schema.ts` and the SQL in
`src/db/migrations/0001-initial-schema.sql`:

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

The read-optimization indexes are delivered up-front (decision: add the
indexes from the beginning, without waiting on profiling evidence) —
these are now folded into `0001-initial-schema.sql` (there is no separate
`0002` file). They add:

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

- `app_users` status: approve / block / suspend / reactivate, served by
  `/api/administrator/users/[id]/status` and the bulk endpoint, both
  sharing the `performAdminStatusChange` mutation core
  (`src/lib/admin-status.server.ts`).
  > Superseded decision: the original plan kept the legacy console and
  > its `/api/admin/users/*` endpoints alongside the new app. They were
  > **removed** in the security hardening pass — the pages lacked admin
  > permission checks and the endpoints bypassed the guard pipeline.
  > The Administrator app is the only admin surface (§20.1 #1).
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
   value already supported by the existing schema; the `deactivated_*`
   columns are defined in `0001-initial-schema.sql`).

A "Restore" action is the inverse (unban + clear status). Audit events
use `event_type = "admin.user.soft_deleted"` /
`"admin.user.restored"`. The `admin.users.delete` permission gates
both.

---

## 5. Server API surface

All admin server APIs live under `src/app/api/administrator/` and follow
one pipeline: `requireAdminPermission` (origin guard → session → status
→ permission) → validate body with Zod → mutate in a Kysely
transaction → audit → respond JSON. Status transitions share the
`performAdminStatusChange` mutation core in `admin-status.server.ts`
between the per-id `/status` route and the bulk endpoint. (The legacy
`/api/admin/users/{approve,block,suspend,reactivate}` endpoints were
removed — see §20.1 #1.)

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
  helper to centralize authz; mutation helpers like
  `performAdminStatusChange` perform no authorization of their own.

### 5.2 Endpoints (summary)

| Endpoint | Verbs | Permission | Notes |
|---|---|---|---|
| `/api/administrator/users` | GET | `admin.users.read` | Paginated; joins `app_users` with Better Auth list (page-by-page join, never full table). |
| `/api/administrator/users` | POST | `admin.users.create` | Server-side wrapper around `auth.api.createUser`. |
| `/api/administrator/users/[id]` | GET, PATCH, DELETE | `admin.users.read/update/delete` | PATCH body `{ displayName?, preferredLocale? }` (`displayName` mirrors Better Auth `name`; `primary_email` is **not** editable — needs a verification flow). DELETE performs **soft delete only** (indefinite Better Auth ban + `app_users.status = 'deactivated'`); see §4.1. |
| `/api/administrator/users/[id]/restore` | POST | `admin.users.delete` | Inverse of soft delete: unban + clear `deactivated_*`. |
| `/api/administrator/users/[id]/status` | POST | `admin.users.manage` | Shares the `performAdminStatusChange` core with the bulk endpoint. |
| `/api/administrator/users/[id]/ban` | POST | `admin.users.ban` | Wraps `auth.api.banUser`; persists reason in `app_audit_events.reason`. |
| `/api/administrator/users/[id]/unban` | POST | `admin.users.ban` | Wraps `auth.api.unbanUser`. |
| `/api/administrator/users/[id]/password` | POST | `admin.users.setPassword` | Body `{ mode: "set", password }` wraps `auth.api.setUserPassword`; body `{ mode: "reset_email" }` triggers a password-reset email via Better Auth. |
| `/api/administrator/users/[id]/role` | POST | `admin.users.setRole` | Better Auth role; separate from app_roles. |
| `/api/administrator/users/[id]/sessions` | GET, DELETE | `admin.users.sessions` | List / revoke-all. |
| `/api/administrator/users/[id]/sessions/[sessionId]` | DELETE | `admin.users.sessions` | Revoke one. |
| `/api/administrator/users/[id]/impersonate` | POST, DELETE | `admin.users.impersonate` | Start / stop. |
| `/api/administrator/users/[id]/app-roles` | GET, POST, DELETE | `admin.roles.assign` | Manages `app_user_roles`. |
| `/api/administrator/users/[id]/memberships` | GET, POST, PATCH, DELETE | `admin.users.read` (GET) / `admin.users.update` (writes) | Manages `app_organization_memberships` for one user. |
| `/api/administrator/roles` | GET, POST | `admin.roles.read/create` | |
| `/api/administrator/roles/[id]` | GET, PATCH, DELETE | `admin.roles.read/update/delete` | DELETE blocked when role still assigned. |
| `/api/administrator/roles/[id]/permissions` | GET, POST, DELETE | `admin.roles.update` | Manages `app_role_permissions`. |
| `/api/administrator/roles/[id]/members` | GET | `admin.roles.read` | Paginated. |
| `/api/administrator/permissions` | GET | `admin.roles.read` | Read-mostly catalog. |
| `/api/administrator/permissions` | POST | `admin.permissions.manage` | Create a catalog key. |
| `/api/administrator/permissions/[id]` | GET, PATCH, DELETE | `admin.permissions.manage` | Edit/delete a key; deletion blocked (`409 permission_in_use`) when assigned. |
| `/api/administrator/organizations` | GET, POST | `admin.orgs.read/create` | |
| `/api/administrator/organizations/[id]` | GET, PATCH, DELETE | `admin.orgs.*` | DELETE blocks if non-empty or `is_default`. |
| `/api/administrator/organizations/[id]/members` | GET, POST, PATCH, DELETE | `admin.orgs.read` (GET) / `admin.orgs.update` (writes) | Wraps membership table; bulk supported. |
| `/api/administrator/organizations/[id]/provider-bindings` | GET, POST, DELETE | `admin.orgs.read` (GET) / `admin.orgs.update` (writes) | Manages `app_provider_organizations`. |
| `/api/administrator/memberships` | GET | `admin.orgs.read` | Cross-org search. |
| `/api/administrator/enterprise-apps` | GET, POST | `admin.apps.read/manage` | Manages `app_enterprise_applications`. |
| `/api/administrator/enterprise-apps/[id]` | GET, PATCH, DELETE | `admin.apps.read` (GET) / `admin.apps.manage` (writes) | |
| `/api/administrator/api-keys` | GET | `admin.apikeys.read` | Paginated read of `app_api_keys` joined to owner email. Filter on `status`, `app_user_id`, `organization_id`; `q` matches name/prefix/owner email. Never returns the secret or hash. |
| `/api/administrator/api-keys` | POST | `admin.apikeys.manage` | Issues a key **on behalf of** a user. Requested scopes are validated against the **owner's** authority (`ungrantableScopes`), never the admin's. Returns the plaintext once. |
| `/api/administrator/api-keys/[id]` | GET, DELETE | `admin.apikeys.read` / `admin.apikeys.manage` | GET resolves owner/creator/revoker emails. DELETE **revokes** (soft-delete: `status='revoked'` + actor/reason); idempotent, never hard-deletes (the row is the usage/audit trail). |
| `/api/administrator/api-keys/[id]/rotate` | POST | `admin.apikeys.manage` | Atomically issues a new secret (same owner/scopes/expiry) and revokes the old key. Returns the new plaintext once. |
| `/api/administrator/audit` | GET | `admin.audit.read` | Paginated read of `app_audit_events`. Supports range and filter on `event_type`, `outcome`, `actor`, `target`. |
| `/api/administrator/email/outbox` | GET | `admin.email.read` | Paginated read of `app_outbox`. Filter on `status`, `template_key`. |
| `/api/administrator/email/templates` | GET | `admin.email.read` | Full editable-template list (`app_email_templates`). |
| `/api/administrator/email/templates/[id]` | GET, PUT | `admin.email.read` / `admin.email.manage` | Edit subject/bodies/description; `key` and `locale` immutable. |
| `/api/administrator/email/test` | POST | `admin.email.manage` | Sends the `test_email` template through the outbox pipeline. |
| `/api/administrator/export/<resource>` | GET | corresponding `read` perm | Streams CSV using same filter/sort. Capped at 100k rows. |

### 5.3 Shared server modules

- `src/lib/admin/permissions.server.ts` — `requireAdminPermission()`
  helper centralizing authorization for every administrator entry point.
- `src/lib/admin-status.server.ts` — `performAdminStatusChange()`, the
  shared status-mutation core (no authorization of its own; callers
  gate via `requireAdminPermission`).
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

Decision: the 30-key catalog below is adopted in full as the v1 set.
(The catalog grew over time: 24 keys originally, +2 for email, +4 for
machine credentials — the single source of truth is
`ADMIN_PERMISSION_CATALOG` in `src/lib/admin/permissions.ts`; do not
hard-code a count elsewhere.)
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
admin.orgs.manage         # defined; member/binding writes currently gate on admin.orgs.update
admin.apps.read
admin.apps.manage
admin.audit.read
admin.email.read           # read the email outbox and templates
admin.email.manage         # edit email templates, send test emails
admin.apikeys.read         # read API keys across users and organizations
admin.apikeys.manage       # revoke and manage any user's API keys
admin.clients.read         # read OAuth client registrations
admin.clients.manage       # create, rotate, and revoke OAuth clients
```

The single `0001-initial-schema.sql` defines all 30 keys (including the
four machine-credential keys `admin.apikeys.*` / `admin.clients.*`) and
grants the full catalog to `superuser`; the seed re-grants the catalog to
`admin.platform`. The credential keys govern the `/api/v1/admin/api-keys`
and `/api/v1/admin/oauth-clients` endpoints (see specs.md §37).

The catalog rows are seeded by `0001-initial-schema.sql` and bundled into
the `superuser` role. The local seed script
(`src/db/seeds/seed-local.ts`) then re-grants the full catalog to the
built-in `admin.platform` role (and adds the two user-level keys
`shell.view` / `audit.view`) before granting `admin.platform` to seeded
local admin accounts.

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

### 8.12 API keys (`administrator/api-keys/page.tsx`)

Governance console for `app_api_keys` across every user and
organization. Complements the self-service `/api/v1/me/api-keys`
surface (where a user manages their own keys) and the machine
`/api/v1/admin/api-keys` read endpoint with a cookie-session,
permission-gated **CRUD** UI.

- **Read** — paginated `DataGrid` (columns: name, prefix, owner,
  scope count, status, last-used, expires, created) with a status +
  owner/search filter toolbar. Every row opens a `Sheet` showing the
  resolved owner / creator / revoker, the full scope list, usage (last
  used at / IP), and revoke metadata. The secret and hash are **never**
  in list or detail payloads.
- **Create** — `api-keys/new` issues a key on behalf of a user
  (`admin.apikeys.manage`). The owner is identified by application user
  id; scopes are picked from the catalog the server passes down and are
  re-validated server-side against the **owner's** authority so an
  admin-minted key can never out-scope the user who wields it. The
  plaintext is revealed exactly once via a copy dialog.
- **Update (rotate)** — re-issues the secret with the same owner,
  scopes, and expiry and revokes the old key atomically. New plaintext
  shown once.
- **Delete (revoke)** — soft-delete: flips `status` to `revoked` and
  stamps actor/reason. Idempotent; never hard-deletes, because the row
  is the audit/usage trail and verification rejects revoked keys
  immediately.

Manage actions (create / rotate / revoke) are hidden for read-only
admins (`admin.apikeys.read` without `admin.apikeys.manage`) and
re-checked on every route. See [api-and-cli-guide.md](api-and-cli-guide.md)
for the credential model these keys authenticate against.

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
- API-key governance emits `admin.api_key.created`,
  `admin.api_key.revoked`, and `admin.api_key.rotated`. Metadata carries
  the key id, owner, scopes, and display prefix only — **never** the
  plaintext or hash.
- A client-side error boundary
  ([`(secure)/app/error.tsx`](../src/app/[locale]/(secure)/app/error.tsx))
  catches unhandled render errors across every authenticated workspace,
  shows a localized fallback with a quotable **Support ID**, and captures
  the error to Sentry when observability is enabled. Server errors include
  a request id (`x-request-id` header echoed back in the JSON body) to
  correlate with audit, server logs, and the Sentry issue. See
  [observability.md](observability.md).

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
5. The administrator indexes (folded into `0001-initial-schema.sql`,
   per §3) cover the hot paths:
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
  `DATABASE_URL`, `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_JWT_SECRET`,
  `SSO_HANDOFF_AUDIENCE_PREFIX` set)
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
  `/api/admin/users/*` endpoints continued to work at this phase; they
  were later removed — see §20.1 #1).
- Seed admin permissions catalog (§6.1, 24 keys at this phase; the two
  `admin.email.*` keys were added later with the email subsystem) and the
  `admin.platform` built-in role.

### Phase 2 — DataGrid foundation & indexes
- Add `@tanstack/react-table` dependency.
- Build `DataGrid` and helpers under `_components/grid/` on top of
  `@tanstack/react-table` with shadcn primitives.
- Build `list-query.server.ts` and `/api/administrator/users` GET.
- Build users list page using the new grid.
- Ship the administrator indexes (decision: added up-front, not
  deferred; now folded into `0001-initial-schema.sql`).
- Tests: unit for query builder, component for grid, integration for
  GET endpoint.

### Phase 3 — Users module
- POST/PATCH/DELETE for users (DELETE = **soft delete** per §4.1; no
  call to `auth.api.removeUser`).
- Status, ban/unban, password (set / reset-email modes), role,
  sessions, restore endpoints.
- New-user form, user detail tabs (overview, roles, memberships,
  sessions, audit).
- Decision (superseded): the legacy `AdminUsersConsole` and its
  `/api/admin/users/*` endpoints remained untouched during this phase;
  both were later removed in the security hardening pass — see
  §20.1 #1.

### Phase 4 — Roles & permissions
- Build the roles endpoints under `/api/administrator/roles` per §5.2:
  - `GET /api/administrator/roles` — `admin.roles.read`. Paginated via
    `list-query.server.ts`; filters: organization, scope (global/org),
    permission key, global search by `key`/`name`.
  - `POST /api/administrator/roles` — `admin.roles.create`. Validates
    uniqueness of `(organization_id, key)` (and global uniqueness of
    `key` when `organization_id IS NULL`).
  - `GET / PATCH / DELETE /api/administrator/roles/[id]` —
    `admin.roles.read|update|delete`. DELETE returns the standard error
    contract from §5.1 with code `role_in_use` (HTTP 409) when the role
    is still referenced by `app_user_roles`.
  - `GET / POST / DELETE /api/administrator/roles/[id]/permissions` —
    `admin.roles.update`. POST/DELETE accept an `{ ids: string[] }`
    body so the dual-list editor (§8.6) can persist its add/remove diff
    in two atomic Kysely transactions. Both transactions audit as
    `admin.role.permissions_changed` with the resulting permission set
    captured in `app_audit_events.metadata`.
  - `GET /api/administrator/roles/[id]/members` — `admin.roles.read`.
    Paginated grid feed of users carrying the role, joined with
    `app_users` and the user's organization membership.
  - `POST /api/administrator/roles/[id]/duplicate` — `admin.roles.create`.
    Server-side clone: in a single Kysely transaction, inserts a new
    `app_roles` row (key suffixed with `-copy` and de-duplicated) and
    copies every `app_role_permissions` entry from the source role.
    Audited as `admin.role.duplicated` with `{ sourceRoleId }` in the
    event metadata.
- Build the permissions catalog endpoints under
  `/api/administrator/permissions` per §5.2:
  - `GET` — `admin.roles.read`. Paginated read of `app_permissions`
    with a `usedByRoleCount` aggregate so the grid can render the
    "Roles using this" column without N+1 queries.
  - `POST / PATCH / DELETE` — `admin.permissions.manage`. DELETE is
    blocked with code `permission_in_use` (HTTP 409) when the row is
    referenced by any `app_role_permissions` entry.
- Build the user → role assignment endpoints used by the User detail
  "Roles" tab (the tab UI ships in Phase 3 but its data endpoints land
  here because they are a roles concern):
  - `GET / POST / DELETE /api/administrator/users/[id]/app-roles` —
    `admin.roles.assign`. Mutations resolve the target user via the
    shared `user-target.server.ts` helper, write `app_user_roles` in a
    single transaction, and audit as `admin.user.role_assigned` /
    `admin.user.role_revoked` with `{ roleKey, organizationId }`
    metadata.
- Add the new shared module `src/lib/admin/roles.server.ts`:
  - `loadRoleOrThrow(id)` — fetches a role plus its permission keys and
    member count.
  - `assertRoleNotInUse(id)` — used by DELETE handlers; throws an
    `AdminError("role_in_use")` consumed by the route handler to
    produce the §5.1 error contract.
  - `diffPermissions(current, next)` — pure helper returning
    `{ toAdd, toRemove }` so route handlers, the dual-list editor, and
    tests share one implementation.
- Build the pages described in §8.5 / §8.6 / §8.7:
  - `administrator/roles/page.tsx` — DataGrid (Phase 2) with the
    columns and filters from §8.5; row actions: edit, delete (the
    `role_in_use` 409 surfaces as a friendly toast), duplicate
    (single server call to the dedicated
    `/api/administrator/roles/[id]/duplicate` endpoint above — no
    client-side orchestration).
  - `administrator/roles/new/page.tsx` — `react-hook-form` + zod form
    for `key`, `name`, `description`, organization scope (global vs.
    org picker).
  - `administrator/roles/[roleId]/page.tsx` — three tabs (`tabs`
    primitive):
    - **Permissions** — dual-list editor at
      `_components/role-permissions-editor.tsx` built from `command`,
      `scroll-area`, and `button-group`; groups permission keys by
      their `admin.<area>` prefix; supports keyboard navigation and
      search; persists the diff via the POST/DELETE endpoints above.
    - **Members** — paginated DataGrid backed by
      `/api/administrator/roles/[id]/members`; row action "Revoke"
      calls DELETE on `/users/[id]/app-roles`.
    - **Settings** — name, description, scope; `key` is read-only
      after creation.
  - `administrator/permissions/page.tsx` — read-mostly catalog
    DataGrid; each row exposes a "Roles using this" `Sheet` listing
    consuming roles, and (when `admin.permissions.manage` is held)
    inline create/edit/delete actions with the `permission_in_use`
    409 surfaced as a toast.
- Wire the Roles, Permissions, and User-detail Roles tab entries into
  the `AdministratorSidebar` (Phase 1 placeholders) and remove their
  "Coming soon" empty states. Sidebar entries are gated by
  `admin.roles.read` and `admin.permissions.manage` respectively, per
  §6.2.
- i18n: extend the `administrator.roles.*` and `administrator.permissions.*`
  namespaces in `en.json`, `es.json`, `fr.json`, and `uk.json` with
  fully translated strings — no English-only placeholders, per the
  Phase 1 decision (§20.1 #20).
- Audit: every mutation produces an `app_audit_events` row via
  `auditRoleAction()` (§5.3) with one of `admin.role.created`,
  `admin.role.updated`, `admin.role.deleted`, `admin.role.duplicated`,
  `admin.role.permissions_changed`, `admin.permission.created`,
  `admin.permission.updated`, `admin.permission.deleted`,
  `admin.user.role_assigned`, or `admin.user.role_revoked`. Denied
  attempts are also audited per §5.1.
- Tests:
  - Unit — `diffPermissions`, role list-query filters,
    `assertRoleNotInUse`, permission `usedByRoleCount` aggregate.
  - Component — role-permissions editor (add / remove / search / save
    diff), roles grid filters, permissions catalog "Roles using this"
    sheet.
  - Integration — full lifecycle for `/api/administrator/roles`
    (create → assign permissions → assign to user → in-use delete is
    rejected → revoke → delete succeeds), and the `permission_in_use`
    guard on `/api/administrator/permissions/[id]` DELETE.
  - Security — denial paths for `admin.roles.read|create|update|delete`,
    `admin.roles.assign`, and `admin.permissions.manage`; verify deny
    attempts produce audit rows per §5.1.
- Phase exit criteria: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build` all green on the working branch (per §18 and the
  preamble to §19).

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
| 1 | Legacy `/admin/users` console + `/api/admin/users/*` endpoints | **Superseded — removed.** Originally kept alongside the new app, they were deleted in the security hardening pass: the pages lacked admin permission checks (any active user could read user statuses and the audit log) and the endpoints bypassed the origin-guard / rate-limit / request-id pipeline. The Administrator app is the only admin surface; status mutations live at `/api/administrator/users/[id]/status` + `/bulk` on the shared `performAdminStatusChange` core. |
| 2 | Permission catalog | Adopt the `admin.*` catalog in §6.1 (now 30 keys — 24 original + 2 email + 4 machine-credential) |
| 3 | Better Auth role vs. app roles | Surface as two distinct concepts in the UI |
| 4 | Workspace shell | Fully self-contained — its own left rail in **addition** to the root `SecureSidebar` |
| 5 | Path | `/[locale]/app/administrator` |
| 6 | Filtering | Per-grid filters only — **no** global org scope picker |
| 7 | Cross-org visibility | Platform-admin model — privileged users see/manage **all** organizations |
| 8 | Indexes | Administrator indexes (incl. `pg_trgm`) shipped up-front; folded into `0001-initial-schema.sql` |
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
