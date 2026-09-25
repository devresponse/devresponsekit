---
title: "UAT — Administrator: Users"
description: Screen-by-screen User Acceptance Testing stories for the Administrator console Overview and Users area (list, create, detail, and every user-detail tab), with per-persona access assertions and the 404-not-403 checks.
group: QA
visibility: internal
order: 30
---

# UAT — Administrator: Users

Executable, screen-by-screen User Acceptance Testing stories for the
**Administrator console — Overview + Users** area. Each screen section is
dual-purpose: a non-technical tester can run the numbered scripts, and a reader
learns what the screen is, who may use it, and what it does. Every guard,
permission key, route, and behavior below was validated against the code and is
cited as `file:line`; anything unverified is flagged `TODO: verify`.

Scope of this file (routes under
`src/app/[locale]/(secure)/app/administrator/`):

- Admin layout guard (`layout.tsx`) and the console overview (`page.tsx`).
- Users list (`users/page.tsx`), create (`users/new/page.tsx`), detail
  (`users/[userId]/page.tsx`).
- The user-detail tabs, each its own sub-screen: Overview, Roles, Groups,
  Memberships, Sessions, Audit
  (`users/[userId]/_user-*-panel.tsx` + `_user-detail-tabs.tsx`).

Sibling areas (roles, groups, permissions, organizations, memberships,
enterprise-apps, email, api-keys, audit explorer) are covered in their own
files per the inventory in `docs/uat/GENERATION-PROMPT.md`.

---

## Test environment & accounts

**Base URL:** `http://localhost:3000`. Every route is locale-prefixed; test in
`en` and re-run one non-Latin locale (`uk` or `ja`) per the i18n note on each
screen. Example URLs below use `/en`.

**Seed the personas** with the development fixture:

```
pnpm db:auth:migrate && pnpm db:app:migrate   # schema first
pnpm db:seed:dev                              # the multi-org fixture (dev-init.ts)
```

`dev-init.ts` creates three orgs (`org-a`, `org-b`, `org-c`), each with a
superuser, an org admin, and five members, plus three cross-org members and two
groups in ORG A. Every account shares one password
(`DEV_SEED_PASSWORD`, default `DevPassword123!`) and is pre-approved
(`active`). See `src/db/seeds/dev-init.ts:52` (password) and `:84` (orgs).

| Persona | Sign in as | Seed role | Access (validated) |
| --- | --- | --- | --- |
| **Visitor** | (signed out) | — | Public pages only; `/app/administrator/*` is unreachable. |
| **Member** | `user1@orga.local` | `member` | `shell.view` only — **no** `admin.*`. Cannot open any admin screen. `dev-init.ts:169`. |
| **Org Admin** | `orgadmin@orga.local` | `admin.platform` | The **full** `admin.*` catalog, scoped to ORG A only (no `superuser`). `dev-init.ts:252`. |
| **Superadmin** | `superuser@orga.local` | `superuser` | The `superuser` marker → **every** org, every screen. `dev-init.ts:257`. |
| **Cross-tenant probe** | `orgadmin@orga.local` | `admin.platform` | Used to assert 404-not-403 against an `org-b`/`org-c` user id. |
| **Impersonator** | Org Admin or Superadmin, then impersonate `user1@orga.local` | — | Acts as the target; "Stop impersonating" returns to the admin. |

**Limited Admin (partial permissions):** the plain `admin` role holds only
`shell.view`, `admin.users.read`, `admin.users.manage`, and `admin.audit.read`
(`src/db/seeds/baseline-roles.ts:27-31`, `dev-init.ts:249`). This persona is the key
to the per-permission gating stories below (it can view users and change their
status, but cannot create users, assign roles, manage groups, edit memberships,
or manage sessions). **`TODO: verify`** — neither `seed-local.ts` nor
`dev-init.ts` provisions a user whose ONLY role is `admin`
(`dev-init` assigns `member` / `admin.platform` / `superuser`; `seed-local`'s
one admin also gets `admin.platform` + `superuser`). To test the Limited Admin
persona a tester must manually assign the `admin` role (and only that role) to a
fresh user, e.g. via the Roles tab, or add an `admin`-only fixture user.

**Reset:** `dev-init.ts` is idempotent (re-runnable). Audit rows are
append-only (enforced by the audit trigger in `0001-initial-schema.sql`), so a
full reset means dropping/recreating the database, then re-migrating and
re-seeding.

### The access model (why 404, not 403)

Three tiers (`docs/architecture.md`, ADR-0001; `src/lib/admin/access-scope.server.ts:6`):

- **Superadmin** holds the `superuser` marker → all orgs; org scoping is
  bypassed (`isSuperadmin`, `access-scope.server.ts:38`).
- **Org Admin** holds `admin.*` but not the marker → exactly one org
  (`access.organizationId`); every tenant query is confined to it.
- **User** holds no `admin.*` → self-service only.

Two guard entry points:

- **RSC pages** call `checkAdminPermissionServer(<key>)`; on `"denied"` /
  `"unauthenticated"` they call `notFound()` — a **404**, indistinguishable
  from a missing route (`permissions.server.ts:169`).
- **API routes** call `requireAdminPermission(request, <key>)`; missing
  permission → **403** + a `denied` audit row; a cross-tenant `[id]` →
  **404** via `resolveTargetUser` (`user-target.server.ts:64`,
  `permissions.server.ts:82`).

So a member browsing to `/en/app/administrator/users` gets **Not Found**
(page-level), and an org admin poking at another tenant's user id gets **Not
Found** (resource-level). Neither ever sees "Forbidden" for an out-of-scope
resource — that is the invariant every negative story below asserts.

---

## ADMIN-LAYOUT — Administrator console (layout guard)

- Route: `/app/administrator/*` (shell wrapper) · Example URL: `/en/app/administrator` · Code: `src/app/[locale]/(secure)/app/administrator/layout.tsx:40`
- Purpose: Wraps every administrator screen in the console shell (sidebar + header) and re-validates, defense-in-depth, that the caller holds *some* `admin.*` permission before any child page renders.
- Guard / who can access: caller must hold at least one key in `ANY_ADMIN_PERMISSION` (the full `admin.*` catalog) via `checkAdminPermissionServer([...ANY_ADMIN_PERMISSION])`; otherwise `notFound()` (`layout.tsx:48`). The catalog is defined at `src/lib/admin/permissions.ts:23` / `:65`.
- Access matrix:
  - Visitor / Pending / Blocked → redirected by the parent secure layout (not an admin at all).
  - Member → **404** (holds `shell.view` only; no `admin.*`).
  - Limited Admin / Org Admin / Superadmin → shell renders; the sidebar shows only the groups the caller can use (`administrator-sidebar.tsx:47`).
- Preconditions & test data: the seeded personas above. The sidebar is filtered by `getVisibleAdministratorNavigationGroups(permissions)` (`administrator-navigation.ts:227`).

User stories

- ADMIN-LAYOUT-S1 — As a Member, I want the admin console to be invisible to me, so that the app never advertises tools I cannot use.
  - Acceptance criteria: Given I am signed in as `user1@orga.local`, when I visit `/en/app/administrator`, then I get the app's Not Found page (HTTP 404), not a Forbidden page and not a partial admin shell.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local` (password `DevPassword123!`). | Lands on the dashboard. |
    | 2 | In the address bar, go to `/en/app/administrator`. | The **Not Found** page appears. No admin sidebar, no "Forbidden" wording. |
    | 3 | Try `/en/app/administrator/users`. | **Not Found** again. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-LAYOUT-S2 — As an Org Admin, I want a sidebar that lists only the areas I can open, so that no link leads to a dead end.
  - Acceptance criteria: Given I am signed in as `orgadmin@orga.local`, when the console loads, then every sidebar link I see opens its screen without a 404. Given I am a Limited Admin, then the sidebar shows only the Users and Audit entries (my sole `read` permissions).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`. | Console shell renders. |
    | 2 | Go to `/en/app/administrator`. | The left sidebar shows grouped links (Users, Roles, Permissions, Groups, Organizations, Memberships, and so on). |
    | 3 | Click each visible link in turn. | Each opens its list screen; none shows Not Found. |
    | 4 | Sign out; sign in as a Limited Admin (see the `admin`-only note above); reopen the console. | The sidebar shows **only** the Users link and the Audit link. Roles/Groups/Organizations do **not** appear. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Out-of-scope access → the layout returns 404 for a non-admin; it never leaks that `/administrator/*` exists.
2. The sidebar gate must match each page guard: the Users link requires `admin.users.read` (`administrator-navigation.ts:66`), which is exactly the Users page guard (`users/page.tsx:29`). Confirm no visible link 404s (the historical bug class).
3. Not-found status: open `/en/app/administrator/users/<well-formed unknown UUID>` with the browser devtools Network tab open — the document response is an HTTP **404** (not a 200 that merely renders "Page not found"). The administrator tree deliberately has no `loading.tsx` streaming boundary: a boundary above the pages would flush the shell before the page's `notFound()` runs, turning every admin `[id]` 404 into a 200 (review #29, `tests/e2e/admin-cross-org-404.spec.ts`).

Accessibility: the sidebar is keyboard-navigable; the active item is derived from the path (`administrator-sidebar.tsx:47`); group labels auto-hide when the rail is collapsed. Its collapse toggle is independent of the root shell (own cookie, no Ctrl/Cmd+B — `layout.tsx:38`).
i18n: run `en` + `uk`; sidebar group and item labels come from the `administrator.nav` catalog — no raw keys.

---

## ADMIN-OVERVIEW — Administrator console overview

- Route: `/app/administrator` · Example URL: `/en/app/administrator` · Code: `src/app/[locale]/(secure)/app/administrator/page.tsx:72`
- Purpose: The console landing dashboard — metric cards (Users, Organizations, Roles, Permissions, Enterprise Apps), trend charts, and recent-activity lists. Each card/list is gated by its own read permission and its query only runs when the caller can see it.
- Guard / who can access: reachable by any admin (enforced by the layout). Per-card gating: each metric descriptor names a read permission — Users card = `admin.users.read`, Organizations = `admin.orgs.read`, Roles/Permissions = `admin.roles.read`, Enterprise Apps = `admin.apps.read` (`page.tsx:37`–`:68`). Cards the caller cannot read are hidden and their queries never run (`page.tsx:92`). The recent-sessions list is gated on `admin.users.sessions` and audit activity on `admin.audit.read` (`page.tsx:119`–`:123`).
- Access matrix:
  - Member → **404** (layout).
  - Limited Admin → sees the **Users** card + registrations and audit lists (holds `admin.users.read`, `admin.audit.read`); no Organizations/Roles/Apps cards; no sessions list.
  - Org Admin → all cards, scoped to ORG A only; org-scoped charts (own-org registrations/logins), no cross-org "most active orgs", no system audit-volume chart (`page.tsx:232`, `:267`).
  - Superadmin → system-wide cards and charts, including "most active orgs" and audit-event volume.
- Preconditions & test data: run `pnpm db:seed:dev` so registrations, logins, and audit rows are spread across the 7-day window (`dev-init.ts:185`, `:547`).

User stories

- ADMIN-OVERVIEW-S1 — As an Org Admin, I want an at-a-glance dashboard of my organization, so that I can see counts and recent activity without opening each area.
  - Acceptance criteria: Given I am `orgadmin@orga.local`, when I open the console, then I see metric cards and recent-activity lists reflecting ORG A only; clicking a card navigates to that area's list.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; go to `/en/app/administrator`. | The overview renders with a page title and description. |
    | 2 | Read the metric cards. | Cards for Users, Organizations, Roles, Permissions, Enterprise Apps appear with numeric values. |
    | 3 | Note the Users card value. | It reflects only ORG A members (not org-b/org-c users). |
    | 4 | Click the **Users** card. | Navigates to `/en/app/administrator/users`. |
    | 5 | Return to the overview; find the "Recent registrations" list. | It lists recent ORG A users with a status badge and a localized date. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-OVERVIEW-S2 — As a Superadmin, I want system-wide insight charts, so that I can compare organizations and spot platform-level trends.
  - Acceptance criteria: Given I am `superuser@orga.local`, when I open the console, then I additionally see the "Most active organizations" chart and the audit-event-volume chart that an org admin never sees.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local`; go to `/en/app/administrator`. | Overview renders. |
    | 2 | Scroll to the Insights section. | A "Most active organizations" bar chart is present (cross-org). |
    | 3 | Look for the audit-events chart. | An audit-event-volume chart is present (system scope only). |
    | 4 | Sign out; sign in as `orgadmin@orga.local`; reopen the overview. | Neither the "most active orgs" nor the audit-volume chart appears. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-OVERVIEW-S3 — As a Limited Admin, I want the dashboard to hide areas I cannot read, so that it never shows numbers I have no permission to see.
  - Acceptance criteria: Given a Limited Admin (only `admin.users.read` + `admin.audit.read`), when the overview loads, then only the Users card and the registrations/audit lists render; no Organizations/Roles/Permissions/Apps cards.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin (see the `admin`-only note above). | Console loads. |
    | 2 | Read the metric cards. | Only the **Users** card appears; Organizations/Roles/Permissions/Enterprise Apps cards are absent. |
    | 3 | Check the recent-activity area. | Recent registrations and recent audit events appear; the recent-sessions list does **not** (requires `admin.users.sessions`). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Out-of-scope access → a Member visiting `/en/app/administrator` gets 404 (layout), not 403.
2. Empty state → with no visible metrics the page shows the "no metrics" message (`page.tsx:154`); with no activity the lists are simply absent.
3. No card advertises an area the caller cannot open — clicking any visible card lands on a screen that renders (never a 404).

Accessibility: cards and list tables are semantic; the Insights section is `aria-labelledby` its heading (`page.tsx:158`). No axe violations.
i18n: run `en` + `uk`; card labels, chart captions, and dates localize; no raw message keys. Dates and counts go through the app formatter, so they follow the viewer's saved time zone, date format and number format (activity times `page.tsx:295`, chart day labels `:225`, counts `:413`), and the daily charts count calendar days in the saved zone (`page.tsx:130`), so a bar and the activity times beside it agree about which day it is.

---

## ADMIN-USERS-LIST — Users list

- Route: `/app/administrator/users` · Example URL: `/en/app/administrator/users` · Code: `src/app/[locale]/(secure)/app/administrator/users/page.tsx:23`
- Purpose: The paginated directory of application users and the entry point to every per-user action. Columns: email (links to detail), display name, organization(s), status badge, created date. Supports search, a status filter, sort, pagination, bulk actions, and CSV export.
- Guard / who can access: page guard `admin.users.read` → `notFound()` on denial (`users/page.tsx:29`); the list API `GET /api/administrator/users` requires the same (`api/administrator/users/route.ts:53`). The "New user" CTA renders only when the caller also holds `admin.users.create` (`users/page.tsx:33`). Bulk actions each require the action's own permission (below).
- Access matrix:
  - Member → **404**.
  - Limited Admin → sees the list; "New user" button **hidden** (no `admin.users.create`); can run **approve/block** bulk actions (`admin.users.manage`) but not **ban** (`admin.users.ban`) or **soft-delete** (`admin.users.delete`) — those return 403 from the bulk API.
  - Org Admin → full list scoped to ORG A; all bulk actions available; sees only ORG A org name(s) per row (`api/.../users/route.ts:109`).
  - Superadmin → all users across all orgs; the organization column shows every org a user belongs to.
- Preconditions & test data: `pnpm db:seed:dev` gives ~21 single-org users + 3 cross-org members. Bulk "select all matching" re-applies the same allow-listed `status`/`q` filters server-side (`api/.../users/bulk/route.ts:160`).

User stories

- ADMIN-USERS-LIST-S1 — As an Org Admin, I want to search and filter the user directory, so that I can find a specific person quickly.
  - Acceptance criteria: Given I am `orgadmin@orga.local` on the list, when I type an email fragment in search, then the grid shows only matching ORG A users; when I set the status filter to Pending, then only pending users remain.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; go to `/en/app/administrator/users`. | The users grid renders with rows and a status filter. |
    | 2 | Type `user2` into the search box. | The grid narrows to users whose email/name contains "user2". |
    | 3 | Clear search; open the **Status** filter and choose **Active**. | Only active users remain. |
    | 4 | Click a column header (e.g. Created). | Rows re-sort by that column; clicking again reverses the order. |
    | 5 | Click a user's email. | Navigates to that user's detail page. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-LIST-S2 — As an Org Admin, I want to approve several pending users at once, so that onboarding is fast.
  - Acceptance criteria: Given several `pending_approval` users, when I select them and choose **Approve**, then a success toast reports the count and the rows refresh to `active`.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | On the list, filter Status = Pending (create pending users first if none exist). | Pending users listed. |
    | 2 | Tick the checkboxes for two rows. | A bulk-action bar appears with a selection count. |
    | 3 | Choose **Approve**. | A success toast reports "approved N"; the grid reloads. |
    | 4 | Filter Status = Active. | The approved users now appear here. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-LIST-S3 — As a Limited Admin, I want the actions I lack to be hidden or refused, so that the screen never lets me start something I cannot finish.
  - Acceptance criteria: Given a Limited Admin, when the list loads, then the "New user" button is absent; when I attempt the **Ban** bulk action, then the server refuses (the action requires `admin.users.ban`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin; open the list. | Grid renders; there is **no** "New user" button in the header. |
    | 2 | Select a row and choose **Approve**. | Succeeds (Limited Admin holds `admin.users.manage`). |
    | 3 | Select a row and choose **Ban**, entering a reason. | The action is refused (an error toast; no rows change). Ban requires `admin.users.ban`, which the `admin` role lacks. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-LIST-S4 — As an Org Admin, I want to export the current view to CSV, so that I can share or archive it.
  - Acceptance criteria: Given the list with a filter applied, when I click **Export CSV**, then a CSV of the current filtered view downloads.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Apply a status filter. | Grid narrows. |
    | 2 | Click **Export CSV** (`exportResource="users"`, `_users-grid.tsx:258`). | A CSV file downloads containing the filtered rows. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Cross-tenant scoping → as `orgadmin@orga.local`, no `org-b`/`org-c` users ever appear, and the organization column shows only ORG A (revealing a shared user's other orgs would itself be a leak — `api/.../users/route.ts:109`).
2. Rate limit → rapid bulk actions hit the bulk budget; the server responds 429 and the UI shows the "rate limited" toast (`_users-grid.tsx:158`, `api/.../users/bulk/route.ts:125`).
3. Bulk "select all matching" cannot pivot columns — only `status` and `q` are honored server-side; unknown filters are dropped (`api/.../users/bulk/route.ts:164`).
4. Empty state → a filter with no matches shows the grid's empty state; a fetch failure shows the grid's inline error.

Accessibility: column headers are buttons; the row-selection checkboxes are labelled; bulk actions are reachable by keyboard. No axe violations.
i18n: run `en` + `uk`; column headers, status badges, filter labels, and toasts localize; dates use the active locale; no raw keys.

---

## ADMIN-USERS-NEW — Create user

- Route: `/app/administrator/users/new` · Example URL: `/en/app/administrator/users/new` · Code: `src/app/[locale]/(secure)/app/administrator/users/new/page.tsx:16`
- Purpose: Create a new user. The form posts to `POST /api/administrator/users`, which creates the Better Auth identity and the `app_users` row in one transaction. New users default to `pending_approval` so an admin still approves them.
- Guard / who can access: page guard `admin.users.create` → `notFound()` (`users/new/page.tsx:23`); the API requires `admin.users.create` (`api/.../users/route.ts:170`). Validated by the shared `createUserSchema` on both client and server (`_new-user-form.tsx:18`).
- Access matrix:
  - Member / Limited Admin → **404** at the page (the `admin` role lacks `admin.users.create`). Because the CTA is hidden on the list, they reach this only by typing the URL.
  - Org Admin / Superadmin → form renders.
- Preconditions & test data: fields — email (required), display name (optional; max 200, and a line break, tab or invisible formatting character is refused with `validation.nameCharacters`, F-21), password (required; hint shown), Better Auth role (`user`; `admin` is offered to a Superadmin only, F-13), initial app status (`pending_approval`/`active`), preferred locale (`en`/`es`/`fr`/`uk`). Required markers derive from the schema (`RequiredLegend`, `_new-user-form.tsx:104`).

User stories

- ADMIN-USERS-NEW-S1 — As an Org Admin, I want to create a user, so that I can provision access on someone's behalf.
  - Acceptance criteria: Given valid input, when I submit, then the API returns 201 and I am redirected to the new user's detail page.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; go to `/en/app/administrator/users/new`. | The create-user form renders with a required-fields legend. |
    | 2 | Enter a unique email, a display name, and a password meeting the hint. | Fields accept the input; no error borders. |
    | 3 | Leave Initial status at **Pending approval**; click the submit button. | On success you are taken to the new user's detail page. |
    | 4 | Note the status badge on the detail page. | It reads **Pending approval**. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-NEW-S2 — As an Org Admin, I want clear validation, so that I fix mistakes before submitting.
  - Acceptance criteria: Given an invalid email, when I blur the field, then a localized field message appears and the control gets an error border; given a duplicate email, when I submit, then the error lands on the email field (409 → `emailTaken`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | On the form, type `not-an-email` in Email and click elsewhere. | The email field shows an error border and a localized validation message. |
    | 2 | Submit with the password blank. | The password field shows a required-field error; the form does not submit. |
    | 3 | Enter the email of an existing user and a valid password; submit. | The **email** field shows "email already taken" (server 409 mapped to the field, `_new-user-form.tsx:81`). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-NEW-S3 — As a Limited Admin, I want this page to be closed to me, so that I cannot create users I have no permission to create.
  - Acceptance criteria: Given a Limited Admin, when I type the URL `/en/app/administrator/users/new`, then I get Not Found (404), not Forbidden.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin. | Console loads; the list shows no "New user" button. |
    | 2 | Manually go to `/en/app/administrator/users/new`. | **Not Found** (404). No form renders. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Required-field markers → the `*` appears on required fields (email, password) from the schema; submitting empty shows localized messages.
2. 400 (malformed body) → a form-level banner ("invalid body", `_new-user-form.tsx:85`); 403 → a "forbidden" banner (defensive — the page already 404s non-creators).
3. Rate limit → repeated creates hit the mutation budget; the server returns 429 (`api/.../users/route.ts:173`) and the form shows the generic error toast.
4. Concurrency → two creates racing on the same email: the loser gets the same 409 `email_taken`. There is no unique index on the `app_users` email; Better Auth's unique email refuses the loser inside the create call, and the route maps that refusal to 409 (F-30, `src/lib/admin/auth-email-taken.ts`). The loser also leaves one `admin.user.create_failed` row (reason `auth_user_exists`) in the Audit log, with an empty Target and the address in the Email field of the row's detail pane (**View**). An address Better Auth holds with no user row at all (for example a self-sign-up whose provisioning failed) gets the same 409 and the same row, never a 500.
5. The platform role is Superadmin-only (F-13) → as `orgadmin@orga.local`, the **Better Auth role** select offers only `user`. A hand-made `POST /api/administrator/users` (or `POST /api/v1/users`) with `"role":"admin"` answers **403** `forbidden` and creates nobody, the same rule as `POST /users/[id]/role`. As `superuser@orga.local` the select also offers `admin`, and the create succeeds.
6. Machine callers can do what the console does (F-13) → with `API_KEYS_ENABLED` on, sign in as `superuser@orga.local`, create a key on **Account → API keys** with the `admin.users.create`, `admin.users.ban` and `admin.users.sessions` scopes ticked, and call with `Authorization: Bearer drk_…`: `POST /api/v1/users` with `"initialAppStatus":"active"` answers **201** and the new user can sign in with the password you sent; `POST /api/administrator/users/{id}/ban` (`{"reason":"…"}`) answers **200** and signs that user out; `GET /api/administrator/users/{id}/sessions` lists their sessions. Before F-13 every one of these answered **502** after passing the permission checks (the MCP `createUser` tool too). Banning the key's own owner is refused (502 `auth_ban_failed`), as it is from the console. The platform role is the exception: the same `POST /api/v1/users` with `"role":"admin"` answers **403** `forbidden` although the key's owner is a Superadmin, because every key is bound to one org (MACHINE-2); only a Superadmin's cookie session mints that role (case 5).

Accessibility: labelled fields, `noValidate` form with RHF messages, keyboard submit, visible focus. No axe violations.
i18n: run `en` + `uk`; labels, the password hint, status options, and error messages localize. The locale dropdown offers `en`/`es`/`fr`/`uk` only (`_new-user-form.tsx:30`) — **`TODO: verify`** whether that narrower set (vs. the app's 8 locales) is intentional for admin-created users.

---

## ADMIN-USERS-DETAIL — User detail (header + tabs container)

- Route: `/app/administrator/users/[userId]` · Example URL: `/en/app/administrator/users/<uuid>` · Code: `src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:28`
- Purpose: The per-user workspace: a metadata header (name, email, status badge, optional Impersonate button) plus a tabbed container — Overview, Roles, Groups, Memberships, Sessions, and (permission-gated) Audit.
- Guard / who can access: page guard `admin.users.read` → `notFound()` (`[userId]/page.tsx:35`); the `userId` must be a UUID (`:40`) and the target must resolve within the caller's org via `canAccessUser`, else `notFound()` (`:69`, `access-scope.server.ts:96`). Per-tab affordances are gated by additional keys the page reads: `admin.roles.assign` (Roles actions), `admin.groups.assign` (Groups actions), `admin.users.update` (Memberships remove), `admin.users.impersonate` (Impersonate button) — `[userId]/page.tsx:87`–`:98`. A tab whose API demands MORE than `admin.users.read` is rendered only for a caller who holds that key (review #76): **Groups** needs `admin.groups.read`, **Sessions** needs `admin.users.sessions`, **Audit** needs `admin.audit.read` (`_user-detail-tabs.tsx:73`,`:75`,`:76`). No tab in the bar leads to a 403.
- Access matrix:
  - Member → **404**.
  - Limited Admin → header + Overview/Roles/Memberships tabs, **plus** the Audit tab (holds `admin.audit.read`). The **Groups** and **Sessions** tabs are **absent** — the `admin` role holds neither `admin.groups.read` nor `admin.users.sessions` (review #76). Roles/Memberships show **no** mutate buttons; the Impersonate button is absent.
  - Org Admin / Superadmin → all tabs and actions (org admin scoped to ORG A; superadmin across orgs).
- Preconditions & test data: pick a user from the list (its detail URL carries the `app_users.id` UUID). To test cross-tenant 404, grab an `org-b` user's id while signed in as a superadmin, then re-request it as `orgadmin@orga.local`.

User stories

- ADMIN-USERS-DETAIL-S1 — As an Org Admin, I want a user's key facts on one page, so that I can review their account at a glance.
  - Acceptance criteria: Given a valid ORG A user id, when I open the detail page, then I see the display name, email, status badge, and the tab bar.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; from the list, click a user. | The detail page renders with the user's name and email in the header. |
    | 2 | Read the status badge (top-right). | It shows a localized status (e.g. Active). |
    | 3 | Read the tab bar. | Tabs: Overview, Roles, Groups, Memberships, Sessions, and (since org admin holds `admin.audit.read`) Audit. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-DETAIL-S2 — As an Org Admin, I want another tenant's user to be indistinguishable from a non-existent one, so that the app never leaks who exists elsewhere.
  - Acceptance criteria: Given an `org-b` user's id, when I (as `orgadmin@orga.local`) request its detail URL, then I get Not Found (404), never Forbidden.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local`; open an `org-b` user's detail; copy the UUID from the URL. | You have a valid `org-b` user id. |
    | 2 | Sign out; sign in as `orgadmin@orga.local`. | ORG A console. |
    | 3 | Paste `/en/app/administrator/users/<org-b-uuid>` into the address bar. | **Not Found** (404). Not "Forbidden". |
    | 4 | Try a made-up UUID and a non-UUID string. | Both → **Not Found** (`[userId]/page.tsx:40`). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Non-UUID or unknown id → 404 (`page.tsx:40`, `:63`).
2. Cross-tenant id → 404 via `canAccessUser` (`page.tsx:69`), not 403.
3. A soft-deleted (`deactivated`) user shows a warning panel on Overview with the deactivation timestamp/actor/reason (`_user-detail-tabs.tsx:85`).

Accessibility: tabs follow the tablist pattern (arrow-key navigation, roving focus); the header actions are reachable by keyboard. No axe violations.
i18n: run `en` + `uk`; tab labels, field labels, and dates localize; status uses the `status.*` catalog (unknown enum values render verbatim, `page.tsx:144`).

---

## ADMIN-USERS-DETAIL-OVERVIEW — User detail: Overview tab

- Route: `/app/administrator/users/[userId]` (Overview tab) · Example URL: `/en/app/administrator/users/<uuid>` · Code: `_user-detail-tabs.tsx:79`
- Purpose: Read-only account metadata streamed by the parent RSC (no client fetch): email, display name, preferred locale, the app-user id and Better Auth id, optional status reason, created/updated timestamps, and a deactivation panel when applicable.
- Guard / who can access: same as the detail page (`admin.users.read`); no extra permission — the data is already on the page.
- Access matrix: Member → 404; Limited Admin / Org Admin / Superadmin → visible.
- Preconditions & test data: any resolvable user; a deactivated user to exercise the warning panel.

User stories

- ADMIN-USERS-DETAIL-OVERVIEW-S1 — As a Limited Admin, I want to read a user's core identifiers, so that I can cross-reference them in logs and support tickets.
  - Acceptance criteria: Given a user detail page, when I open the Overview tab, then I see email, display name, preferred locale, the app-user id, and the Better Auth id.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open any user's detail; ensure the **Overview** tab is active (it is the default). | A definition list of fields renders. |
    | 2 | Read the fields. | Email, Display name, Preferred locale, App-user id (monospace), Better Auth id (monospace) are shown. |
    | 3 | Read the footer line. | "Created …" and "Updated …" with localized dates. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Missing display name → shows an em dash placeholder, not an empty cell.
2. Deactivated user → a warning panel shows the deactivation date, actor, and reason (`_user-detail-tabs.tsx:85`).

Accessibility: the metadata is a `<dl>`; ids are in `<code>` for easy copy. No axe violations.
i18n: run `en` + `uk`; field labels and the created/updated line localize; the ids are locale-neutral.

---

## ADMIN-USERS-DETAIL-ROLES — User detail: Roles tab

- Route: `/app/administrator/users/[userId]` (Roles tab) · Example URL: `/en/app/administrator/users/<uuid>` · Code: `_user-roles-panel.tsx:41`
- Purpose: Lists the application role assignments the user holds (role name, key, organization, assigned date). With the right permission, the operator can assign a role (dialog + picker) or remove one.
- Guard / who can access: the list grid reads `GET /api/administrator/users/[id]/roles`, which requires `admin.users.read` (`api/.../users/[id]/roles/route.ts:39`). The **assign** and **remove** actions (and the assign dialog) render only when the page passed `canAssign` = `admin.roles.assign` (`[userId]/page.tsx:75`, `_user-roles-panel.tsx:160`); those mutations hit `POST`/`DELETE /api/administrator/users/[id]/app-roles`, both requiring `admin.roles.assign` (`api/.../users/[id]/app-roles/route.ts:92`, `:191`).
- Access matrix:
  - Member → 404 (page).
  - Limited Admin → **sees the assignments list** (has `admin.users.read`) but **no** Assign button and **no** per-row Remove (lacks `admin.roles.assign`).
  - Org Admin / Superadmin → list + Assign + Remove. An org admin may assign only roles in their own org, and (privilege-escalation guard) only roles whose conferred permissions are a subset of their own (`api/.../app-roles/route.ts:148`).
- Preconditions & test data: a user in ORG A; at least one assignable ORG A role. The `dev-init` Engineering group confers the `admin` role, so ORG A has assignable roles.

User stories

- ADMIN-USERS-DETAIL-ROLES-S1 — As an Org Admin, I want to grant a user a role, so that they gain the capabilities that role confers.
  - Acceptance criteria: Given the Roles tab with `admin.roles.assign`, when I open the assign dialog, pick an ORG A role, and confirm, then the assignment appears in the list.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open a user's detail; click the **Roles** tab. | A grid of current role assignments renders. |
    | 2 | Click the **Assign** button. | A dialog with a role picker opens. |
    | 3 | Select a role and confirm. | The dialog closes; the grid reloads and now includes the new role. |
    | 4 | Click **Remove** on that row and confirm the destructive dialog. | The row disappears after reload. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-DETAIL-ROLES-S2 — As a Limited Admin, I want role changes to be unavailable, so that I cannot alter permissions I have no authority over.
  - Acceptance criteria: Given a Limited Admin (no `admin.roles.assign`), when I open the Roles tab, then I can read the assignments but there is no Assign button and no Remove action.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin; open a user's detail; click **Roles**. | The assignments grid renders (read works). |
    | 2 | Look for an **Assign** button and a per-row **Remove**. | Neither is present. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Privilege escalation blocked → an org admin assigning a role that confers a permission they lack gets 403 (`api/.../app-roles/route.ts:148`); the panel shows the assign error.
2. Cross-tenant role/org → assigning with a foreign org/role id → 404 (not 403), so a foreign org's existence is not confirmed (`api/.../app-roles/route.ts:138`, `:141`).
3. Remove is idempotent → removing an already-removed assignment still returns success (`api/.../app-roles/route.ts:190`).
4. Inline error → a failed remove surfaces `role="alert"` text above the grid (`_user-roles-panel.tsx:184`).
5. Superadmin, many orgs → sign in as Superadmin, open a user's Roles tab, click **Assign**, and in the picker type an org's name, then a role key. The picker lists the server's matches (role key, role name or the role's org name), offers only org-scoped roles, and shows "Showing N of M" while more match than are listed (F-41).

Accessibility: the assign dialog traps focus and closes on Esc; the picker is labelled; the destructive remove uses a confirm dialog. No axe violations.
i18n: run `en` + `uk`; column headers, buttons, dialog text, and error messages localize; assigned dates localize.

---

## ADMIN-USERS-DETAIL-GROUPS — User detail: Groups tab

- Route: `/app/administrator/users/[userId]` (Groups tab) · Example URL: `/en/app/administrator/users/<uuid>` · Code: `_user-groups-panel.tsx:37`
- Purpose: Lists the groups the user belongs to and, with permission, lets the operator add the user to a group (dialog + picker) or remove them. Group membership confers the union of the group's roles' permissions (ADR-0002).
- Guard / who can access: the list fetch `GET /api/administrator/users/[id]/groups` requires `admin.groups.read` (`api/.../users/[id]/groups/route.ts:35`), and the tab TRIGGER is gated on the same key so a caller without it never reaches the panel (`_user-detail-tabs.tsx:73`, review #76). Add/remove render only when the page passed `canManage` = `admin.groups.assign` (`[userId]/page.tsx:76`, `_user-groups-panel.tsx:132`); those hit `POST`/`DELETE …/groups`, both requiring `admin.groups.assign` (`api/.../groups/route.ts:82`, `:152`).
- Access matrix:
  - Member → 404 (page).
  - Limited Admin → the Groups tab is **not rendered** at all: the `admin` role lacks `admin.groups.read`, which now gates the tab trigger (review #76). The API is still the boundary — a hand-made `GET …/groups` for that user answers 403.
  - Org Admin / Superadmin → list + Add + Remove. An org admin sees only their org's groups; adding to a group whose conferred permissions exceed the admin's is blocked (`api/.../groups/route.ts:118`).
- Preconditions & test data: ORG A has the `Engineering` and `Customer Support` groups (`dev-init.ts:135`). Use a user who is not yet a member so the picker has something to add.

User stories

- ADMIN-USERS-DETAIL-GROUPS-S1 — As an Org Admin, I want to add a user to a group, so that they inherit the group's roles in one step.
  - Acceptance criteria: Given the Groups tab with `admin.groups.assign`, when I add the user to `Engineering`, then the group appears in their list; when I remove it, it disappears.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open a user's detail; click the **Groups** tab. | The user's current groups render (or an empty-state message). |
    | 2 | Click the **Add** button. | A dialog with a group picker opens. It lists the groups of the user's organizations; groups the user already belongs to show "Already a member" and cannot be chosen. Typing searches the server by group key, group name or org name (F-41). |
    | 3 | Pick `Engineering` and confirm. | The dialog closes; the list reloads and shows `Engineering`. |
    | 4 | Click **Remove** on `Engineering` and confirm. | The group is removed after reload. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-DETAIL-GROUPS-S2 — As a Limited Admin, I want the Groups tab to reveal nothing, so that group membership stays confidential when I lack the group-read permission.
  - Acceptance criteria: Given a Limited Admin (no `admin.groups.read`), when I open a user's detail, then the Groups tab is not offered at all, and the underlying API still refuses me (review #76).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin; open a user's detail and read the tab bar. | Overview, Roles, Memberships and Audit are offered. There is **no Groups tab**. |
    | 2 | With the browser devtools console, request `/api/administrator/users/<that user id>/groups`. | 403 `forbidden` — the tab was a convenience, the API is the boundary. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Privilege escalation blocked → adding a user to a more-authoritative group → 403 (`api/.../groups/route.ts:118`); panel shows the add error.
2. User must belong to the group's org → the picker offers only the groups of the user's orgs (a user with no membership in scope is offered none); a hand-made `POST …/groups` naming a group in another org → 404 (`api/.../groups/route.ts:124`).
3. Cross-tenant group id → 404 (not 403) (`api/.../groups/route.ts:108`).
4. Empty state / loading skeleton / inline error are all handled by the panel (`_user-groups-panel.tsx:146`, `:152`).
5. Superadmin, a user in two orgs that each hold a group with the same key and name → sign in as Superadmin, open that user's Groups tab and click **Add**. Each option names its org, and typing one org's name narrows the list to that org's groups (F-41).

Accessibility: the add dialog traps focus and closes on Esc; the list is a labelled `<ul>`; remove uses a confirm dialog. No axe violations.
i18n: run `en` + `uk`; title, buttons, dialog, empty and error text localize.

---

## ADMIN-USERS-DETAIL-MEMBERSHIPS — User detail: Memberships tab

- Route: `/app/administrator/users/[userId]` (Memberships tab) · Example URL: `/en/app/administrator/users/<uuid>` · Code: `_user-memberships-panel.tsx:28`
- Purpose: Lists the user's organization memberships (org slug/name, status, source provider, joined date). With permission, the operator can remove a membership.
- Guard / who can access: the list grid reads `GET /api/administrator/users/[id]/memberships`, which requires `admin.users.read` (`api/.../users/[id]/memberships/route.ts:35`). The per-row Remove renders only when the page passed `canUpdate` = `admin.users.update` (`[userId]/page.tsx:77`, `_user-memberships-panel.tsx:111`); removal hits `DELETE …/memberships`, which requires `admin.users.update` (`api/.../users/[id]/memberships/route.ts:326`).
- Access matrix:
  - Member → 404 (page).
  - Limited Admin → sees the memberships list (`admin.users.read`) but **no** Remove action (lacks `admin.users.update`).
  - Org Admin / Superadmin → list + Remove (org admin scoped to ORG A memberships).
- Preconditions & test data: a cross-org member (`multi1@shared.local`) belongs to all three orgs — good for exercising multi-row lists and scope.

User stories

- ADMIN-USERS-DETAIL-MEMBERSHIPS-S1 — As an Org Admin, I want to see and manage a user's org memberships, so that I can correct their tenancy.
  - Acceptance criteria: Given the Memberships tab with `admin.users.update`, when I remove a membership and confirm, then the row disappears after reload, and the user's roles and group memberships in that org are removed with it (F-12). Their roles and groups in other orgs stay.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open a user's detail; click **Memberships**. | A grid of memberships renders with a status badge per row. |
    | 2 | Note the organization column links to the org detail page. | Each org slug is a link. |
    | 3 | Click **Remove** on a membership and confirm the destructive dialog. | The row is removed after reload. |
    | 4 | As the Superadmin, open the same user's detail → **Roles** and **Groups**. (The Org Admin can no longer reach this user: they share no org now.) | Nothing from `org-a` is listed (F-12). Roles and groups the user holds in other orgs are still there. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-DETAIL-MEMBERSHIPS-S2 — As a Limited Admin, I want membership removal to be unavailable, so that I cannot change tenancy without the update permission.
  - Acceptance criteria: Given a Limited Admin, when I open the Memberships tab, then I can read the list but there is no Remove action.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin; open a user's detail; click **Memberships**. | The memberships grid renders. |
    | 2 | Look for a per-row **Remove** action. | None is present. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Cross-tenant scoping → an org admin sees only ORG A memberships of the user; a shared user's other-org memberships do not appear.
2. Inline error → a failed remove shows `role="alert"` text (`_user-memberships-panel.tsx:135`).
3. Empty state → a user with no in-scope memberships shows the grid empty state.
4. Grants the caller could not confer → a removal whose roles or groups in that org confer a permission the caller cannot confer is refused with **403** `forbidden` and an `admin.membership.revocation_denied` audit row, and nothing is removed (REVOKE-1, F-12). The panel shows the generic remove error.

Accessibility: the grid header row is semantic; the remove confirm dialog traps focus and closes on Esc. No axe violations.
i18n: run `en` + `uk`; column headers, the status badge, and the joined date localize.

---

## ADMIN-USERS-DETAIL-SESSIONS — User detail: Sessions tab

- Route: `/app/administrator/users/[userId]` (Sessions tab) · Example URL: `/en/app/administrator/users/<uuid>` · Code: `_user-sessions-panel.tsx:29`
- Purpose: Lists the user's active Better Auth sessions (expiry, IP, user agent) and lets the operator revoke one session or all of them (force sign-out everywhere).
- Guard / who can access: both the list `GET` and the revoke `DELETE` (single + all) require `admin.users.sessions` (`api/.../users/[id]/sessions/route.ts:32`, `:70`; single-session `DELETE` at `api/.../users/[id]/sessions/[sessionId]/route.ts:27`). The tab TRIGGER is gated on the same key (`_user-detail-tabs.tsx:75`, review #76), so a caller without `admin.users.sessions` is never offered the tab; the API stays the boundary for anyone who calls it directly.
- Access matrix:
  - Member → 404 (page).
  - Limited Admin → the Sessions tab is **not rendered** (the `admin` role lacks `admin.users.sessions`, which gates the trigger); a direct call to the sessions API answers 403, so revoke is impossible either way.
  - Org Admin / Superadmin → list + revoke. "Revoke all" is account-global, so for a user shared across tenants it is Superadmin-only; an org admin may revoke-all only for a user confined to their org (`api/.../sessions/route.ts:90`, `access-scope.server.ts:133`).
- Preconditions & test data: sign the target user in on a second browser/device first so there is a live session to list and revoke.

User stories

- ADMIN-USERS-DETAIL-SESSIONS-S1 — As an Org Admin, I want to revoke a user's sessions, so that I can cut off access immediately if a device is compromised.
  - Acceptance criteria: Given the target has an active session, when I click Revoke on it (or Revoke all), then the list refreshes without that session.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | In a second browser, sign in as `user1@orga.local`. | The user has a live session. |
    | 2 | As `orgadmin@orga.local`, open that user's detail; click **Sessions**. | The active session(s) list with expiry, IP, and user agent. |
    | 3 | Click **Revoke** on a session. | The list reloads without it. |
    | 4 | Click **Revoke all**. | All sessions are cleared; the empty-state message shows. In the second browser, the user is signed out on next navigation. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-DETAIL-SESSIONS-S2 — As a Limited Admin, I want session data to stay hidden, so that IPs and devices are not exposed without the sessions permission.
  - Acceptance criteria: Given a Limited Admin (no `admin.users.sessions`), when I open a user's detail, then no Sessions tab is offered and the API refuses a direct read (review #76).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a Limited Admin; open a user's detail and read the tab bar. | There is **no Sessions tab**. |
    | 2 | With the browser devtools console, request `/api/administrator/users/<that user id>/sessions`. | 403 `forbidden`; no IPs or user agents are returned. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Shared-target guard → an org admin clicking "Revoke all" on a cross-org user (`multi1@shared.local`) gets 403 (account-global action reserved for Superadmin, `api/.../sessions/route.ts:92`); the panel shows its error.
2. Empty state → a user with no active sessions shows the "no sessions" message; "Revoke all" is disabled (`_user-sessions-panel.tsx:118`).
3. Loading skeleton → shown while the list fetches (`_user-sessions-panel.tsx:130`).

Accessibility: the session list is a labelled `<ul>`; revoke buttons are disabled while a request is in flight; errors use `role="alert"`. No axe violations.
i18n: run `en` + `uk`; expiry/IP/user-agent labels and the empty message localize; the expiry time uses the active locale.

---

## ADMIN-USERS-DETAIL-AUDIT — User detail: Audit tab

- Route: `/app/administrator/users/[userId]` (Audit tab) · Example URL: `/en/app/administrator/users/<uuid>` · Code: `_user-audit-panel.tsx:12`
- Purpose: The user-scoped audit trail — `app_audit_events` rows about this user — rendered by the shared audit grid with its global filter toolbar hidden (the view is already scoped). Each row opens a detail sheet with full metadata.
- Guard / who can access: the Audit **tab is shown only when the page passed `canReadAudit` = `admin.audit.read`** (`[userId]/page.tsx:79`, `_user-detail-tabs.tsx:76`). The endpoint `GET /api/administrator/users/[id]/audit` also requires `admin.audit.read` — a stricter gate than the page's own `admin.users.read` (`api/.../users/[id]/audit/route.ts:38`).
- Access matrix:
  - Member → 404 (page).
  - Limited Admin → **Audit tab present and working** (the `admin` role holds `admin.audit.read`), scoped to ORG A.
  - Org Admin → Audit tab present, ORG A only: every action ORG A's admins took on the user, and every membership or role change in ORG A whoever made it (F-32), except a superadmin membership change spanning several orgs in one request: its user-level row is a platform row, and ORG A sees its own `admin.organization.member_*` row in the audit log instead, not on this tab. A superadmin's other actions on the user are platform rows too. Superadmin → all orgs, including platform events with a null org for this user.
- Preconditions & test data: `dev-init.ts` back-dates audit rows (`:552`); performing an admin action on the user (approve/assign/etc.) also generates fresh rows.

User stories

- ADMIN-USERS-DETAIL-AUDIT-S1 — As an Org Admin, I want the history of what happened to a user, so that I can investigate incidents and support requests.
  - Acceptance criteria: Given `admin.audit.read`, when I open the Audit tab, then I see the user's audit events; clicking a row opens a detail sheet with metadata.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open a user's detail; click the **Audit** tab. | A grid of audit events for this user renders (newest first). |
    | 2 | Perform an action on the user first if the grid is empty (e.g. approve, or assign a role), then reopen the tab. | The corresponding event appears. |
    | 3 | Click **View detail** on a row. | A side sheet opens showing actor, target, IP, user agent, reason, and the JSON metadata. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-DETAIL-AUDIT-S2 — As a persona lacking audit permission, I want the Audit tab to be absent, so that audit data is gated separately from the user record.
  - Acceptance criteria: Given a persona with `admin.users.read` but **not** `admin.audit.read`, when I open a user's detail, then the tab bar has no Audit tab. (Because `dev-init`'s admin roles all include `admin.audit.read`, testing "no audit" requires a user granted a role that omits it — **`TODO: verify`**: assemble such a role, e.g. a custom role with only `admin.users.read`.)
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a user whose admin role omits `admin.audit.read` (see the note). | Console loads. |
    | 2 | Open a user's detail and read the tab bar. | Overview/Roles/Groups/Memberships/Sessions appear; **Audit does not**. |
    | 3 | Manually request `/api/administrator/users/<uuid>/audit`. | The API returns 403 (not the audit rows). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Cross-tenant scoping → an org admin sees only ORG A events for the user; platform (null-org) events are Superadmin-only (`api/.../audit/route.ts:55`).
2. Empty state → a user with no in-scope events shows the grid empty state.
3. The metadata sheet renders JSON as text only — no value is executed (`_audit-grid.tsx:39`).

Accessibility: the detail sheet traps focus and closes on Esc; the "View detail" trigger is a labelled button. No axe violations.
i18n: run `en` + `uk`; column headers, outcome badge, and the detail-sheet labels localize; timestamps use the active locale.

---

## Impersonation (cross-cutting journey rooted in the user detail)

- Where: the Impersonate button in the detail header (`_impersonate-button.tsx:42`) + `POST`/`DELETE /api/administrator/users/[id]/impersonate` (`api/.../users/[id]/impersonate/route.ts:45`, `:140`).
- Guard: the button renders only when the page passed `canImpersonate` = `admin.users.impersonate` (`[userId]/page.tsx:78`). Start requires `admin.users.impersonate`; you cannot impersonate yourself (400, `impersonate/route.ts:62`); a non-superadmin cannot impersonate a more-privileged target (403 privilege-escalation guard, `:71`). **Stop** is deliberately NOT gated on admin permission — the live session is the target (usually a plain member) — so stop authorizes from the session's `impersonatedBy` marker (`impersonate/route.ts:140` and its header comment).

- ADMIN-USERS-IMPERSONATE-S1 — As an Org Admin, I want to act as a user to reproduce their problem, so that I can support them accurately; and I want a one-click way back.
  - Acceptance criteria: Given `admin.users.impersonate` and a lower-or-equal-privileged target, when I confirm impersonation, then I land in the secure shell as that user; when I click "Stop impersonating", then I return to my admin account (a full reload to `/app`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open `user1@orga.local`'s detail. | The **Impersonate** button is visible in the header. |
    | 2 | Click it. | A confirm dialog opens with an audit-acknowledgement checkbox; the start button is disabled until it is ticked. |
    | 3 | Tick the checkbox and click the start button. | The page hard-reloads into `/en/app/dashboard` **as the target user**; a "Stop impersonating" banner is shown. |
    | 4 | Confirm you see the target's view (their permissions, not admin). | Admin-only nav is absent while impersonating. |
    | 5 | Click **Stop impersonating**. | You are returned to your own admin account (reload to `/app`); the banner is gone. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- ADMIN-USERS-IMPERSONATE-S2 — As an admin, I want unsafe impersonations refused, so that impersonation cannot be used to escalate.
  - Acceptance criteria: Given I open my own detail, then the Impersonate button is disabled (self, `_impersonate-button.tsx:57`). Given a non-superadmin targets a more-privileged user, then start returns 403.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `orgadmin@orga.local`, open your **own** user detail. | The Impersonate button is **disabled** with a self-explanatory tooltip. |
    | 2 | As `orgadmin@orga.local`, open `superuser@orga.local`'s detail (if in ORG A scope) and attempt impersonation. | Start is refused with an error toast (privilege escalation, 403). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
1. Self-impersonation → button disabled client-side; the API also rejects with 400.
2. Missing permission → the button is absent for a persona without `admin.users.impersonate` (Limited Admin, Member).
3. Rate limit → repeated start calls hit the mutation budget (429, `impersonate/route.ts:49`).
4. Stop always works → even if the admin's impersonate permission was revoked mid-session, "Stop" still returns them to their own account (`impersonate/route.ts:140` comment).
5. The target's credentials stay out of reach → while impersonating, Better Auth lets the session do only two things, read itself and sign out; everything else fails in one of two ways (IMP-3 / F-06, `src/lib/auth-admin-surface.ts`):
   - **403, audited.** The target's **Security** page cannot list or revoke sessions or change the password: `/list-sessions`, `/revoke-session`, `/revoke-other-sessions` and `/change-password` answer 403, as does every other endpoint outside that pair except those in the next bullet. Each refusal is audited as `account.impersonated_access.denied` with the **admin** as the actor.
   - **404, not audited.** Provider tokens, linked logins and password checks (`/list-accounts`, `/get-access-token`, `/unlink-account`, `/verify-password` and the rest of `AUTH_DISABLED_PATHS`) are not mounted at all, and the raw admin plugin (`/api/auth/admin/*`) is closed. Both answer 404 to every caller, impersonating or not, before any check of the session, so they write no audit row. Do not look for one.
6. What you do while impersonating is audited against **you** (F-07) → as the Superadmin (`superuser@orga.local`; a profile edit carries no organization, so only a superadmin's audit view lists it), impersonate `user1@orga.local`, change the name on **Account → Profile** and save, then stop impersonating and open Administrator → **Audit**. The `account.profile.updated` row names the **Superadmin** as the actor, not `user1`, and its metadata carries `impersonatedBetterAuthUserId` = `user1`'s id. The same holds for anything else done from the borrowed session, admin actions included, and for `deactivated_by` on a user soft-deleted from it (`src/lib/impersonation-attribution.server.ts`, applied by `auditEvent`).
7. Containing the admin ends the session they are impersonating from (F-08) → in browser A, sign in as `orgadmin@orga.local` and impersonate `user1@orga.local`. In browser B, sign in as `superuser@orga.local`, open `orgadmin@orga.local`'s detail and click **Revoke all** on the Sessions tab. Banning or deleting `orgadmin` from the Users list's bulk actions, or setting their password with `POST …/password` (`mode: "set"`), behaves the same for browser A. Setting the password also signs out every browser signed in as `orgadmin` themselves and revokes `orgadmin`'s API keys (F-10; see edge case 9). Reload browser A: it lands on sign-in, not on `user1`'s dashboard. The borrowed session belonged to `user1`, so it never appeared on `orgadmin`'s Sessions tab, and before F-08 it survived every one of those actions (`src/lib/impersonation-sessions.server.ts`). A completed password reset for `orgadmin` ends it too. So does `orgadmin` clicking **Sign out other sessions**, or changing their own password, from a third browser C (F-10, `src/lib/auth-session-sweep.ts`).
8. A borrowed session lasts one hour at most (F-08) → an hour after starting an impersonation, the next page load or API call signs the browser out, however active it has been; start again if you still need it. The limit is counted from the start of the impersonation and cannot be extended (`isImpersonationSessionPastMaxAge`, applied in `getCurrentSession`).
9. A new password ends the old credentials too (F-10) → sign in as `user5@orga.local` in browser A, open **Account → API keys** and create a key with the `account.read` scope ticked (a key with no scopes gets 403 from `GET /api/v1/me`), then call `GET /api/v1/me` with it (`Authorization: Bearer drk_…`, with `API_KEYS_ENABLED` on): 200. In browser B, as `superuser@orga.local`, set `user5`'s password with `POST /api/administrator/users/{id}/password` (`{"mode":"set","password":"…"}`): 200. Reload browser A: it lands on sign-in. Repeat the `GET /api/v1/me` call: **401**. Administrator → **Audit** shows `admin.user.password_set` plus one `api_key.revoked` row whose actor is the Superadmin and whose metadata has `reason: "password_set"`, and Administrator → **API keys** lists the key as revoked with reason `password_set`. A completed forgot-password reset for `user5` does the same, with `reason: "password_reset"` and `user5` as the actor. Changing the password on **Account → Security** does **not** revoke keys; it only signs out the other sessions (`src/lib/api-auth/credential-eviction.server.ts`).

Accessibility: the confirm dialog traps focus, closes on Esc, and the acknowledgement is a labelled checkbox gating the destructive action. No axe violations.
i18n: run `en` + `uk`; dialog title/description/acknowledgement and the error toast localize.

---

## Coverage matrix (this file)

Legend: **view** = can open/read the screen; **act** = can perform the screen's primary mutation. "—" = not applicable (no mutation on that screen).

| Screen / tab | Guard key(s) | Member | Limited Admin | Org Admin | Superadmin |
| --- | --- | --- | --- | --- | --- |
| Admin layout | any `admin.*` | 404 | view | view | view |
| Overview | any admin (+ per-card reads) | 404 | view (Users card only) | view (own org) | view (system) |
| Users list | `admin.users.read` (view); create/bulk keys (act) | 404 | view; act: approve/block only | view + all acts (own org) | view + all acts (all orgs) |
| Create user | `admin.users.create` | 404 | 404 | act | act |
| User detail | `admin.users.read` | 404 | view | view | view |
| — Overview tab | `admin.users.read` | 404 | view | view | view |
| — Roles tab | read `admin.users.read`; act `admin.roles.assign` | 404 | view; no act | view + act | view + act |
| — Groups tab | read `admin.groups.read`; act `admin.groups.assign` | 404 | tab absent (#76); API 403 | view + act | view + act |
| — Memberships tab | read `admin.users.read`; act `admin.users.update` | 404 | view; no act | view + act | view + act |
| — Sessions tab | `admin.users.sessions` (read + act) | 404 | tab absent (#76); API 403 | view + act (shared-target caveat) | view + act |
| — Audit tab | `admin.audit.read` | 404 | view (tab present) | view | view |
| Impersonate | `admin.users.impersonate` | 404 | button absent | act | act |

## Coverage checklist (this file's inventory)

- [x] Admin layout guard — happy (S2) + negative 404 (S1).
- [x] Console overview — happy (S1/S2) + partial-permission (S3) + empty state.
- [x] Users list — search/filter/sort (S1), bulk approve (S2), partial-permission + refused ban (S3), CSV export (S4), 404/scoping/rate-limit negatives.
- [x] Create user — happy (S1), validation incl. 409 (S2), 404 for non-creator (S3), rate-limit + concurrency.
- [x] User detail — happy (S1) + cross-tenant 404 (S2), non-UUID negative.
- [x] Overview tab, Roles tab, Groups tab, Memberships tab, Sessions tab, Audit tab — each with a can/cannot persona pair and its own negatives.
- [x] Impersonation journey — start/stop (S1) + escalation refusals (S2).
- [x] 404-not-403 asserted at both page level (Member/Limited Admin) and resource level (cross-tenant id).
- [x] Per-persona nav/tab/CTA visibility asserted (sidebar link ↔ page guard; hidden "New user" CTA; hidden mutate buttons; gated Audit tab).

## `TODO: verify` items

1. **Limited Admin fixture** — no seed creates a user whose only role is `admin`; a tester must assign it manually (or add an `admin`-only fixture) to run the partial-permission stories. (`baseline-roles.ts:27-31`, `dev-init.ts:249`.)
2. **"No audit" persona** — every seeded admin role includes `admin.audit.read`, so ADMIN-USERS-DETAIL-AUDIT-S2 needs a hand-built role that omits it.
3. **New-user locale set** — the create form offers only `en`/`es`/`fr`/`uk` (`_new-user-form.tsx:30`) vs. the app's 8 locales; confirm the narrower admin set is intentional.
4. **Impersonation escalation target in scope** — ADMIN-USERS-IMPERSONATE-S2 step 2 assumes `superuser@orga.local` is resolvable by `orgadmin@orga.local` (same ORG A). Confirm the superuser holds an ORG A membership so the 403 path (not a 404) is what a tester observes. (If the superuser is out of the org admin's scope, the observed result is 404, not the 403 escalation refusal.)
