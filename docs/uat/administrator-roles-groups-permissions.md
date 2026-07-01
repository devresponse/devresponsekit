---
title: "UAT — Administrator: Roles, Groups & Permissions"
description: Screen-by-screen User Acceptance Testing stories for the administrator Roles, Groups, and Permissions console areas — runnable by testers and doubling as living documentation.
group: QA
visibility: internal
order: 40
---

# UAT — Administrator: Roles, Groups & Permissions

This is the screen-by-screen UAT story set for the RBAC-management corner of the administrator console: application **Roles** (and their permission editor + members), organization **Groups** (roles editor, members, settings), and the platform **Permissions** catalog. It is dual-purpose: a non-technical tester can run each numbered script, and a reader learns what each screen is, who may use it, and what it does.

Every statement below was validated against the code; each screen cites the guard and route it exercises. Anything that could not be verified is marked `TODO: verify`.

## Test environment and accounts

- Seed the personas with `pnpm db:seed:dev` (fixture `src/db/seeds/dev-init.ts`). It creates three organizations (`orga.local`, `orgb.local`, `orgc.local`), and in ORG A two demo groups — **Engineering** (confers the `admin` role; members `user1`, `user2`) and **Customer Support** (confers the `member` role; members `user3`, `user4`).
- Base URL for local runs: `http://localhost:3000`. Sign in at `/en/sign-in`. Run each story once in `en` and once in a non-Latin locale (`uk` or `ja`) to check i18n.
- Dev password is the shared fixture password printed by the seed script.

| Persona | Seed account | Seed role → effective access |
| --- | --- | --- |
| **Superadmin** | `superuser@orga.local` | role `superuser` — holds the `superuser` marker; the effective set is the full catalog across **every** org. The only persona that may mutate the permission catalog or bundle a `superuser`-granting role. |
| **Org Admin** | `orgadmin@orga.local` | role `admin.platform` — the full `admin.*` catalog (including `.assign`, `.delete`, and `admin.permissions.manage`) but **no** `superuser` marker, so scoped to ORG A only. |
| **Limited Admin** | a `user*` account granted the seed `admin` role | role `admin` holds only `shell.view`, `admin.users.read`, `admin.users.manage`, `admin.audit.read` — **no** `admin.roles.*` / `admin.groups.*` / `admin.permissions.*` keys. Used to prove partial-permission gating (should 404 on every screen here). |
| **Member** | `user1@orga.local` | role `member` — `shell.view` only; no admin. |
| **Visitor** | unauthenticated | public pages only. |

Reset between runs by re-running the seed (it is idempotent for structure; drop/rebuild the DB for a clean slate).

### Permission keys used on these screens

Validated in `src/lib/admin/permissions.ts` (`ADMIN_PERMISSION_CATALOG`):

- Roles: `admin.roles.read`, `admin.roles.create`, `admin.roles.update`, `admin.roles.delete`, `admin.roles.assign`.
- Groups: `admin.groups.read`, `admin.groups.create`, `admin.groups.update`, `admin.groups.delete`, `admin.groups.assign`.
- Permissions: `admin.permissions.manage` (plus `admin.roles.read` to merely view the catalog).
- Marker: `superuser` (`SUPERADMIN_PERMISSION`).

### Cross-cutting rules that every screen here inherits

- **404-not-403 for out-of-scope resources.** Every `[id]` route resolves the row, then calls `canAccessOrg(access, orgId)` (`src/lib/admin/access-scope.server.ts:66`) and returns **Not Found**, never Forbidden, on a miss — so an org admin cannot even confirm that another tenant's role/group exists. A global role (`organization_id IS NULL`) is reachable by Superadmin only.
- **Privilege-escalation guard (AUTHZ-3).** A non-Superadmin may never *confer* a permission they do not themselves hold. The subset test lives in `src/lib/admin/grantable-permissions.server.ts` (`unheldPermissionKeys`) and gates four mutations: attaching a permission to a role, bundling a role into a group, adding a member to a group, and duplicating a role. Each returns **403** on violation, which subsumes the older "only a Superadmin may bundle a `superuser`-granting role" rule.
- **Key is immutable.** Role / group / permission `key` is read-only after creation (audit rows reference it by string). Only `name` / `description` are editable.
- **Rate limiting.** Every mutating route calls `enforceRateLimit(...)` with `DEFAULT_ADMIN_MUTATION_LIMIT`; exceeding it returns a friendly throttle response.

---

## Roles

### UAT-ADMIN-RGP-ROLES-LIST: Roles list

- Route: `/app/administrator/roles`  ·  Example URL: `/en/app/administrator/roles`  ·  Code: `src/app/[locale]/(secure)/app/administrator/roles/page.tsx:22`
- Purpose: Paginated catalog of application roles with per-role permission and member counts; entry point to role detail, create, duplicate, and delete.
- Guard / who can access: `admin.roles.read` (`page.tsx:28`; `notFound()` on denial). The list feed `GET /api/administrator/roles` is scoped so an org admin sees only their org's roles; a Superadmin sees all, including Global roles.
- Access matrix:
  - Visitor → redirected to sign-in (secure shell).
  - Member → **404** (lacks `admin.roles.read`).
  - Limited Admin (`admin`) → **404** (role `admin` has no `admin.roles.*`).
  - Org Admin → sees ORG A roles; "New role" / row "Delete" / "Duplicate" visible (holds create/delete).
  - Superadmin → sees every org's roles plus Global roles; the Organization column disambiguates same-key roles.
- Preconditions & test data: seed data present; sign in per persona.

User stories

- UAT-ADMIN-RGP-ROLES-LIST-S1 — As an Org Admin, I want to browse my org's roles, so that I can find the one to edit.
  - Acceptance criteria: Given I hold `admin.roles.read`, when I open the page, then a grid lists roles with columns Key, Name, Scope, Organization, Permission count, Member count, Created, and only my org's roles appear.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; go to `/en/app/administrator/roles` | The Roles grid renders with a heading and rows |
    | 2 | Read the Scope column | Rows show a Global or Org badge; only ORG A org-scoped roles are listed (no Global rows for an org admin) |
    | 3 | Type `admin` into the grid search box | The list filters to roles whose key or name contains "admin" |
    | 4 | Click the Permission count column header | Rows re-sort by permission count |
    | 5 | Click a role's key (e.g. `admin`) | You navigate to that role's detail page |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-LIST-S2 — As an Org Admin, I want to delete an unused role, so that the catalog stays tidy; and I want the app to stop me deleting one still in use.
  - Acceptance criteria: Given a role is bundled into a group or assigned to a user, when I confirm delete, then the request is refused with an inline "role is in use" message; given a role has no user and no group reference, when I confirm delete, then the row disappears.
  - Note: the delete guard `assertRoleNotInUse` counts both `app_user_roles` **and** `app_group_roles` (`src/lib/admin/roles.server.ts:130`), so a role bundled into a group but assigned to nobody still cannot be deleted.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Org Admin, in the Roles grid find the `admin` role (bundled into the Engineering group by the seed) | Its row shows a Delete button |
    | 2 | Click **Delete**, then confirm in the dialog | An inline red alert appears reading the localized "role in use" message; the row remains |
    | 3 | Create a throwaway role via **New role**, return to the list, and Delete it | The confirm dialog appears; on confirm the row disappears and the grid refreshes |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-LIST-S3 — As an Org Admin, I want to duplicate a role, so that I can start a new one from an existing permission set.
  - Acceptance criteria: Given I hold `admin.roles.create`, when I duplicate a role, then a copy is created with a `-copy` key suffix and I land on its detail page.
  - Note: duplicate is subject to the escalation guard — an org admin may only duplicate a role whose permissions are a subset of their own (`src/app/api/administrator/roles/[id]/duplicate/route.ts:71`).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Org Admin, click **Duplicate** on a role you could otherwise edit, and confirm | You are redirected to a new role whose key ends in `-copy` (or `-copy-2`, etc.) |
    | 2 | Open the new role's Permissions tab | The source role's permissions are pre-assigned |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-LIST-S4 — As a Member, I want the app to hide roles administration from me, so that I cannot reach it.
  - Acceptance criteria: Given I lack `admin.roles.read`, when I navigate to the roles URL directly, then I get **Not Found** (not Forbidden) and no roles nav link is shown.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local` | The secure shell loads; no Roles link in the admin nav |
    | 2 | Manually enter `/en/app/administrator/roles` | A **Not Found** page renders (404, never a 403 "Forbidden") |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Out-of-scope access → the list feed simply omits other orgs' roles; a Limited Admin gets 404 on the whole page.
- Empty state: with the org filtered to a tenant with no roles, the grid shows its empty message; loading shows skeleton rows.
- Delete of an in-use role → HTTP 409, surfaced inline as the localized "role in use" message (`_roles-grid.tsx:81`).
- Rate-limit: rapid repeated deletes/duplicates → friendly throttle response.

Accessibility: grid is keyboard-navigable; the confirm dialog traps focus and closes on Esc; row buttons are labelled.
i18n: run in `en` + `uk`/`ja`; column headers, badges, and dialog copy localize; no raw message keys.

### UAT-ADMIN-RGP-ROLES-NEW: Create role

- Route: `/app/administrator/roles/new`  ·  Example URL: `/en/app/administrator/roles/new`  ·  Code: `src/app/[locale]/(secure)/app/administrator/roles/new/page.tsx:19`
- Purpose: Create an application role, optionally scoped to an organization (or Global for a Superadmin).
- Guard / who can access: `admin.roles.create` (`page.tsx:25`). A Superadmin sees an Organization picker with a **Global** option; an Org Admin sees **no** picker and the role is forced into their own org (`page.tsx:32-39`).
- Access matrix: Visitor → sign-in; Member / Limited Admin → 404; Org Admin → form, no picker; Superadmin → form with org/Global picker.
- Preconditions & test data: signed in with create rights.

User stories

- UAT-ADMIN-RGP-ROLES-NEW-S1 — As an Org Admin, I want to create a role in my org, so that I can define a new bundle of permissions.
  - Acceptance criteria: Given valid input, when I submit, then a role is created in my org and I land on its detail page; the `key` must match the allowed pattern and be unique in the org.
  - Field rules (`src/lib/validation/roles.ts`): `key` required, ≤120 chars, pattern `^[a-zA-Z0-9_.\-:]+$`; `name` required, ≤200; `description` optional, ≤1000.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Org Admin, open **New role** | A form shows a required legend, Key, Name, Description; no organization picker |
    | 2 | Submit with everything blank | Key and Name show inline required errors with a red border; no navigation |
    | 3 | Enter Key `qa test!` (a space and `!`) | A pattern validation error appears on Key |
    | 4 | Fix Key to `qa-test`, add a Name, submit | You are redirected to the new role's detail page |
    | 5 | Create another role reusing Key `qa-test` | The Key field shows the localized "key taken" error (HTTP 409) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-NEW-S2 — As a Superadmin, I want to create a Global or org-scoped role, so that I can manage platform-wide and tenant roles.
  - Acceptance criteria: Given the Global option, when I create a role with scope Global, then it has no owning org; when I pick an org, then it is scoped to that org. (An org admin attempting a Global role is rejected 403 server-side — `roles/route.ts:216`.)
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As `superuser@orga.local`, open **New role** | The form shows an Organization picker including a **Global** option |
    | 2 | Choose **Global**, fill Key/Name, submit | The new role's detail header shows a **Global** badge |
    | 3 | Create another role, pick ORG B in the picker, submit | The role is created scoped to ORG B |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Required-field validation on Key and Name; the `*` markers appear via the required legend; pattern + length limits enforced client- and server-side (shared schema).
- Duplicate key → 409 mapped onto the Key field.
- Org Admin submitting a forged Global/foreign org → 403 (mapped to a root form error).
- Rate-limit on create.

Accessibility: labelled inputs, required legend, error text tied to fields, keyboard submit.
i18n: labels + validation messages localize.

### UAT-ADMIN-RGP-ROLES-DETAIL: Role detail (tabs)

- Route: `/app/administrator/roles/[roleId]`  ·  Example URL: `/en/app/administrator/roles/<uuid>`  ·  Code: `src/app/[locale]/(secure)/app/administrator/roles/[roleId]/page.tsx:26`
- Purpose: View and manage one role — a dual-list **Permissions** editor, a **Members** grid, and a **Settings** form.
- Guard / who can access: `admin.roles.read` to open (`page.tsx:33`); a non-UUID id or an out-of-scope role returns **404** (`page.tsx:37`, `:53`). Edit affordances require `admin.roles.update` (passed as `canUpdate`).
- Access matrix: Member / Limited Admin → 404; Org Admin → their org's roles editable; Superadmin → any role including Global; a role in another org → 404 for the org admin.
- Preconditions & test data: know a role UUID (click through from the list).

Tabs: **Permissions** (default), **Members**, **Settings** (`_role-detail-tabs.tsx:30`).

User stories

- UAT-ADMIN-RGP-ROLES-DETAIL-S1 — As an Org Admin, I want to add and remove permissions on a role using the dual-list editor, so that I can shape what the role grants.
  - Acceptance criteria: Given the editor, when I move keys between Available and Assigned and click Save, then the server persists the diff (one POST for additions, one DELETE for removals) and the Saved confirmation appears; the Save button is disabled until there is a change.
  - Escalation note: a non-Superadmin may only **add** permission keys they themselves hold; requesting an unheld key returns **403** (`src/app/api/administrator/roles/[id]/permissions/route.ts:136`). This blocks granting `superuser` (never in a non-superadmin's held set).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open a role you can edit; the **Permissions** tab is active | Two columns render: Available (left) and Assigned (right), each with a search box and a count |
    | 2 | Select one or more keys in Available, click **Add** | They move to the Assigned column; Save becomes enabled |
    | 3 | Type into the Available search box | The left list filters; the count updates |
    | 4 | Select an Assigned key, click **Remove** | It moves back to Available |
    | 5 | Click **Save** | A green "saved" status appears; reload the page and the Assigned set matches |
    | 6 | (Org Admin only) Try to add a permission you do not hold, then Save | The save is refused with the localized error (server 403); the assigned set is unchanged after reload |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-DETAIL-S2 — As an Org Admin, I want to see who holds a role, so that I understand its blast radius before editing.
  - Acceptance criteria: Given the Members tab, when I open it, then a grid lists users carrying this role with email, name, organization, and assigned-at date; each email links to that user's detail.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | On a role that has members (e.g. `member`), click the **Members** tab | A paginated grid of users renders |
    | 2 | Click a member's email | You navigate to that user's admin detail page |
    | 3 | Type a name/email fragment into the grid search | The member list filters |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-DETAIL-S3 — As an Org Admin, I want to rename a role and edit its description, so that its label stays meaningful; the key must stay fixed.
  - Acceptance criteria: Given the Settings tab, when I change Name/Description and Save, then it persists; the Key field is read-only; Name is required.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Click the **Settings** tab | Key shows as read-only with a hint; Name and Description are editable |
    | 2 | Clear the Name and Save | A required validation error appears; nothing is saved |
    | 3 | Restore a Name, edit Description, Save | A green "saved" status appears |
    | 4 | Attempt to edit the Key field | It is not editable (read-only) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-ROLES-DETAIL-S4 — As an Org Admin, I want another tenant's role to be invisible, so that cross-tenant existence never leaks.
  - Acceptance criteria: Given a role UUID that belongs to another org (or a Global role), when I open its detail URL, then I get **Not Found** (never Forbidden).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Superadmin, note a role UUID owned by ORG B (or a Global role) | You have a valid id from another scope |
    | 2 | Sign in as `orgadmin@orga.local` and open `/en/app/administrator/roles/<that-uuid>` | A **Not Found** page renders (404, not 403) |
    | 3 | Open `/en/app/administrator/roles/not-a-uuid` | A **Not Found** page renders (invalid id) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Permissions editor initial catalog load failure → inline `role="alert"` error instead of a stuck skeleton.
- Read-only viewer without `admin.roles.update`: `TODO: verify` — `page.tsx` guards on `admin.roles.read`; with `canUpdate=false` the editor's move/Save buttons and Settings inputs are disabled, but confirm a plausible persona can reach this state (the seed `admin.platform` holds both read and update, so this needs a custom role to exercise).
- Members tab empty state / loading skeleton.
- Settings: Name required; 400 → localized invalid-body message; 403 → localized forbidden message.
- Concurrency: `TODO: verify` — the PATCH/permissions routes do not use If-Match/ETag, so last-write-wins; no stale-write UI is expected.

Accessibility: tabs are keyboard-operable; the dual-list uses a labelled multi-select (`<select multiple>`); status/alert regions announce results; visible focus throughout.
i18n: tab labels, column headers, editor labels, and status messages localize.

---

## Groups

### UAT-ADMIN-RGP-GROUPS-LIST: Groups list

- Route: `/app/administrator/groups`  ·  Example URL: `/en/app/administrator/groups`  ·  Code: `src/app/[locale]/(secure)/app/administrator/groups/page.tsx:18`
- Purpose: Paginated list of organization groups (cohorts that bundle roles) with role and member counts; entry to group detail, create, and delete.
- Guard / who can access: `admin.groups.read` (`page.tsx:24`). Feed `GET /api/administrator/groups` is org-scoped; groups are **always** tenant-scoped (no Global groups), so an org admin with no resolvable org gets an empty page.
- Access matrix: Visitor → sign-in; Member / Limited Admin → 404; Org Admin → ORG A groups, "New group" + row Delete visible (holds create/delete); Superadmin → all orgs' groups.
- Preconditions & test data: ORG A seed groups Engineering and Customer Support exist.

User stories

- UAT-ADMIN-RGP-GROUPS-LIST-S1 — As an Org Admin, I want to browse groups, so that I can manage cohorts.
  - Acceptance criteria: Given `admin.groups.read`, when I open the page, then a grid lists groups with Key, Name, Role count, Member count, Created; only my org's groups appear.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open `/en/app/administrator/groups` | The grid renders with the two seed groups (Engineering, Customer Support) |
    | 2 | Read the Role count / Member count columns | Engineering shows 1 role and 2 members; Customer Support shows 1 role and 2 members |
    | 3 | Type `eng` into search | The list filters to Engineering |
    | 4 | Click the Engineering key | You navigate to its detail page |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-GROUPS-LIST-S2 — As an Org Admin, I want to delete a group, so that I can remove a cohort; deletion should not strip roles that users hold directly.
  - Acceptance criteria: Given `admin.groups.delete`, when I confirm delete, then the group and its role bundles + memberships cascade away, but a member keeps any role assigned to them directly. (There is no in-use block on group delete — `src/app/api/administrator/groups/[id]/route.ts:106`.)
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Create a throwaway group via **New group** with a member added | A new group exists |
    | 2 | In the grid, click its **Delete**, confirm | The group row disappears; the grid refreshes |
    | 3 | Open the former member's user detail | The user retains any directly-assigned role; only the group-conferred access is gone |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-GROUPS-LIST-S3 — As a Limited Admin, I want groups administration hidden, so that I cannot reach it.
  - Acceptance criteria: Given the seed `admin` role (no `admin.groups.read`), when I open the groups URL, then I get **Not Found**.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Sign in as the Limited Admin account | No Groups nav link is shown |
    | 2 | Enter `/en/app/administrator/groups` directly | A **Not Found** page renders (404, not 403) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Empty state (org with no groups) shows the grid empty message; loading shows skeletons.
- Group delete failure → inline generic error (`_groups-grid.tsx:63`).
- Rate-limit on delete.

Accessibility: keyboard grid; confirm dialog focus-trap + Esc; labelled row actions.
i18n: headers + dialog copy localize.

### UAT-ADMIN-RGP-GROUPS-NEW: Create group

- Route: `/app/administrator/groups/new`  ·  Example URL: `/en/app/administrator/groups/new`  ·  Code: `src/app/[locale]/(secure)/app/administrator/groups/new/page.tsx:16`
- Purpose: Create an organization group (always tenant-scoped).
- Guard / who can access: `admin.groups.create` (`page.tsx:18`). A Superadmin must pick a target org (**no** Global option); an Org Admin sees no picker and the group is forced into their org server-side (`groups/route.ts:136-150`).
- Access matrix: Visitor → sign-in; Member / Limited Admin → 404; Org Admin → form, no picker; Superadmin → form with a required org picker.
- Preconditions & test data: create rights.

User stories

- UAT-ADMIN-RGP-GROUPS-NEW-S1 — As an Org Admin, I want to create a group, so that I can bundle roles for a cohort.
  - Acceptance criteria: Given valid input, when I submit, then the group is created in my org and I land on its detail page; `key` pattern + uniqueness enforced.
  - Field rules (`src/lib/validation/groups.ts`): `key` required ≤120, pattern `^[a-zA-Z0-9_.\-:]+$`; `name` required ≤200; `description` optional ≤1000.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Org Admin, open **New group** | Form shows required legend, Key, Name, Description; no org picker |
    | 2 | Submit blank | Key and Name show required errors |
    | 3 | Enter Key `support team` (a space) | Pattern error on Key |
    | 4 | Fix Key to `support-team`, add Name, submit | Redirected to the new group's detail page |
    | 5 | Reuse the same Key | "Key taken" error on Key (409) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-GROUPS-NEW-S2 — As a Superadmin, I want to create a group in a chosen org, so that I can set up cohorts for any tenant.
  - Acceptance criteria: Given the org picker (no Global option), when I submit without choosing an org, then a client validation error asks me to pick one; when I choose one, the group is created there.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Superadmin, open **New group** | The form shows an Organization picker with **no** Global option |
    | 2 | Fill Key/Name, leave the org unset, submit | An "organization required" error appears on the picker; no navigation |
    | 3 | Choose ORG B, submit | The group is created in ORG B and you land on its detail page |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Required-field validation; `*` markers via the required legend; pattern/length via shared schema.
- Superadmin missing org → 400 "organization required".
- Duplicate key → 409 on Key.
- Rate-limit on create.

Accessibility: labelled inputs, required legend, keyboard submit; the org picker is a labelled combobox.
i18n: labels + messages localize.

### UAT-ADMIN-RGP-GROUPS-DETAIL: Group detail (tabs)

- Route: `/app/administrator/groups/[groupId]`  ·  Example URL: `/en/app/administrator/groups/<uuid>`  ·  Code: `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/page.tsx:17`
- Purpose: Manage one group across three tabs — **Roles** (the roles it confers), **Members** (users in it), **Settings** (name/description).
- Guard / who can access: `admin.groups.read` to open; non-UUID or out-of-scope group → **404** (`page.tsx:28`, `:33`). The Roles and Members tabs' add/remove actions require `admin.groups.assign` (`canAssign`); Settings requires `admin.groups.update` (`canUpdate`).
- Access matrix: Member / Limited Admin → 404; Org Admin → their group, fully manageable; Superadmin → any group; another org's group → 404 for the org admin.
- Preconditions & test data: use the ORG A seed groups; Engineering already confers `admin` with members user1/user2.

Tabs default to **Roles** (`_group-detail-tabs.tsx:32`).

#### UAT-ADMIN-RGP-GROUPS-DETAIL-ROLES: Roles tab (dual-list editor)

- Code: `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-roles-editor.tsx`; route `src/app/api/administrator/groups/[id]/roles/route.ts`.
- Purpose: Choose which roles the group confers on its members. Left = the org's role catalog (scoped to the group's own org) minus already-bundled; right = bundled.

User stories

- UAT-ADMIN-RGP-GROUPS-DETAIL-ROLES-S1 — As an Org Admin, I want to bundle and unbundle roles on a group, so that its members gain or lose those roles.
  - Acceptance criteria: Given `admin.groups.assign`, when I move roles between columns and Save, then the diff persists (one POST, one DELETE) and a Saved status appears; only roles in the group's own org are offered (a foreign/global role would 404 on save, so the list excludes them).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open the Engineering group; the **Roles** tab is active | Two labelled columns render; Assigned already contains the `admin` role |
    | 2 | Select a role in Available, click **Add**, then **Save** | A "saved" status appears; the role is now bundled |
    | 3 | Select a bundled role, click **Remove**, **Save** | The role is unbundled; reload confirms the set |
    | 4 | Confirm the Available column shows only ORG A roles | No other org's or Global roles appear |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-GROUPS-DETAIL-ROLES-S2 — As an Org Admin, I must not be able to bundle a role that out-authorizes me, so that I cannot escalate via a group.
  - Acceptance criteria: Given a role whose conferred permissions include a key I do not hold (e.g. a `superuser`-granting role), when I try to bundle it and Save, then the server returns **403** and the editor shows the localized "forbidden" message. (Guard: `src/app/api/administrator/groups/[id]/roles/route.ts:125`, using `permissionKeysForRoles` + `unheldPermissionKeys`.)
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Superadmin, ensure ORG A has a role carrying `superuser` (or a permission the org admin lacks) | Such a role exists in ORG A |
    | 2 | Sign in as `orgadmin@orga.local`, open a group, add that role, **Save** | The save fails with the localized **forbidden** message (HTTP 403); the bundle is unchanged |
    | 3 | As Superadmin, repeat the bundle on the same group | The Save succeeds (Superadmin bypasses the subset check) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Initial load failure → inline `role="alert"` error instead of a stuck skeleton (`_group-roles-editor.tsx:216`).
- Save with no change: Save button disabled until dirty.
- 403 on add → localized forbidden; other failures → generic error toast.

Accessibility: labelled multi-selects, keyboard operable, status/alert regions.
i18n: labels + statuses localize; the role label uses a `key — Organization` format (contains an em dash in the UI label only, not a linked heading).

#### UAT-ADMIN-RGP-GROUPS-DETAIL-MEMBERS: Members tab (add / remove)

- Code: `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-members-grid.tsx`; user picker `_user-picker.tsx`; route `src/app/api/administrator/groups/[id]/members/route.ts`.
- Purpose: Add or remove users in the group. Adds are confined to **active** members of the group's org; a non-eligible pick is reported back.

User stories

- UAT-ADMIN-RGP-GROUPS-DETAIL-MEMBERS-S1 — As an Org Admin, I want to add a user to a group, so that they inherit the group's roles.
  - Acceptance criteria: Given `admin.groups.assign`, when I pick an active org member and submit, then they appear in the members grid; the user picker searches server-side and is org-scoped.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open a group, click the **Members** tab, click **Add member** | A dialog opens with a user picker |
    | 2 | Type part of an email; select an active ORG A user | The selection is shown in the picker |
    | 3 | Click the submit button in the dialog | The dialog closes and the grid refreshes to include the new member |
    | 4 | Click a member's email in the grid | You navigate to that user's admin detail page |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-GROUPS-DETAIL-MEMBERS-S2 — As an Org Admin, I want to remove a member, so that they lose the group's conferred roles.
  - Acceptance criteria: Given a member row, when I click Remove and confirm, then they are removed from the group (their directly-assigned roles are untouched).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | On the Members grid, click **Remove** on a row | A destructive confirm dialog appears showing the member's email |
    | 2 | Confirm | The row disappears; the grid refreshes |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-GROUPS-DETAIL-MEMBERS-S3 — As an Org Admin, I want a clear message when a pick is not eligible, so that I know why the add did nothing.
  - Acceptance criteria: Given a user who is not an active member of the group's org, when I try to add them, then the dialog shows a "not eligible" message rather than a false success. (Server returns `added: 0` / 404 for ineligible ids — `members/route.ts:146-157`; the client surfaces `notEligible` — `_group-members-grid.tsx:102`.)
  - Escalation note: adding a member is itself a conferral — a non-Superadmin can only add members to a group whose conferred permissions are a subset of their own; otherwise the add returns **403** (`members/route.ts:140`).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open Add member on an ORG A group; via search attempt to select a user not active in ORG A (if surfaced) | On submit, an inline "not eligible" message appears; no member added |
    | 2 | (Org Admin) On a group that confers a role you lack the permissions of, try to add any member | The add is refused with the localized forbidden message (403) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Add error → inline `role="alert"` in the dialog; remove error → inline alert above the grid.
- Empty members grid state; loading skeleton.
- Rate-limit on add/remove.

Accessibility: dialog focus-trap + Esc; the user picker is a labelled combobox with a live search; grid keyboard-navigable.
i18n: dialog + grid copy localize.

#### UAT-ADMIN-RGP-GROUPS-DETAIL-SETTINGS: Settings tab

- Code: `src/app/[locale]/(secure)/app/administrator/groups/[groupId]/_group-settings-form.tsx`; route `src/app/api/administrator/groups/[id]/route.ts` (PATCH).
- Purpose: Edit the group's name and description; the key is read-only.

User stories

- UAT-ADMIN-RGP-GROUPS-DETAIL-SETTINGS-S1 — As an Org Admin, I want to rename a group and edit its description, so that its label stays meaningful.
  - Acceptance criteria: Given `admin.groups.update`, when I change Name/Description and Save, then it persists; Key is read-only; Name is required.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open a group, click the **Settings** tab | Key shows read-only with a hint; Name and Description editable |
    | 2 | Clear Name, Save | A required validation error appears |
    | 3 | Restore Name, edit Description, Save | A green "saved" status appears |
    | 4 | Try to edit Key | Not editable |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- 400 invalid body → localized message; 403 → localized forbidden; both surface as `role="alert"`.
- Read-only viewer without `admin.groups.update`: inputs and Save disabled (`canUpdate=false`). `TODO: verify` a persona that reaches read-without-update (seed `admin.platform` holds both).

Accessibility: labelled inputs, required legend when editable, status/alert regions.
i18n: labels + messages localize.

- UAT-ADMIN-RGP-GROUPS-DETAIL-S-404 — As an Org Admin, I want another tenant's group to be invisible.
  - Acceptance criteria: Given a group UUID owned by another org, when I open it, then I get **Not Found**.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As Superadmin note a group UUID in ORG B | A valid foreign id |
    | 2 | As `orgadmin@orga.local` open `/en/app/administrator/groups/<that-uuid>` | A **Not Found** page (404, not 403) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## Permissions

### UAT-ADMIN-RGP-PERMISSIONS-LIST: Permissions catalog

- Route: `/app/administrator/permissions`  ·  Example URL: `/en/app/administrator/permissions`  ·  Code: `src/app/[locale]/(secure)/app/administrator/permissions/page.tsx:18`
- Purpose: The platform-global permission catalog. Informational for any role-reader; each row shows the key, description, and how many roles use it (with a slide-over listing them).
- Guard / who can access: **`admin.roles.read`** opens the page (`page.tsx:24`) — note it is the *roles* read key, not a permissions key. Create/Edit/Delete buttons appear only with `admin.permissions.manage` (`page.tsx:28`).
- Important escalation nuance: **all catalog mutations additionally require SUPERADMIN.** The POST/PATCH/DELETE routes reject a non-Superadmin with **403** even if they somehow hold `admin.permissions.manage`, because the catalog is platform-global (`src/app/api/administrator/permissions/route.ts:104`; `[id]/route.ts:45` and `:110`). The seed `admin.platform` role *does* include `admin.permissions.manage`, so an Org Admin sees the buttons but every write 403s.
- Access matrix:
  - Visitor → sign-in.
  - Member → **404**.
  - Limited Admin (`admin`) → **404** (lacks `admin.roles.read`).
  - Org Admin (`admin.platform`) → **can view** the catalog and sees the manage buttons, but Create/Edit/Delete all fail with 403 (Superadmin-only writes).
  - Superadmin → full view + working create/edit/delete.
- Preconditions & test data: catalog is seeded from `ADMIN_PERMISSION_CATALOG`.

User stories

- UAT-ADMIN-RGP-PERMISSIONS-LIST-S1 — As an Org Admin, I want to read the permission catalog and see which roles use a permission, so that I understand the RBAC vocabulary.
  - Acceptance criteria: Given `admin.roles.read`, when I open the page, then a grid lists Key, Description, and "Used by N roles"; clicking the count opens a slide-over listing the roles, each linking to its detail.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open `/en/app/administrator/permissions` | The catalog grid renders |
    | 2 | Type `roles` into search | The list filters to keys/descriptions containing "roles" |
    | 3 | Click the "Used by N roles" number on a row | A slide-over panel lists the roles holding that permission |
    | 4 | Click **View role** on one | You navigate to that role's detail page |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-PERMISSIONS-LIST-S2 — As an Org Admin, I want the catalog to stay read-only for me, so that a platform-global change is reserved for a Superadmin.
  - Acceptance criteria: Given I am not a Superadmin, when I attempt an edit or delete, then the server refuses with 403 and an inline error; when I cannot even manage, the buttons are hidden.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As `orgadmin@orga.local`, note whether Edit/Delete buttons appear | They appear (the `admin.platform` role includes `admin.permissions.manage`) |
    | 2 | Click **Edit** on a row, change the description, submit | `TODO: verify` exact copy — the edit sheet handles 400 explicitly; a 403 falls through to the generic edit-error message. Expected: the change does not persist (reload shows the original) |
    | 3 | Click **Delete** on a row and confirm | The delete is refused (403); the row remains |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-PERMISSIONS-LIST-S3 — As a Superadmin, I want to edit a permission's description and delete an unused one, so that I can curate the catalog.
  - Acceptance criteria: Given Superadmin, when I edit a description and save, then it persists; when I delete a permission still attached to a role, then it is refused with "permission in use" (409); an unused one deletes.
  - Note: delete is blocked when any `app_role_permissions` row references it (`assertPermissionNotInUse`, `roles.server.ts:175`); the key is read-only in edit.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As `superuser@orga.local`, click **Edit** on a permission | A slide-over shows the Key disabled and an editable Description |
    | 2 | Change the Description, submit | The sheet closes and the grid refreshes with the new description |
    | 3 | Click **Delete** on a permission that is attached to a role (e.g. `admin.users.read`), confirm | An inline "permission in use" error appears (409); the row remains |
    | 4 | Create a throwaway permission (see Create screen), then Delete it while unused | The confirm dialog appears; on confirm the row disappears |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-PERMISSIONS-LIST-S4 — As a Member, I want the catalog hidden, so that I cannot reach it.
  - Acceptance criteria: Given no `admin.roles.read`, when I open the URL, then I get **Not Found**.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local` | No Permissions nav link |
    | 2 | Enter `/en/app/administrator/permissions` | A **Not Found** page (404, not 403) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Empty search result / loading skeleton in the grid.
- Delete of an in-use permission → 409 surfaced inline as the localized "permission in use" message (`_permissions-grid.tsx:64`).
- Non-Superadmin write → 403 (from the route; UI copy varies by control — see S2 `TODO: verify`).
- Rate-limit on create/edit/delete.

Accessibility: grid keyboard-navigable; the edit and "roles using" panels are slide-over Sheets with focus management; confirm dialog focus-trap + Esc.
i18n: headers, sheet titles, and messages localize.

### UAT-ADMIN-RGP-PERMISSIONS-NEW: Create permission

- Route: `/app/administrator/permissions/new`  ·  Example URL: `/en/app/administrator/permissions/new`  ·  Code: `src/app/[locale]/(secure)/app/administrator/permissions/new/page.tsx:16`
- Purpose: Add a new key to the platform-global permission catalog. Adding a permission alone grants no power — it must later be attached to a role.
- Guard / who can access: the page gates on `admin.permissions.manage` (`page.tsx:23`); the POST route **additionally requires SUPERADMIN** (`permissions/route.ts:104`). So an Org Admin can open the form (they hold `admin.permissions.manage` via `admin.platform`) but the submit returns 403.
- Access matrix: Visitor → sign-in; Member / Limited Admin → 404; Org Admin → form opens but submit 403s; Superadmin → form works.
- Preconditions & test data: `admin.permissions.manage` to open.

User stories

- UAT-ADMIN-RGP-PERMISSIONS-NEW-S1 — As a Superadmin, I want to add a permission to the catalog, so that a new capability key exists.
  - Acceptance criteria: Given valid input, when I submit, then the permission is created and I return to the catalog list; `key` pattern + uniqueness enforced.
  - Field rules (`src/lib/validation/permissions.ts`): `key` required ≤120, pattern `^[a-zA-Z0-9_.\-:]+$`; `description` optional ≤1000.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | As `superuser@orga.local`, open **New permission** | Form shows required legend, Key, Description |
    | 2 | Submit blank | Key shows a required error |
    | 3 | Enter Key `feature x` (a space) | Pattern error on Key |
    | 4 | Fix Key to `feature.x.read`, submit | You return to the catalog and the new permission is listed |
    | 5 | Create another with the same Key | "Key taken" error on Key (409) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-RGP-PERMISSIONS-NEW-S2 — As an Org Admin, I must not be able to create a catalog permission, so that a platform-global change is Superadmin-only.
  - Acceptance criteria: Given I am not a Superadmin, when I submit the form, then the server returns 403 and a root form error appears; no permission is created.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`; open `/en/app/administrator/permissions/new` | The form opens (the role holds `admin.permissions.manage`) |
    | 2 | Fill a valid Key, submit | A localized **forbidden** root error appears (HTTP 403); nothing is created |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Required + pattern + length validation on Key; the `*` marker via the required legend.
- Duplicate key → 409 on Key; non-Superadmin → 403 root error; invalid body → 400 root error.
- Rate-limit on create.

Accessibility: labelled inputs, required legend, keyboard submit, error tied to field.
i18n: labels + messages localize.

---

## Coverage matrix (screens × personas)

Legend: **view** = can open/read; **act** = can perform the screen's mutations; **404** = Not Found (out of scope / ungated); n/a = not applicable.

| Screen | Visitor | Member | Limited Admin (`admin`) | Org Admin (`admin.platform`) | Superadmin |
| --- | --- | --- | --- | --- | --- |
| Roles list | sign-in | 404 | 404 | view + act (own org) | view + act (all + Global) |
| Roles / new | sign-in | 404 | 404 | act (own org) | act (org or Global) |
| Role detail | sign-in | 404 | 404 | view + act (own org) | view + act (any) |
| Groups list | sign-in | 404 | 404 | view + act (own org) | view + act (all) |
| Groups / new | sign-in | 404 | 404 | act (own org) | act (chosen org) |
| Group detail — Roles | sign-in | 404 | 404 | act (subset-limited) | act (any) |
| Group detail — Members | sign-in | 404 | 404 | act (subset-limited, active org members) | act (any) |
| Group detail — Settings | sign-in | 404 | 404 | act (own org) | act (any) |
| Permissions list | sign-in | 404 | 404 | **view only** (writes 403) | view + act |
| Permissions / new | sign-in | 404 | 404 | form opens, **submit 403** | act |

## Inventory checklist

- [x] `roles` (list) — UAT-ADMIN-RGP-ROLES-LIST
- [x] `roles/new` — UAT-ADMIN-RGP-ROLES-NEW
- [x] `roles/[roleId]` detail + Permissions/Members/Settings tabs — UAT-ADMIN-RGP-ROLES-DETAIL
- [x] `groups` (list) — UAT-ADMIN-RGP-GROUPS-LIST
- [x] `groups/new` — UAT-ADMIN-RGP-GROUPS-NEW
- [x] `groups/[groupId]` detail — Roles / Members / Settings tabs — UAT-ADMIN-RGP-GROUPS-DETAIL-*
- [x] `permissions` (list) + edit/roles-using sheets — UAT-ADMIN-RGP-PERMISSIONS-LIST
- [x] `permissions/new` — UAT-ADMIN-RGP-PERMISSIONS-NEW
- [x] 404-not-403 asserted per gated screen (a can-persona and a cannot-persona each)
- [x] Privilege-escalation guard covered (role permissions add, group role bundle, group member add, role duplicate)
- [x] Required-field validation, empty/loading/error states, a11y + i18n notes per screen

## TODO: verify items

1. **Read-without-update personas.** The seed `admin.platform` role holds both `admin.roles.read`+`admin.roles.update` and both `admin.groups.read`+`admin.groups.update`, so the "viewer sees disabled editor/Settings" branches (`canUpdate=false`) are not exercisable by a stock persona. Confirm by minting a custom role with only the `.read` key, or drop this assertion.
2. **Permissions catalog: exact 403 copy for a non-Superadmin.** The edit sheet (`_permissions-grid.tsx:220`) handles 400 explicitly but lets a 403 fall through to the generic `edit.errorToast`; the list delete maps 409 but not 403 specifically. Confirm the exact on-screen message a non-Superadmin sees on edit/delete (behaviorally the write is refused and nothing persists).
3. **Concurrency / stale writes.** No route in this area uses If-Match/ETag; edits are last-write-wins. Confirmed absent in code, but flag if UAT expects an optimistic-concurrency prompt anywhere here.
4. **Limited Admin fixture.** The seed does not create a standing account with only the `admin` role assigned to a login; the `admin` role is bundled into the Engineering group. To exercise the "Limited Admin → 404" rows directly, assign the `admin` role to a test user (e.g. via the Roles tab on a user) or rely on the Engineering-group members inheriting it.
