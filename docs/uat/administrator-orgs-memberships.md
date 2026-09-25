---
title: "UAT — Administrator: Organizations & Memberships"
description: Screen-by-screen UAT user stories for the Administrator organizations list, create, detail (Members/Providers/Settings), and the cross-org memberships admin, with a SUPERADMIN vs ORG ADMIN access matrix.
group: QA
visibility: internal
order: 50
---

# UAT — Administrator: Organizations & Memberships

User Acceptance Testing stories for the **tenancy** area of the Administrator console: the organizations list, the create-organization form, the organization detail (Members / Providers / Settings tabs), and the cross-org memberships search. Each story is runnable by a non-technical tester and doubles as living documentation of what the screen is, who may use it, and what it does.

The area is anchored on a single load-bearing rule (ADR-0001): **the organization record itself is a platform-level, SUPERADMIN-only entity.** An Org Admin manages the *contents* of their one organization (members; viewing and removing provider bindings — creating one is Superadmin-only, F-04) but can never create, rename, re-status, set-default, or delete the organization record. Cross-tenant existence is never leaked: an out-of-scope organization returns **Not Found (404)**, not Forbidden.

## Key rules validated against code

| Rule | Behaviour | Source |
| --- | --- | --- |
| Read gate | List, detail, memberships, members, provider-bindings all require `admin.orgs.read` | `organizations/page.tsx:28`, `organizations/[orgId]/page.tsx:34`, `memberships/page.tsx:22`, `api/administrator/organizations/route.ts:39`, `api/administrator/memberships/route.ts:32` |
| Create gate | `/organizations/new` page and `POST` require `admin.orgs.create` | `organizations/new/page.tsx:20`, `api/administrator/organizations/route.ts:140` |
| Create is SUPERADMIN-only | Even with `admin.orgs.create`, a non-superadmin `POST` gets **403** | `api/administrator/organizations/route.ts:157` |
| Rename / status / default is SUPERADMIN-only | `PATCH` gates on `admin.orgs.update`, then blocks any non-superadmin with **403** | `api/administrator/organizations/[id]/route.ts:104,124` |
| Delete is SUPERADMIN-only | `DELETE` gates on `admin.orgs.delete`, then blocks any non-superadmin with **403** | `api/administrator/organizations/[id]/route.ts:279,295` |
| Org Admin sees only their org | List is scoped by `resolveOrgScope`; a null scope returns an empty list | `api/administrator/organizations/route.ts:52`, `lib/admin/access-scope.server.ts:51` |
| Cross-tenant detail is 404, not 403 | A foreign `orgId` returns `notFound()` / a 404 envelope, never 403 | `organizations/[orgId]/page.tsx:54`, `api/administrator/organizations/[id]/route.ts:57` |
| Delete of a default org | Blocked with **409** `organization_is_default`; re-checked inside the deleting transaction under the default-flag lock, so a delete racing a "Set as default" on the same org cannot remove the new default (F-40) | `api/administrator/organizations/[id]/route.ts:314,361`, `lib/admin/orgs.server.ts:120` |
| The default organization is the org flagged `is_default` (F-40) | Unmapped sign-ups (no invitation, `/sign-in/<org>` hint or email-domain binding) land in it under its policy, whatever its slug; no org is ever auto-created for them. *Set as default organization* (Settings, or `isDefault: true` on create/update) **moves** the flag, so exactly one org carries it; clearing it on the current default is refused with **409** `organization_is_default` and the checkbox is read-only there (on a legacy database's extra flag the checkbox stays enabled and unticking it clears that flag). A slug edit shows a warning (it breaks `/sign-in/<slug>` links and slug-configured env vars). `db:seed` keeps its platform roles and admin in the platform org, never in a moved default | `lib/default-organization.server.ts`, `lib/user-provisioning.server.ts`, `lib/auth-policy.server.ts` (`resolveSignupPolicy`), `api/administrator/organizations/[id]/route.ts` (PATCH), `_organization-settings-form.tsx`, `db/seeds/default-organization.ts` |
| Organization status is enforced (F-09) | Only an `active` org confers membership: a `pending` / `suspended` / `archived` org's members, org admins, bound credentials, SSO launches and invitations stop working, and a `superuser` grant held there confers nothing, until it is reactivated | `lib/auth-status.ts` (`getUserAccessContext`), `lib/admin/access-scope.server.ts` (`userIsGlobalSuperuser`) |
| Suspending the tenant that holds the last superuser grant | Blocked with **409** `last_superadmin` (REVOKE-2); reactivation is never blocked | `api/administrator/organizations/[id]/route.ts` (PATCH) |
| A membership's status only affects its own org (F-33) | A signed-in user acts in an **active** membership whenever they have one: the `active_org` cookie picks among active memberships, else the earliest active one. A suspended, blocked or pending membership is used only when the user has no active membership anywhere, which is what shows the blocked or pending-approval screen. Accepting an invitation sets the user's active org to the inviting org | `lib/auth-status.ts` (`getUserAccessContext`), `api/invitations/accept/route.ts` |
| Inviting into / resending for a non-active org | Blocked with **409** `organization_not_active`; revoke still works | `api/administrator/organizations/[id]/invitations/route.ts`, `…/[invitationId]/resend/route.ts` |
| Delete of a non-empty org | Blocked with **409** `organization_not_empty` (any membership, any status) | `api/administrator/organizations/[id]/route.ts:315`, `lib/admin/orgs.server.ts:104` |
| Delete of an org with other dependents (roles, bindings, apps, credentials) | FK violation translated to **409** `organization_in_use` | `api/administrator/organizations/[id]/route.ts:429` |
| Member / binding mutations | `POST`/`PATCH`/`DELETE` on members and bindings require `admin.orgs.update` (NOT `.delete`, NOT `.manage`); **creating** a binding additionally requires a Superadmin (F-04) | `api/administrator/organizations/[id]/members/route.ts:123,239,340`, `.../provider-bindings/route.ts:113,207` |

> `TODO: verify` — the catalog defines `admin.orgs.manage` ("Manage organization members and bindings", `lib/admin/permissions.ts:49`) but **no page guard or API route references it**; member and binding mutations gate on `admin.orgs.update` instead. Confirm with product whether `admin.orgs.manage` is intended to gate the Members/Providers write actions (currently dead), or is reserved for future use. A holder of only `admin.orgs.manage` (without `.update`) can read but cannot mutate members/bindings today.

## Access matrix — SUPERADMIN vs ORG ADMIN (and the rest)

"See" = the screen renders with data. "Act" lists which write actions are permitted. `admin.platform` (Org Admin) holds the whole `admin.*` catalog including `admin.orgs.*`, but the SUPERADMIN-only gate still blocks org-record mutations.

| Persona → | Visitor | Pending | Member | Limited Admin (`admin`) | Org Admin (`admin.platform`) | Superadmin (`superuser`) |
| --- | --- | --- | --- | --- | --- | --- |
| Reach `/administrator/*` at all | No (redirect to sign-in) | No (pending screen) | No — 404 (no `admin.*`) | **Yes** (holds `admin.users.read`) | Yes | Yes |
| See **Organizations** list | No | No | No — 404 | **No — 404** (lacks `admin.orgs.read`) | Yes — **their org row only** | Yes — **all orgs** |
| See **Memberships** search | No | No | No — 404 | **No — 404** | Yes — their org's rows only | Yes — all orgs |
| See **Org detail** (own org) | No | No | No — 404 | No — 404 | Yes | Yes |
| See **Org detail** (foreign org) | No | No | No — 404 | No — 404 | **No — 404** (not 403) | Yes |
| Open **New organization** | No | No | No — 404 | No — 404 | **No — 404** (lacks `admin.orgs.create`) | Yes |
| **Create** an org (`POST`) | — | — | — | — | **No — 403** (SUPERADMIN-only) | Yes |
| **Rename / status / default** (Settings `PATCH`) | — | — | — | — | **No — 403** (SUPERADMIN-only; fields disabled in UI) | Yes |
| **Delete** an org | — | — | — | — | **No — 403** (SUPERADMIN-only; no Delete button) | Yes |
| **Add / update / remove members** | — | — | — | — | **Yes** (own org; `admin.orgs.update`) | Yes |
| **Bind providers** | — | — | — | — | No (403 — a binding is a platform-wide claim, F-04) | Yes (API) |
| **Unbind providers** | — | — | — | — | **Yes** (own org; `admin.orgs.update`) | Yes |

Notes:

- The **Limited Admin** persona (`admin` role) is the partial-permission control: it holds `admin.users.read`, `admin.users.manage`, `admin.audit.read` only (`src/db/seeds/dev-init.ts:249`), so it reaches the console but the entire tenancy area (list, memberships, detail, new) returns **404** because it lacks `admin.orgs.read`/`create`. The nav never shows the Organizations or Memberships links to it (`administrator-navigation.ts:125,132`).
- The **New organization** action button and the per-row **Delete** button are *hidden* (not disabled) when the caller lacks `admin.orgs.create` / `admin.orgs.delete` (`organizations/page.tsx:32,44`). Because an Org Admin (`admin.platform`) *does* hold `admin.orgs.delete`, the Delete button **is shown** to them — but the `DELETE` call returns 403 (see the negative cases). This is the closest thing to a UI/permission mismatch in the area; call it out during testing.

## Test environment & accounts

Seed the richer multi-org fixture (three orgs, superuser + org admin + five users each, plus cross-org members and two groups):

```bash
pnpm db:auth:migrate && pnpm db:app:migrate
pnpm db:seed:dev
```

Base URL `http://localhost:3000`. Test in `en` first, then repeat one story in a non-Latin locale (`uk` or `ja`) by swapping the leading path segment, e.g. `/uk/app/administrator/organizations`. Every seeded account shares one password: `DevPassword123!` (override via `DEV_SEED_PASSWORD`). Reset by re-running `pnpm db:seed:dev` (idempotent) or rebuilding the database.

| Persona | Sign-in email | Role | Relevant access |
| --- | --- | --- | --- |
| Superadmin | `superuser@orga.local` | `superuser` | Every org; only persona that can create / rename / delete an org |
| Org Admin (ORG A) | `orgadmin@orga.local` | `admin.platform` | Full `admin.*` within ORG A; sees only ORG A; cannot mutate the org record |
| Org Admin (ORG B) | `orgadmin@orgb.local` | `admin.platform` | Same, scoped to ORG B — use as the "foreign org" actor for 404 tests |
| Limited Admin | (assign the `admin` role to a user, e.g. an ORG A member) | `admin` | Reaches console; **no** `admin.orgs.*` → tenancy area 404s |
| Member | `user1@orga.local` | `member` | Secure shell only; `/administrator` 404s |
| Cross-org member | `multi1@shared.local` | `member` in all 3 orgs | Test data: appears in every org's Members grid |
| Visitor | (signed out) | — | Redirected to sign-in |

Seed data you can rely on: default org has `slug` `default` and `is_default = true` (created by `seed-local.ts`; the flag, not the slug, is what makes it the default, F-40); `pnpm db:seed:dev` orgs are `org-a`, `org-b`, `org-c` (all `is_default = false`, `status = active`); ORG A has an `engineering` and a `support` group and users `user1..5@orga.local`.

---

### UAT-ADMIN-ORG-LIST — Organizations list

- Route: `/app/administrator/organizations`  ·  Example URL: `/en/app/administrator/organizations`  ·  Code: `src/app/[locale]/(secure)/app/administrator/organizations/page.tsx:22`
- Purpose: Paginated table of organizations with member counts. The entry point into per-org administration; the "New organization" call-to-action lives here for a Superadmin.
- Guard / who can access: `admin.orgs.read` (server-revalidated on top of the layout's any-admin gate). `resolveOrgScope` then bounds the rows: Superadmin sees every org, Org Admin sees only their one org, a null scope yields an empty list.
- Access matrix: Visitor / Pending / Member / Limited Admin -> cannot see (404 / redirect). Org Admin -> sees their row only, no "New" button. Superadmin -> sees all rows plus "New organization" and per-row "Delete".
- Preconditions & test data: seeded via `pnpm db:seed:dev` (orgs `org-a/b/c`). Columns rendered: slug (link), name, status, default flag, member count, created date (`_organizations-grid.tsx:94`).

User stories

- UAT-ADMIN-ORG-LIST-S1 — As a Superadmin, I want to see every organization with its member count, so that I can pick one to administer.
  - Acceptance criteria: Given I am signed in as a Superadmin, when I open the list, then all seeded orgs (`org-a`, `org-b`, `org-c`, `default`) appear with a member count and a status badge, and a "New organization" button is visible.
  - UAT script (a real user can run this):
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local`. | The Administrator console opens. |
    | 2 | In the left nav, under Tenancy, click **Organizations**. | The organizations table loads. |
    | 3 | Read the table. | Rows for `org-a`, `org-b`, `org-c`, and `default` appear, each with slug, name, a status badge, a member count, and a created date. |
    | 4 | Look at the top-right of the table. | A **New organization** button is visible. |
    | 5 | Click the `org-a` slug link. | You navigate to that organization's detail page. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-LIST-S2 — As an Org Admin, I want the list to show only my organization, so that I cannot see or act on other tenants.
  - Acceptance criteria: Given I am signed in as the ORG A Org Admin, when I open the list, then exactly one row (`org-a`) appears and there is no "New organization" button.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`. | The console opens. |
    | 2 | Open **Organizations** from the Tenancy nav. | The table loads. |
    | 3 | Count the rows. | Exactly one row, `org-a`, is shown. `org-b`, `org-c`, and `default` are absent. |
    | 4 | Look for a **New organization** button. | No such button is present. |
    | 5 | Type `org-b` in the table search box and submit. | Still no `org-b` row appears (the scope is enforced server-side, not just hidden). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-LIST-S3 — As a Member (or Limited Admin), I want the organizations screen to be unreachable, so that non-tenancy users never see tenant data.
  - Acceptance criteria: Given I lack `admin.orgs.read`, when I navigate directly to the list URL, then I get a Not Found page (not a Forbidden page), and the Organizations nav link is absent.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local` (a Member). | The secure shell opens; there is no Administrator nav. |
    | 2 | In the address bar, go to `/en/app/administrator/organizations`. | A **Not Found (404)** page appears — not a "Forbidden" or "Access denied" message. |
    | 3 | Sign out, then sign in as a Limited Admin (a user with the `admin` role). | The Administrator console opens, but the Tenancy group shows no Organizations link. |
    | 4 | Navigate directly to `/en/app/administrator/organizations`. | A **Not Found (404)** page appears. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-LIST-S4 — As a Superadmin, I want to filter and sort the list, so that I can find an org in a large tenant estate.
  - Acceptance criteria: Given the list is open, when I filter by `status = active` and sort by member count, then only active orgs remain and the order reflects the count.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `superuser@orga.local`, open the Organizations list. | The table loads. |
    | 2 | Open the **Status** filter and choose **Active**. | Only orgs with an Active status badge remain. |
    | 3 | Open the **Default** filter and choose the "true" option. | Only the `default` org (the one flagged default) remains. |
    | 4 | Clear the Default filter, then click the **Member count** column header. | The rows re-order by member count; the URL updates with the sort parameter. |
    | 5 | Type `org-a` in the search box and submit. | Only the `org-a` row (matched on slug/name) is shown. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases (each a short numbered check)

1. Out-of-scope: as `orgadmin@orgb.local`, the list shows only `org-b`; no way to surface `org-a` via search or filter (server scope, `route.ts:49`).
2. Empty state: an Org Admin whose org has no rows to match a filter sees the grid's empty-state message, not an error.
3. Loading: on a slow network, a loading skeleton renders before rows appear.
4. Inline error: if the list endpoint fails, an inline error with `role="alert"` appears; the delete-row error path shows the same alert region (`_organizations-grid.tsx:180`).
5. Pagination: default page size is 25 (`_organizations-grid.tsx:192`); with fewer rows, no pager controls are needed.

Accessibility: reach and operate the table (search, filters, sort, the slug link, the Delete button) by keyboard only; focus is visible; the inline error region is announced (`role="alert"`).
i18n: run in `en` and `uk`/`ja`; column headers, status badges, the "New organization" and "Delete" labels, and dates localize; no raw message keys (e.g. no literal `administrator.orgs.columns.slug`) appear.

---

### UAT-ADMIN-ORG-NEW — Create organization

- Route: `/app/administrator/organizations/new`  ·  Example URL: `/en/app/administrator/organizations/new`  ·  Code: `src/app/[locale]/(secure)/app/administrator/organizations/new/page.tsx:14`
- Purpose: Form to create a new organization (tenant): slug, name, and an optional "make default" flag. Creating a tenant is a platform-level action.
- Guard / who can access: page requires `admin.orgs.create`; the `POST` additionally enforces **SUPERADMIN-only** (`api/administrator/organizations/route.ts:157`). So only a Superadmin ever reaches and successfully submits this form.
- Access matrix: Visitor / Pending / Member / Limited Admin / Org Admin -> cannot open (404; none hold `admin.orgs.create` except a superadmin). Superadmin -> can open and submit.
- Preconditions & test data: signed in as `superuser@orga.local`. Shared schema `createOrganizationSchema` (`lib/validation/organizations.ts:16`): slug required, lowercase, matches the slug pattern, max 64; name required, max 200; `isDefault` optional.

User stories

- UAT-ADMIN-ORG-NEW-S1 — As a Superadmin, I want to create a new organization, so that I can onboard a new tenant.
  - Acceptance criteria: Given I am a Superadmin on the new-org form, when I enter a unique slug and a name and submit, then the org is created and I land on its detail page.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local` and open **Organizations**. | The list loads with a **New organization** button. |
    | 2 | Click **New organization**. | The create form opens with Slug and Name fields (both marked required `*`) and a "make default" checkbox whose hint says new unmapped sign-ups join the default organization and that setting it moves the default from the current one (F-40). |
    | 3 | Type `Acme-QA` into **Slug**. | The value is normalised to lowercase `acme-qa` as you type. |
    | 4 | Type `Acme QA` into **Name** and leave the default checkbox unchecked. | Both required fields are filled. |
    | 5 | Click **Create** (the submit button). | The org is created and you are redirected to `/en/app/administrator/organizations/<new id>`, showing name "Acme QA" and slug `acme-qa`. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-NEW-S2 — As an Org Admin, I want the create form to be unreachable, so that I cannot spin up new tenants.
  - Acceptance criteria: Given I am an Org Admin, when I navigate directly to the new-org URL, then I get a Not Found page and no "New organization" button was ever shown to me.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`. | The console opens; the Organizations list shows only `org-a` and no "New organization" button. |
    | 2 | Navigate directly to `/en/app/administrator/organizations/new`. | A **Not Found (404)** page appears (the page gate requires `admin.orgs.create`, which this persona lacks). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

1. Duplicate slug: submitting a slug that already exists (e.g. `default`) returns **409** and the error is mapped onto the Slug field as "slug taken" (`_new-organization-form.tsx:63`).
2. Required-field validation: clearing Slug or Name and submitting shows the `*` marker, a red border, and a localized "required" message; the form does not submit (`noValidate` + zod, `_new-organization-form.tsx:85`).
3. Slug format: an invalid slug (uppercase is auto-lowered; a leading/trailing hyphen or illegal character) triggers the "slug" validation message, not a server round-trip.
4. Server 400: a rejected body surfaces a root inline error `role="alert"` with the localized "invalid body" message.
5. SUPERADMIN-only 403 (defence-in-depth): if a caller reached the form without the marker, the `POST` returns 403 and the form shows the localized "forbidden" root error (`_new-organization-form.tsx:71`). (Not normally reachable, since the page gate already 404s a non-`create` holder.)
6. Cancel: clicking **Cancel** returns to the list without creating anything.

Accessibility: complete the whole form by keyboard; the required legend is present; each field's error is associated with its input and announced; the root error uses `role="alert"`.
i18n: in `uk`/`ja`, field labels, the slug help text, validation messages, and the submit/cancel labels localize; no raw keys.

---

### UAT-ADMIN-ORG-DETAIL — Organization detail (Members / Providers / Authentication / Settings)

- Route: `/app/administrator/organizations/[orgId]`  ·  Example URL: `/en/app/administrator/organizations/<uuid>`  ·  Code: `src/app/[locale]/(secure)/app/administrator/organizations/[orgId]/page.tsx:27`
- Purpose: Per-organization admin surface. Header shows name, slug, status badge, and a "default" badge. Four tabs: **Members** (paginated memberships, add/remove, plus the **invitations** panel — invite by email + optional role, resend, revoke), **Providers** (provider bindings: list and unbind; binding is Superadmin-only via the API, F-04), **Authentication** (the per-org sign-up policy — email verification, approval mode incl. invite-only, allowed methods, auto-approve domains, 0007), **Settings** (edit slug/name/status/default — Superadmin only).
- Guard / who can access: `admin.orgs.read`; the `orgId` must be a valid UUID (else 404); and `canAccessOrg` must pass — a foreign org returns `notFound()` (404, **not** 403) so its existence is not leaked (`page.tsx:38,54`). Invitations and the Authentication policy are editable when `canUpdate` (`admin.orgs.update`) is held; the Settings fields' write is still SUPERADMIN-only.
- Access matrix: Visitor / Pending / Member / Limited Admin -> 404. Org Admin -> can view + manage Members/Invitations/Authentication and view/unbind Providers for their own org (binding is 403, F-04); Settings fields are shown but a save returns 403; a foreign `orgId` returns 404. Superadmin -> full access to any org including Settings and the platform sign-up defaults.
- Preconditions & test data: use an org UUID from the list. ORG A has members `user1..5@orga.local` plus cross-org `multi1..3@shared.local`. Member statuses: active / pending_approval / blocked / suspended (`members/route.ts:118`).

User stories

- UAT-ADMIN-ORG-DETAIL-S1 — As an Org Admin, I want to add a user to my organization, so that they gain membership.
  - Acceptance criteria: Given I am the ORG A Org Admin on the Members tab, when I add an existing user by id, then a new membership row appears with status "active".
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open **Organizations** → `org-a`. | The detail page opens on the **Members** tab; existing members are listed. |
    | 2 | Confirm the header. | The org name, the slug in code style, and a status badge are shown. |
    | 3 | Read a member row. | Each row shows the user (a link to the user detail), a status badge, the source provider, and a joined date. |
    | 4 | Add a membership for a user not yet in ORG A (via the add-member affordance / `POST .../members` with a valid `appUserId`). | A new row is created and the grid refreshes; the new membership is "active" by default. |
    | 5 | Click a member's name link. | You navigate to that user's detail page under Users. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S2 — As an Org Admin, I want to remove a member, so that they lose access to the org.
  - Acceptance criteria: Given a member exists, when I click Remove and confirm, then the row disappears and a repeat removal reports "not found". The member's roles and group memberships in this org go with the membership (F-12), so adding them back later restores none of them; their roles and groups in other orgs are untouched.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `orgadmin@orga.local`, open `org-a` → **Members**. | Members are listed, each with a **Remove** button (because you hold `admin.orgs.update`). |
    | 2 | Click **Remove** on a `user5@orga.local` row. | A destructive confirm dialog appears naming the user. |
    | 3 | Confirm the removal. | The dialog closes, the grid refreshes, and the `user5` row is gone. |
    | 4 | If the remove fails server-side, observe the alert. | An inline error `role="alert"` with the localized "remove error" message is shown (`_organization-members-grid.tsx:131`). |
    | 5 | As the Superadmin, open `user5`'s detail → **Roles** and **Groups**. | Nothing from `org-a` is listed (F-12). Any role or group `user5` holds in another org is still there. |
    | 6 | Add `user5` back to `org-a` (`POST .../members`), then re-open **Roles** and **Groups**. | Still nothing from `org-a`: the old roles and groups did not come back. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S2b — As a member of several organizations, I want a suspension in one of them to leave my access to the others alone, so that one tenant's admin cannot lock me out of another (F-33).
  - Acceptance criteria: Given `multi1@shared.local` has switched to ORG B, when ORG B's Org Admin suspends their ORG B membership, then their next page load opens in ORG A instead of the blocked screen, and the org switcher no longer lists ORG B. When the membership is made active again, the shell opens in ORG B again. A user whose only membership is suspended still sees the blocked screen.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `multi1@shared.local`, open the org switcher and choose **ORG B**. | The shell reloads in ORG B. |
    | 2 | In a second browser, as `orgadmin@orgb.local`, open `org-b` → **Members**, note `multi1`'s membership id, and send `PATCH …/organizations/{org-b id}/members` with `{"membershipIds":["<id>"],"status":"suspended"}`. | **200**; `multi1`'s row shows a Suspended badge. |
    | 3 | In `multi1`'s browser (its `active_org` cookie still names ORG B), reload `/en/app/dashboard`. | The dashboard renders in **ORG A**, not the blocked screen. The switcher lists ORG A and ORG C only. |
    | 4 | Sign out, then sign in again as `multi1@shared.local`. | Still ORG A. Signing out never cleared the cookie; it simply no longer decides. |
    | 5 | As `orgadmin@orgb.local`, send the same `PATCH` with `"status":"active"`, then reload `multi1`'s page. | The shell is back in **ORG B**, the org `multi1` last chose. |
    | 6 | As `orgadmin@orgb.local`, suspend `user5@orgb.local`'s ORG B membership (their only one), then sign in as `user5@orgb.local`. Set it back to `active` afterwards. | The blocked screen: with no active membership anywhere, the suspended one is used. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S3 — As an Org Admin, I want to see and remove my organization's provider bindings; as a Superadmin, I want to create them, so that SSO/provisioning maps to the right org.
  - Acceptance criteria: Given I am on the Providers tab, I see my org's bindings and can remove one. Creating a binding is refused to an Org Admin (a binding claims a domain or provider key across the whole platform, F-04) and succeeds for a Superadmin through `POST /api/administrator/organizations/{id}/provider-bindings`.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `orgadmin@orga.local`, open `org-a` and click the **Providers** tab. | The provider-bindings grid loads (may be empty for a fresh org). There is no create control. |
    | 2 | As `orgadmin@orga.local`, `POST …/organizations/{org-a id}/provider-bindings` with `{"provider":"email","providerOrganizationKey":"orga.example"}`. | **403** with `reason: "cross_org_reach_required"`; nothing is created. |
    | 3 | As the Superadmin, send the same request with `"providerOrganizationKey":"OrgA.Example"`. | **201**; the binding appears on the Providers tab with the key lowercased (`orga.example`). |
    | 4 | As the Superadmin, try `"providerOrganizationKey":"gmail.com"`. | **400** with `reason: "public_email_domain"`. |
    | 5 | As `orgadmin@orga.local`, click **Remove** on the binding and confirm. | A confirm dialog shows `provider: key`; the grid refreshes and the row is gone. |
    | 6 | As the Superadmin, add the same provider + key twice. | The second attempt is rejected (binding already exists) and no duplicate row appears. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S4 — As a Superadmin, I want to rename an organization and suspend it, so that I can correct tenant records and actually cut a tenant off.
  - Acceptance criteria: Given I am a Superadmin on the Settings tab, when I change the name and status and save, then a success message appears, the header reflects the change without a reload, and leaving the tab and coming back shows the saved values (F-39). A suspended org's members, org admin and superuser lose access to it (F-09) until it is set back to Active, and I keep managing it throughout.
  - Note: suspend **`org-c`**, not `org-a`. Organization status is enforced, so suspending `org-a` would also suspend the `superuser` grant `superuser@orga.local` holds there, and you would be signed in as someone who is no longer a superadmin.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local` and open `org-c` → **Settings**. | The Settings form shows editable Slug, Name, Status (a select), and a "default" checkbox (its hint says setting it moves the default and re-routes new sign-ups, F-40), with a required legend. |
    | 2 | Change **Name** to `ORG C (renamed)`. | The field accepts the edit. |
    | 3 | Change **Status** to `suspended`. | The select shows the localized "Suspended" option selected. |
    | 4 | Click **Save**. | A success message `role="status"` ("saved") appears, and the header updates to the new name and a Suspended badge without a reload. Open **Members**, then **Settings** again: the form shows `ORG C (renamed)` and Suspended, not the values from before the save (F-39). |
    | 5 | Reload the page. | The header shows the new name and a Suspended status badge. You can still open every tab of the suspended org. |
    | 6 | In a private window, sign in as `user1@orgc.local`. | The pending-approval screen, not the dashboard: the only membership is in a suspended org. |
    | 7 | Sign in as `orgadmin@orgc.local`, then as `superuser@orgc.local`. | Both see the pending-approval screen. The ORG C superuser is no superadmin while ORG C is suspended. |
    | 8 | Sign in as `multi1@shared.local` (a member of all three orgs) and open the org switcher. | ORG C is not listed; the session works in ORG A or ORG B. |
    | 9 | As `superuser@orga.local`, open `org-c` → **Members** → *Invite member* and invite any address. | Refused with an inline "This organization is not active…" error; no invitation is created. |
    | 10 | Back on **Settings**, set **Status** to `active` and save. Repeat steps 6–7. | Everyone is back exactly as before, the ORG C superuser included. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S4b — As the platform, I want suspending the tenant that holds the last superuser grant to be refused, so that one save cannot lock every administrator out (F-09, REVOKE-2).
  - Acceptance criteria: Given the only remaining `superuser` grants live in one org, when a Superadmin sets that org's status to anything but Active, then the save is refused and nothing changes.
  - UAT script (needs a database where the default org's seeded admin is the only superuser, e.g. `pnpm db:seed` without `db:seed:dev`):
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as the seeded admin and open the default org → **Settings**. | The form renders. |
    | 2 | Set **Status** to `suspended` and click **Save**. | A root inline error `role="alert"` says this is the last platform superadmin; no success message. |
    | 3 | Reload the page. | Status is still Active. The audit explorer shows `admin.superuser.revocation_denied` (`reason: last_global_superuser`, `metadata.action: organization_status_update`). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S4c — As a Superadmin, I want the default organization to be one org I can rename or move, so that new sign-ups always land in the tenant I chose, under its policy (F-40).
  - Acceptance criteria: Given the default org, when I rename its slug, then unmapped sign-ups still land in it (no new "Default Organization" appears) and a re-run of `pnpm db:seed` adds no second default. When I set another org as default, then exactly one org carries the Default badge and new sign-ups land there, and a re-run of `pnpm db:seed` writes no platform role or admin grant into it. The default can be moved but not unticked.
  - UAT script (local rig; step 9 restores the starting state):
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local` and open the default org (slug `default`) → **Settings**. | The "Set as default organization" checkbox is ticked and **disabled**; its hint says this is the default organization and that the default moves by setting it on another organization. |
    | 2 | Change **Slug** to `default-renamed` (do not save yet). | A warning `role="note"` appears under the slug: it breaks existing `/sign-in/default` links and env vars that name the org by slug (`MCP_REGISTRATION_DEFAULT_ORG`, `MCP_REGISTRATION_ALLOWED_ORGS`). Typing `default` back hides it. |
    | 3 | Set the slug to `default-renamed` and click **Save**. | Saved. |
    | 4 | In a private window, sign up with email + password as `f40-check@example.test` (a domain with no binding). | Back as the Superadmin, the renamed default org's **Members** tab lists the new address; the Organizations list shows no new "Default Organization" and one Default badge. |
    | 5 | Run `pnpm db:seed`, then reload **Organizations**. | Still one Default badge (on `default-renamed`) and no new `default` org. |
    | 6 | Open `org-c` → **Settings**, tick "Set as default organization" and save. | Saved; the checkbox becomes read-only; the Organizations list shows exactly one Default badge, on `org-c`; the audit explorer's `admin.organization.updated` row for `org-c` names the previous default in `previousDefaultOrganizationIds`. |
    | 7 | Sign up another unmapped account (`f40-check2@example.test`). | It appears on `org-c`'s **Members** tab. |
    | 8 | Run `pnpm db:seed` again. | It exits 0 (it no longer refuses the seed admin with `REFUSED to escalate pre-existing account`) and logs that the platform roles and the default admin stay in the `default-renamed` org's id. `admin@devresponse.local` is still not a member of `org-c`, and `org-c` keeps the Default badge. |
    | 9 | Restore: on `default-renamed` → **Settings**, tick "Set as default organization" and save; then set the slug back to `default` and save. Remove the two test accounts. | One Default badge, on `default`. |
  - API check: `PATCH /api/administrator/organizations/{default org id}` with `{"isDefault": false}` returns **409** `organization_is_default` and writes `admin.organization.update_blocked` (`reason: organization_is_default`); the flag is unchanged.
  - Legacy check (only on a database that already holds two flagged orgs, from a pre-F-40 seed re-run): the newer flagged org's **Settings** shows the checkbox ticked but **enabled**, with a hint that new sign-ups join the oldest flagged organization instead; unticking it and saving clears that flag (the audit row carries `clearedExtraDefaultFlag: true`), leaving one Default badge.
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S5 — As an Org Admin, I want the Settings save to be refused, so that I cannot mutate the org record I do not own at the platform level.
  - Acceptance criteria: Given I am an Org Admin on my org's Settings tab, when I edit a field and save, then the save is refused with a "forbidden" message and the record is unchanged. (SUPERADMIN-only, `[id]/route.ts:124`.)
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open `org-a` → **Settings**. | The Settings form renders. Because this persona holds `admin.orgs.update`, the fields are editable. |
    | 2 | Change **Name** to anything and click **Save**. | The save is rejected: a root inline error `role="alert"` shows the localized "forbidden" message (mapped from the 403 at `_organization-settings-form.tsx:143`). |
    | 3 | Reload the page. | The name is unchanged — the edit did not persist. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-DETAIL-S6 — As an Org Admin, I want a foreign organization to be indistinguishable from a missing one, so that cross-tenant existence is never leaked.
  - Acceptance criteria: Given I am the ORG A Org Admin, when I open ORG B's detail URL, then I get a Not Found page — not Forbidden.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `superuser@orga.local`, open **Organizations**, click `org-b`, and copy its URL (contains ORG B's UUID). | You have a valid ORG B detail URL. |
    | 2 | Sign out and sign in as `orgadmin@orga.local`. | You are the ORG A Org Admin. |
    | 3 | Paste and open the ORG B detail URL. | A **Not Found (404)** page appears — **not** a "Forbidden" page. |
    | 4 | Open `/en/app/administrator/organizations/not-a-uuid`. | A **Not Found (404)** page appears (invalid id short-circuits, `page.tsx:38`). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

1. Cross-tenant 404 (not 403): a foreign `orgId` returns Not Found for the page and a 404 envelope for the members/providers endpoints (`members/route.ts:54`, `provider-bindings/route.ts:53`).
2. Invalid id: a non-UUID `orgId` returns 404 on the page and `invalid_id` (400) on the API.
3. Settings required validation: clearing Slug or Name shows the `*` marker, a red border, and a localized "required" message; Slug also enforces the lowercase slug pattern.
4. Slug conflict on save: changing the slug to one already taken returns **409**, mapped onto the Slug field as "slug taken" (`_organization-settings-form.tsx:136`).
5. Member add errors: adding a non-existent `appUserId` returns `user_not_found` (404); adding an existing membership returns `membership_exists` (409).
6. Disabled-when-read-only: if a persona holds `admin.orgs.read` but not `admin.orgs.update`, every Settings field and the Save button are disabled, and the required legend is hidden (`_organization-settings-form.tsx:160,264`).
7. Rate-limit: rapid member/binding mutations hit the admin mutation limit and return a friendly rate-limited response (`members/route.ts:126`).
8. Removing a member whose roles or groups in the org confer a permission the caller cannot confer is refused with **403** `forbidden` and an `admin.membership.revocation_denied` audit row, and nothing is removed (REVOKE-1, F-12). An Org Admin at a browser is normally stopped earlier by the rank guard; the case to try is a bearer key scoped only to `admin.orgs.update`, removing a member who holds an `admin.*` role. The same key removes a plain member (`user1..5`, the `member` role) with **200**: `shell.view` goes with the membership and is not measured.

Accessibility: tab through the three tabs (arrow-key tab navigation), the grids, and the Settings form; dialogs (Remove confirm) trap focus and close on Esc; the success message uses `role="status"`, errors use `role="alert"`.
i18n: in `uk`/`ja`, tab labels (Members / Providers / Settings), status options, buttons, and dates localize; no raw keys.

---

### UAT-ADMIN-ORG-MEMBERSHIPS — Cross-org memberships

- Route: `/app/administrator/memberships`  ·  Example URL: `/en/app/administrator/memberships`  ·  Code: `src/app/[locale]/(secure)/app/administrator/memberships/page.tsx:16`
- Purpose: A read/search surface across all memberships (org × user), so an operator can answer "which orgs is this user in?" and "who is in this org?" from one place, pivoting to either the org or the user detail.
- Guard / who can access: `admin.orgs.read`. Rows are org-scoped by `resolveOrgScope`: Superadmin sees every membership; Org Admin sees only their org's memberships; a null scope returns an empty list (`api/administrator/memberships/route.ts:32,50`). This screen is **read-only** — there are no mutation actions on it.
- Access matrix: Visitor / Pending / Member / Limited Admin -> 404. Org Admin -> their org's memberships only. Superadmin -> all memberships across orgs.
- Preconditions & test data: `pnpm db:seed:dev`. Cross-org members `multi1..3@shared.local` each appear three times (once per org) for a Superadmin. Columns: organization (link), user (link), status, source, created date (`_memberships-grid.tsx:38`).

User stories

- UAT-ADMIN-ORG-MEMBERSHIPS-S1 — As a Superadmin, I want to search memberships across all orgs, so that I can locate a user's tenancy footprint.
  - Acceptance criteria: Given I am a Superadmin, when I search for a cross-org member, then I see their membership in each of the three orgs.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local` and open **Memberships** from the Tenancy nav. | A cross-org memberships table loads. |
    | 2 | Type `Shared Member One` in the search box and submit. | Rows for `multi1@shared.local` appear — one per org (`org-a`, `org-b`, `org-c`). |
    | 3 | Read a row. | It shows the org slug (link), the user (link), a status badge, the source, and a created date. |
    | 4 | Click the organization slug in a row. | You navigate to that organization's detail page. |
    | 5 | Go back and click the user name in a row. | You navigate to that user's detail page. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-MEMBERSHIPS-S2 — As an Org Admin, I want the memberships screen scoped to my org, so that I only see my own tenants' members.
  - Acceptance criteria: Given I am the ORG A Org Admin, when I open Memberships, then every row belongs to `org-a`, and a cross-org member appears only via their `org-a` membership.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open **Memberships**. | The table loads. |
    | 2 | Scan the Organization column. | Every row shows `org-a`; no `org-b`/`org-c` rows appear. |
    | 3 | Search `Shared Member One`. | Exactly one row appears — the member's `org-a` membership only (not their B/C memberships). |
    | 4 | Filter **Status** by `active`. | Only active `org-a` memberships remain. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-ORG-MEMBERSHIPS-S3 — As a Member (or Limited Admin), I want the memberships screen to be unreachable, so that membership data is not exposed to non-tenancy users.
  - Acceptance criteria: Given I lack `admin.orgs.read`, when I navigate to the memberships URL, then I get a Not Found page.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local`. | The secure shell opens; no Administrator nav. |
    | 2 | Navigate to `/en/app/administrator/memberships`. | A **Not Found (404)** page appears — not Forbidden. |
    | 3 | Sign in as a Limited Admin (`admin` role) and navigate to the same URL. | A **Not Found (404)** page appears; the Memberships nav link was never shown. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

1. Out-of-scope: as `orgadmin@orgb.local`, no `org-a`/`org-c` rows appear regardless of search or the org filter (server scope, `route.ts:50`).
2. Empty state: a search with no matches shows the grid's empty-state message.
3. Loading: a skeleton renders before rows load.
4. Filters: the Status filter offers active / pending_approval / blocked / suspended (`_memberships-grid.tsx:13`); an unmatched filter yields the empty state, not an error.
5. Read-only: there are no Add/Remove/Edit controls on this screen; membership changes happen on the org detail Members tab.

Accessibility: operate search, the status filter, sorting, and the org/user links by keyboard; focus is visible; the empty state and any error are announced.
i18n: in `uk`/`ja`, column headers, the status badge and filter labels, and dates localize; no raw keys.

---

## Cross-cutting journey — Org lifecycle (Superadmin), scoped to this area

This is journey 8 from the generation prompt, confined to the organizations/memberships screens (role assignment happens on the Users/Roles screens, covered elsewhere).

- UAT-ADMIN-ORG-JOURNEY-S1 — As a Superadmin, I want to create an org, add members, and confirm an Org Admin of that org sees only it, so that tenancy isolation holds end to end.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local`, open **Organizations**, click **New organization**. | The create form opens. |
    | 2 | Create an org with slug `journey-qa`, name `Journey QA`. | You land on the new org's detail page. |
    | 3 | On the **Members** tab, add `user2@orga.local` (by id). | A membership row for that user appears, status "active". |
    | 4 | Note the new org's UUID from the URL. Open **Memberships** and search `Journey QA`. | The membership you just created appears, scoped to `journey-qa`. |
    | 5 | Sign out; sign in as `orgadmin@orga.local`. Open **Organizations**. | Only `org-a` is listed — `journey-qa` is not visible to this Org Admin. |
    | 6 | Paste the `journey-qa` detail URL captured in step 4. | A **Not Found (404)** page appears (cross-tenant isolation). |
    | 7 | Sign back in as the Superadmin, open `journey-qa` → **Members**, remove `user2`, then **Settings**, and attempt to delete via the list. | The org is now empty; deletion from the list succeeds (no dependents). If any dependent (member/role/binding) remained, deletion returns a **409**. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## Coverage matrix (screens × personas)

Legend: `see` = screen renders with data; `act` = at least one write action succeeds; `404` = Not Found; `403` = Forbidden (exists, but action refused); `—` = not applicable.

| Screen | Visitor | Pending | Member | Limited Admin | Org Admin | Superadmin |
| --- | --- | --- | --- | --- | --- | --- |
| Organizations list | 404 | 404 | 404 | 404 | see (own row) | see (all) |
| New organization | 404 | 404 | 404 | 404 | 404 | see + act |
| Org detail — Members | 404 | 404 | 404 | 404 | see + act (own) / 404 (foreign) | see + act |
| Org detail — Providers | 404 | 404 | 404 | 404 | see + act (own) | see + act |
| Org detail — Settings | 404 | 404 | 404 | 404 | see, save 403 | see + act |
| Memberships (cross-org) | 404 | 404 | 404 | 404 | see (own) | see (all) |

## Coverage checklist

- [x] Organizations list — happy (Superadmin all-rows, Org Admin scoped), negative (Member/Limited Admin 404), filter/sort, empty/loading/error, a11y + i18n.
- [x] New organization — happy (Superadmin create), negative (Org Admin 404, duplicate slug 409, required-field, SUPERADMIN-only 403), a11y + i18n.
- [x] Org detail — Members happy + remove, and a membership suspension that stays in its own org (S2b); Providers unbind (Org Admin) + bind (Superadmin, API); Settings edit (Superadmin) + save-403 (Org Admin); cross-tenant 404; a11y + i18n.
- [x] Memberships — happy (Superadmin cross-org, Org Admin scoped), negative (Member/Limited Admin 404), read-only, a11y + i18n.
- [x] Every gated screen has a can-see persona and a cannot-see persona asserting 404-not-403.
- [x] SUPERADMIN vs ORG ADMIN access matrix + coverage matrix included.
- [x] Org-lifecycle journey (create → add members → confirm isolation → 409 on dependents).

## TODO: verify

1. `admin.orgs.manage` is defined in the catalog (`lib/admin/permissions.ts:49`, `admin-manager.md:232`, migration `0001-initial-schema.sql:456`) but is referenced by **no page guard or API route**. Members/bindings mutations gate on `admin.orgs.update`. Confirm whether `.manage` is intended to gate those writes (currently dead) or is reserved for future use — a holder of only `.manage` can read but not mutate today.
2. UI/permission edge: the per-row **Delete** button on the list is shown to any holder of `admin.orgs.delete` (which `admin.platform` / Org Admin holds), yet the `DELETE` is SUPERADMIN-only and returns 403. Confirm intended behaviour — the button arguably should be hidden for non-superadmins, or the 403 should surface a clearer inline message (currently the grid falls through to the generic delete-error text; there is no dedicated `forbidden` mapping in `_organizations-grid.tsx:72-88`).
3. There is no dedicated "add member" / "bind provider" **dialog** described in the UI components read; the Members/Providers grids expose Remove and rely on the `POST` endpoints for create. Verify how a tester triggers an add in the running app (dedicated add form vs. API), and update steps UAT-ADMIN-ORG-DETAIL-S1 / S3 accordingly.
4. Confirm the exact create-form submit button label rendered by `t("new.submit")` and the Members "add" affordance labels in the running app, in case the message catalog differs from the assumed "Create" / "Add member".
