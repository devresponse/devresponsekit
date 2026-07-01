---
title: "UAT — Administrator: Apps, Email, API Keys & Audit"
description: Screen-by-screen UAT user stories for the Administrator enterprise-apps, email (outbox + templates), API-keys, and audit-log areas — runnable by a non-technical tester and doubling as living documentation.
group: QA
visibility: internal
order: 60
---

# UAT — Administrator: Apps, Email, API Keys and Audit

This is the screen-by-screen **User Acceptance Testing** story set for four Administrator-console areas:

- **Enterprise applications** — `enterprise-apps` (list), `enterprise-apps/new`, `enterprise-apps/[appId]` (detail)
- **Email** — `email` (outbox), `email/templates` (list), `email/templates/[templateId]` (edit)
- **API keys** — `api-keys` (list), `api-keys/new`
- **Audit** — `audit` (the audit log)

Every claim below is grounded in the code and cited as `file:line`. Where a fact could not be verified from code it is marked `TODO: verify`. Follow `docs/uat/GENERATION-PROMPT.md` for the authoring rules.

## Test environment and accounts

- **Base URL:** `http://localhost:3000` (dev). Every route is locale-prefixed, e.g. `/en/app/administrator/audit`.
- **Seed the personas:** run the dev fixture seed (`src/db/seeds/dev-init.ts`). It provisions three organizations, each with a `superuser@<org>`, an `orgadmin@<org>`, and `user1..5@<org>`, plus cross-org members and two groups in ORG A (`src/db/seeds/dev-init.ts:44`, `:156`).
- **Locales to test:** run each screen in `en` and once in a non-Latin locale (`uk` or `ja`); confirm no raw message keys and that dates/labels localize.
- **Reset:** re-run the seed to restore a clean fixture.

Persona-to-seed mapping for these four areas (`src/db/seeds/dev-init.ts:239`):

| Persona | Seed role / account | Permissions relevant here | Net effect on these screens |
| --- | --- | --- | --- |
| **Visitor** | unauthenticated | none | every screen redirects to sign-in (secure shell) |
| **Member** | `member` — `user1@<org>` | `shell.view` only | no admin; every screen in this set returns Not Found |
| **Limited Admin** | `admin` role (bundled into ORG A "Engineering" group; `user1`/`user2@orga.local` gain it) | `admin.users.read`, `admin.users.manage`, `admin.audit.read` | can open **Audit** only; Apps, Email, API-keys all return Not Found |
| **Org Admin** | `admin.platform` — `orgadmin@<org>` | full `admin.*` set, **no** `superuser` marker | can open all four areas, **scoped to their own org**; cannot save an email template (superadmin-only) |
| **Superadmin** | `superuser` — `superuser@<org>` | `superuser` marker → every permission, all orgs | full access everywhere; the only persona that can save an email template |

Key permission keys for this set (`src/lib/admin/permissions.ts:50`):

- `admin.apps.read` / `admin.apps.manage`
- `admin.email.read` / `admin.email.manage`
- `admin.apikeys.read` / `admin.apikeys.manage`
- `admin.audit.read`

**Console navigation (verified — no gate drift).** These areas are reached from the Administrator sidebar, not the top-level launcher. Each sidebar link's `requires` key equals its destination page guard, so no link surfaces a page that then 404s (`src/app/[locale]/(secure)/app/administrator/_components/administrator-navigation.ts:144`):

- Apps group -> `enterprise-apps` requires `admin.apps.read`; the "New application" action requires `admin.apps.manage`.
- APIs group -> `api-keys` requires `admin.apikeys.read`; the "New API key" action requires `admin.apikeys.manage`.
- Communication group -> `email` (outbox) and `email/templates` both require `admin.email.read`.
- Activity group -> `audit` requires `admin.audit.read`.

The Administrator layout itself is a defence-in-depth gate: any single `admin.*` permission admits the caller, otherwise `notFound()` (`src/app/[locale]/(secure)/app/administrator/layout.tsx:48`).

---

## Enterprise applications

### UAT-ADMIN-AEK-APPS-LIST - Enterprise applications list

- Route: `/app/administrator/enterprise-apps` · Example URL: `/en/app/administrator/enterprise-apps` · Code: `src/app/[locale]/(secure)/app/administrator/enterprise-apps/page.tsx:22`
- Purpose: A searchable, filterable grid of enterprise applications (the SSO handoff targets). Each row links to its detail page; managers get an inline Delete.
- Guard / who can access: `admin.apps.read` (re-validated on the page at `enterprise-apps/page.tsx:28`; API `GET /api/administrator/enterprise-apps` re-checks at `src/app/api/administrator/enterprise-apps/route.ts:37`). The "New application" button is hidden unless the caller also holds `admin.apps.manage` (`enterprise-apps/page.tsx:32`).
- Access matrix:
  - Visitor -> redirected to sign-in (no access).
  - Member -> Not Found.
  - Limited Admin -> Not Found (no `admin.apps.read`).
  - Org Admin -> can see; sees only their own org's apps plus nothing global; can act (New/Delete) within their org (`src/app/api/administrator/enterprise-apps/route.ts:66`).
  - Superadmin -> can see every org's apps and global apps; can act everywhere.
- Preconditions and test data: signed in as the target persona; at least one seeded enterprise application. Confirm your org owns at least one app for the Org Admin cases.

User stories

- UAT-ADMIN-AEK-APPS-LIST-S1 — As an Org Admin, I want to browse the enterprise applications, so that I can see which apps are wired for SSO in my org.
  - Acceptance criteria: Given I hold `admin.apps.read`, when I open the list, then I see a grid with columns Id, Label, Subdomain, Status, Organization, Sort order, Created at (`_enterprise-apps-grid.tsx:97`), sorted by Sort order ascending (`_enterprise-apps-grid.tsx:200`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` | You land in the secure shell |
    | 2 | Open the Administrator console, then the Apps group, then **Enterprise applications** | The list opens with the heading "Enterprise applications" |
    | 3 | Read the column headers | Id, Label, Subdomain, Status, Organization, Sort order, Created at |
    | 4 | Type a known app label into the search box | The grid filters to matching rows (id/label/subdomain are searched) |
    | 5 | Open the Status filter and choose **Disabled** | Only disabled apps remain |
    | 6 | Note the Organization column values | Your org's slug for org-owned apps; "Global" is never shown to an Org Admin |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APPS-LIST-S2 — As a Member, I want to be sure I cannot reach the apps list, so that tenancy is enforced.
  - Acceptance criteria: Given I hold no `admin.*`, when I navigate to the apps list URL, then I get Not Found (never Forbidden).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local` (plain member) | You land on the dashboard |
    | 2 | In the address bar go to `/en/app/administrator/enterprise-apps` | The Not-Found page renders (HTTP 404), not a Forbidden page |
    | 3 | Confirm the Administrator sidebar never showed an Apps group for you | No apps link was ever offered |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APPS-LIST-S3 — As an Org Admin, I want to delete an unused application, so that stale SSO targets are removed.
  - Acceptance criteria: Given the app has no SSO handoff nonces referencing it, when I confirm Delete, then the row disappears; given it is still in use, then I see an inline "application in use" message and the row stays (`_enterprise-apps-grid.tsx:79`; API `DELETE` returns 409 `application_in_use` at `src/app/api/administrator/enterprise-apps/[id]/route.ts:224`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, on the list, click **Delete** on an unused app row | A destructive confirm dialog appears with the app label |
    | 2 | Confirm the dialog | The row is removed and the grid refreshes |
    | 3 | Click **Delete** on an app that is still referenced by an SSO handoff, then confirm | An inline red alert reads that the application is in use; the row remains |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Out-of-scope access -> Not Found: as Org Admin the list simply omits other orgs' and global apps (empty page for a null scope, `src/app/api/administrator/enterprise-apps/route.ts:66`); a Member/Limited Admin hitting the URL gets 404 at the page guard.
- Empty state: with no apps in scope the grid renders its empty state (no rows) rather than an error.
- Delete refused -> friendly inline message ("application in use"); non-409 failures show the generic delete-error text (`_enterprise-apps-grid.tsx:88`).
- Rate limit: repeated deletes are subject to the admin mutation limiter; a limited response yields the generic delete error inline. `TODO: verify` the exact user-facing text on 429 (the grid maps only 409 specially).

Accessibility: keyboard-reach the search box, filter, and each row link/Delete; visible focus on the confirm dialog with Esc to cancel; the inline error uses `role="alert"` (`_enterprise-apps-grid.tsx:189`).
i18n: run in `en` and `uk`; column headers, the Status filter options, the "Global" label, and the delete dialog all localize; dates use the locale formatter.

### UAT-ADMIN-AEK-APPS-NEW - Create enterprise application

- Route: `/app/administrator/enterprise-apps/new` · Example URL: `/en/app/administrator/enterprise-apps/new` · Code: `src/app/[locale]/(secure)/app/administrator/enterprise-apps/new/page.tsx:14`
- Purpose: Create a new enterprise application with a stable text id, HTTPS origin, subdomain, SSO audience, and sort order.
- Guard / who can access: `admin.apps.manage` (page `new/page.tsx:20`; API `POST` at `src/app/api/administrator/enterprise-apps/route.ts:143`).
- Access matrix:
  - Visitor / Member / Limited Admin -> Not Found.
  - Org Admin -> can create, but only in their own org; the server rejects a global app or another org's app with `forbidden` 403 (`route.ts:170`).
  - Superadmin -> can create in any org and global apps.
- Preconditions and test data: signed in as a manager persona. Have a valid HTTPS origin that is on the trusted-host allow-list. Required fields: `id`, `label`, `origin`, `subdomain`, `sso_audience` (`src/lib/validation/enterprise-apps.ts:23`).

User stories

- UAT-ADMIN-AEK-APPS-NEW-S1 — As an Org Admin, I want to register a new app, so that users in my org can launch it via SSO.
  - Acceptance criteria: Given valid values, when I submit, then I am redirected to the new app's detail page; given the id is taken, then the id field shows "id already taken" (API 409 `id_taken`, `route.ts:204`; form maps it at `_new-enterprise-app-form.tsx:80`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, open the Apps group and click **New application** | The create form opens with a required-field legend |
    | 2 | Enter a unique lowercase **Id** (letters, digits, dots, hyphens, underscores) | The field accepts it and lowercases your input |
    | 3 | Fill **Label**, **Origin** (an allowed `https://...`), **Subdomain**, **SSO audience** | Fields accept valid values |
    | 4 | Leave **Sort order** at 100 and submit | You are redirected to the new app's detail page |
    | 5 | Repeat with the same Id | The Id field shows an "already taken" error and no navigation happens |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APPS-NEW-S2 — As an Org Admin, I want the form to stop me submitting a non-HTTPS or untrusted origin, so that SSO redirects stay safe.
  - Acceptance criteria: Given a non-HTTPS origin, when I submit, then the Origin field shows an "invalid origin" error; given an HTTPS origin that is not on the allow-list, then it shows "origin not allowed" (server-only checks; API returns `invalid_origin`/`origin_not_allowed` 400 at `route.ts:177`; mapped at `_new-enterprise-app-form.tsx:89`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | On the create form, enter `http://example.com` as the Origin and otherwise-valid values | On submit, the Origin field shows an invalid-origin error |
    | 2 | Change it to a well-formed `https://` URL that is not a trusted host | On submit, the Origin field shows an "origin not allowed" error |
    | 3 | Clear the required fields one at a time and submit | Each required field (`Id`, `Label`, `Origin`, `Subdomain`, `SSO audience`) shows its `*` marker and a localized required message with a red border |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APPS-NEW-S3 — As a Member, I want the create page to be unreachable, so that only managers can add apps.
  - Acceptance criteria: Given I lack `admin.apps.manage`, when I open the create URL, then I get Not Found.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a plain member | Dashboard loads |
    | 2 | Go to `/en/app/administrator/enterprise-apps/new` | Not-Found page (404) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Validation: required-field markers appear for `Id`, `Label`, `Origin`, `Subdomain`, `SSO audience`; invalid id/subdomain/audience formats are rejected with localized messages (`src/lib/validation/enterprise-apps.ts:25`).
- Org-scope: Org Admin submitting with a global/other-org target -> `forbidden` 403 surfaced as a root error.
- Rate limit (admin mutation): rapid repeated creates hit `admin.apps.create` limiter (`route.ts:146`); expect a friendly failure. `TODO: verify` the exact 429 copy in the create form.
- Loading: the submit button is disabled while submitting.

Accessibility: the form is `noValidate` with schema-driven markers; each control is labelled; the root error is a `role="alert"` region (`_new-enterprise-app-form.tsx:239`).
i18n: labels, help text, and the required legend localize in `en` and `uk`.

### UAT-ADMIN-AEK-APPS-DETAIL - Enterprise application detail

- Route: `/app/administrator/enterprise-apps/[appId]` · Example URL: `/en/app/administrator/enterprise-apps/acme-hub` · Code: `src/app/[locale]/(secure)/app/administrator/enterprise-apps/[appId]/page.tsx:22`
- Purpose: View and edit a single application. The `id` is immutable (referenced by SSO handoff nonces); all other fields are inline-editable by managers.
- Guard / who can access: `admin.apps.read` to view; `admin.apps.manage` to edit (page `[appId]/page.tsx:29`,`:64`; API `GET`/`PATCH` at `src/app/api/administrator/enterprise-apps/[id]/route.ts:28`,`:75`). Read-only callers see the same form disabled.
- Access matrix:
  - Visitor / Member / Limited Admin -> Not Found.
  - Org Admin -> can view/edit apps their org owns; a foreign or global app returns Not Found (404, not 403) to preserve existence indistinguishability (`[appId]/page.tsx:60`; `[id]/route.ts:61`).
  - Superadmin -> can view/edit any app; re-homing an app to another org/global is superadmin-only (`[id]/route.ts:128`).
- Preconditions and test data: know a valid `appId` your persona can access. For the 404 case, obtain an app id owned by a different org (as Org Admin).

User stories

- UAT-ADMIN-AEK-APPS-DETAIL-S1 — As an Org Admin, I want to change an app's status and label, so that I can disable or rename it without recreating it.
  - Acceptance criteria: Given valid edits, when I Save, then a success message appears and the values persist after refresh (`_enterprise-app-settings-form.tsx:92`,`:271`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open an app your org owns from the list | The detail page shows the label, the id as read-only code, and a status badge |
    | 2 | Change **Status** to Disabled and edit the **Label** | Fields accept the changes |
    | 3 | Click **Save** | A success ("saved") message appears |
    | 4 | Reload the page | The new label and status are shown; the status badge reflects Disabled |
    | 5 | Confirm the **Id** cannot be edited | The id is displayed as read-only text with no input |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APPS-DETAIL-S2 — As a read-only admin, I want to inspect an app without being able to change it, so that least privilege holds.
  - Acceptance criteria: Given I hold `admin.apps.read` but not `.manage`, when I open the detail, then all fields are disabled and there is no Save button and no required legend (`_enterprise-app-settings-form.tsx:123`,`:128`,`:276`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as an admin holding only `admin.apps.read` (create such a role, or use a role without `admin.apps.manage`) | Console loads |
    | 2 | Open an app detail page | Every field is disabled; there is no Save button and no required legend |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______  *(precondition: a read-only apps role is not in the default seed — `TODO: verify` by creating one)*

- UAT-ADMIN-AEK-APPS-DETAIL-S3 — As an Org Admin, I want another org's app to be indistinguishable from a missing one, so that cross-tenant existence never leaks.
  - Acceptance criteria: Given an `appId` owned by a different org, when I open its detail URL, then I get Not Found (404), identical to a non-existent id.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `orgadmin@orga.local`, take an app id owned by ORG B | (Obtain it as a Superadmin in another window) |
    | 2 | Open `/en/app/administrator/enterprise-apps/<orgB-app-id>` | Not-Found page (404), the same as for a made-up id |
    | 3 | Open `/en/app/administrator/enterprise-apps/does-not-exist` | Not-Found page (404) — the two are indistinguishable |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Out-of-scope -> Not Found (404) for both foreign and global apps to an Org Admin.
- Validation: editing keeps `Label`, `Origin`, `Subdomain`, `SSO audience` required (`src/lib/validation/enterprise-apps.ts:72`); bad origin surfaces `invalid_origin`/`origin_not_allowed` on the field.
- Invalid id in URL: an id failing `APP_ID_RE` returns Not Found before any DB read (`[appId]/page.tsx:33`).
- Concurrency: last write wins on PATCH; there is no If-Match on this form. `TODO: verify` whether stale-edit protection is expected here.

Accessibility: disabled state is conveyed via the disabled attribute; error region is `role="alert"`; success is `role="status"` (`_enterprise-app-settings-form.tsx:271`).
i18n: status option labels, field labels, and the "Global" org label localize.

---

## Email

### UAT-ADMIN-AEK-EMAIL-OUTBOX - Email outbox

- Route: `/app/administrator/email` · Example URL: `/en/app/administrator/email` · Code: `src/app/[locale]/(secure)/app/administrator/email/page.tsx:20`
- Purpose: The operator's source of truth for outbound email. **Outbox-first**: every message is recorded in `app_outbox` before any delivery attempt, so rows appear even where no delivery provider is configured (kept as `logged`) (`email/page.tsx:8`; `src/app/api/administrator/email/outbox/route.ts:18`).
- Guard / who can access: `admin.email.read` to view; the toolbar "Send test email" action additionally needs `admin.email.manage` (`email/page.tsx:26`,`:30`).
- Access matrix:
  - Visitor / Member / Limited Admin -> Not Found.
  - Org Admin -> sees only their own org's mail rows; can send a test email attributed to their org (`outbox/route.ts:57`; test route `src/app/api/administrator/email/test/route.ts:37`).
  - Superadmin -> sees every org's mail plus org-less platform/system rows; a test email is a platform (org-less) test.
- Preconditions and test data: signed in as the target persona. Trigger at least one email first (e.g. a password reset) so the outbox has rows, or use the Send test email action.

User stories

- UAT-ADMIN-AEK-EMAIL-OUTBOX-S1 — As an Org Admin, I want to see whether the system tried to email a user, so that I can debug delivery.
  - Acceptance criteria: Given outbox rows exist in my org, when I open the outbox, then I see a grid of Created at, To, Subject, Template, Status, newest first (`_outbox-grid.tsx:65`,`:142`); opening a row shows the full detail including bodies as text.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open the Communication group, then **Email outbox** | The outbox grid loads, newest first |
    | 2 | Read the columns | Created at, To, Subject, Template, Status |
    | 3 | Set the Status filter to **Logged** | Only `logged` rows remain (messages recorded but not delivered) |
    | 4 | Type a template key (e.g. `password_reset`) into the Template filter | Rows narrow to that template |
    | 5 | Click **View** on a row | A side panel opens showing From, To, Template, Provider, timestamps, and the message body rendered as plain text |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-EMAIL-OUTBOX-S2 — As an Org Admin, I want to send a test email, so that I can confirm rendering and provider wiring end to end.
  - Acceptance criteria: Given I hold `admin.email.manage`, when I enter an address and Send, then a result message shows the delivery status and a new outbox row appears; with no provider configured the status is `logged` (`_outbox-grid.tsx:214`; test route sends the `test_email` template at `test/route.ts:63`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, in the outbox toolbar find the **Send test email** control | An email input and a Send button are shown |
    | 2 | Enter a valid address and click **Send** | A short result message appears (e.g. delivered / logged) |
    | 3 | Watch the grid | A new row for the `test_email` template appears near the top |
    | 4 | Open the new row's detail | To matches your address; Status matches the result; body is text |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-EMAIL-OUTBOX-S3 — As a read-only email admin, I want the outbox without the Send action, so that I cannot generate mail.
  - Acceptance criteria: Given I hold `admin.email.read` but not `.manage`, when I open the outbox, then the Send test email control is absent (`_outbox-grid.tsx:204`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as an admin holding only `admin.email.read` | Console loads |
    | 2 | Open the Email outbox | The grid renders; there is no Send test email control |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______  *(precondition: a read-only email role is not in the default seed — `TODO: verify` by creating one)*

- UAT-ADMIN-AEK-EMAIL-OUTBOX-S4 — As a Member, I want the outbox to be unreachable, so that mail contents stay admin-only.
  - Acceptance criteria: Given I hold no `admin.*`, when I open the outbox URL, then I get Not Found.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a plain member | Dashboard loads |
    | 2 | Go to `/en/app/administrator/email` | Not-Found page (404) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Out-of-scope -> the outbox is org-scoped; an Org Admin never sees other orgs' rows (`outbox/route.ts:57`); a Member/Limited Admin gets 404 at the guard.
- Invalid test address -> the email input is `type="email"` and Send is disabled until non-empty; the server validates the address and returns `invalid_body` 400 for a bad one (`test/route.ts:58`).
- No provider configured -> the message is still recorded as `logged` (outbox-first), proving rendering + wiring.
- HTML safety: bodies are rendered as text only (never `dangerouslySetInnerHTML`) so an admin-edited template cannot inject HTML into the operator's browser (`_outbox-grid.tsx:19`).
- Rate limit: the test action is limited via `admin.email.test` (`test/route.ts:43`); expect a friendly failure on abuse. `TODO: verify` the exact 429 copy.

Accessibility: the test email input has an `aria-label`; the detail panel is a focus-trapped sheet with Esc to close; body text is a `pre` block.
i18n: status labels, filter labels, and detail field labels localize in `en` and `uk`.

### UAT-ADMIN-AEK-EMAIL-TEMPLATES - Email templates list

- Route: `/app/administrator/email/templates` · Example URL: `/en/app/administrator/email/templates` · Code: `src/app/[locale]/(secure)/app/administrator/email/templates/page.tsx:29`
- Purpose: The editable email-template catalog, keyed by template key and locale. The set is small and bounded, so the page server-renders the full table; each row (for managers) links to the edit page.
- Guard / who can access: `admin.email.read` to view; the per-row **Edit** link is shown only when the caller also holds `admin.email.manage` (`templates/page.tsx:35`,`:39`,`:91`).
- Access matrix:
  - Visitor / Member / Limited Admin -> Not Found.
  - Org Admin -> can view the catalog (it is platform-global config, no tenant column, so viewing is not a cross-tenant leak) and sees the Edit links, but **saving is superadmin-only** (see the edit screen).
  - Superadmin -> can view and edit.
- Preconditions and test data: signed in as the target persona; templates are seeded (e.g. `password_reset`, `test_email`) (`src/lib/email/templates.ts:46`,`:156`).

User stories

- UAT-ADMIN-AEK-EMAIL-TEMPLATES-S1 — As an admin, I want to see every template and locale, so that I know what the system can send.
  - Acceptance criteria: Given `admin.email.read`, when I open the list, then I see a table of Key, Locale, Subject, Updated at, ordered by key then locale (`templates/page.tsx:44`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open Communication, then **Email templates** | The templates table loads |
    | 2 | Read the columns | Key, Locale, Subject, Updated at (and an action cell) |
    | 3 | Confirm ordering | Rows are grouped by key, then by locale |
    | 4 | Find a template with several locales (e.g. `password_reset`) | You see one row per locale, each with its localized subject |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-EMAIL-TEMPLATES-S2 — As a Member, I want the templates list to be unreachable, so that message copy stays admin-only.
  - Acceptance criteria: Given no `admin.*`, when I open the templates URL, then I get Not Found.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a plain member | Dashboard loads |
    | 2 | Go to `/en/app/administrator/email/templates` | Not-Found page (404) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Empty state: if no templates exist the table shows a localized "empty" row (`templates/page.tsx:70`).
- Edit visibility: a caller with `admin.email.read` only sees no Edit links (`templates/page.tsx:91`).
- The list is not a client grid — no search/sort/pagination controls; it is a full server-rendered table by design.

Accessibility: the table has a `containerLabel`; keys render as code; the Edit control is a labelled link/button.
i18n: headers, the empty message, and subjects localize; the Locale column shows the locale code uppercased.

### UAT-ADMIN-AEK-EMAIL-TEMPLATE-EDIT - Edit email template

- Route: `/app/administrator/email/templates/[templateId]` · Example URL: `/en/app/administrator/email/templates/<uuid>` · Code: `src/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/page.tsx:21`
- Purpose: Edit one template's subject, HTML body, text body, and description. `key` and `locale` are shown but immutable (flows send against the key).
- Guard / who can access: the page requires `admin.email.manage` (`[templateId]/page.tsx:27`). **Important:** the save route (`PUT /api/administrator/email/templates/[id]`) additionally requires the caller be a **Superadmin** — an Org Admin can open the form but the save is refused with `forbidden` 403 (`src/app/api/administrator/email/templates/[id]/route.ts:74`; the form surfaces it at `_template-edit-form.tsx:84`).
- Access matrix:
  - Visitor / Member / Limited Admin -> Not Found.
  - Org Admin -> can open the editor (has `admin.email.manage`) but **cannot save** — Save returns a Forbidden root error.
  - Superadmin -> can open and save (edits affect every tenant, hence superadmin-only).
- Preconditions and test data: a valid template UUID; an id failing UUID validation returns Not Found (`[templateId]/page.tsx:31`).

User stories

- UAT-ADMIN-AEK-EMAIL-TEMPLATE-EDIT-S1 — As a Superadmin, I want to edit a template in a specific locale, so that I can adjust the wording users receive.
  - Acceptance criteria: Given valid subject + HTML body, when I Save, then I am returned to the templates list and the change persists (`_template-edit-form.tsx:75`; PUT bumps `updated_at` at `[id]/route.ts:110`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `superuser@orga.local` and open Email templates | The catalog loads with Edit links |
    | 2 | Click **Edit** on a non-English row (e.g. the `uk` password_reset) | The editor opens; the key and locale are shown as read-only |
    | 3 | Note any `{{variable}}` hints listed above the fields | Known variables for that key are shown as code chips |
    | 4 | Change the **Subject** and **HTML body**, keep both non-empty, and click **Save** | You return to the templates list; the row's Updated at is refreshed |
    | 5 | Re-open the same template | Your new subject/body are shown |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-EMAIL-TEMPLATE-EDIT-S2 — As an Org Admin, I want a clear Forbidden result if I try to save a global template, so that platform config stays superadmin-controlled.
  - Acceptance criteria: Given I am an Org Admin (no `superuser` marker), when I open the editor and click Save, then a root Forbidden error appears and nothing is persisted (`[id]/route.ts:74`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open a template's Edit page | The editor opens (you hold `admin.email.manage`) |
    | 2 | Make any valid change and click **Save** | A red "forbidden" alert appears; you are not redirected and the template is unchanged |
    | 3 | Re-open the template as Superadmin | The original content is intact (your Org Admin save had no effect) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-EMAIL-TEMPLATE-EDIT-S3 — As a Superadmin, I want required-field validation, so that I cannot ship an empty subject or body.
  - Acceptance criteria: Given an empty Subject or HTML body, when I submit, then the field shows a required error and the save is blocked (`src/lib/validation/email-templates.ts:13`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Superadmin, open a template editor | The editor loads with a required-field legend |
    | 2 | Clear the **Subject** and submit | The Subject shows a required error with a red border |
    | 3 | Restore the subject, clear the **HTML body**, and submit | The HTML body shows a required error |
    | 4 | Confirm **Text body** and **Description** are optional | Leaving them empty does not block submission |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Superadmin-only save: this is the load-bearing check for this screen — Org Admin can open, cannot save.
- Injection safety: `{{variable}}` placeholders are substituted and HTML-escaped by the renderer, so an editor cannot produce injectable output via variables (`_template-edit-form.tsx:31`).
- Invalid/missing template id -> Not Found before edit (`[templateId]/page.tsx:31`).
- Rate limit: PUT is limited via `admin.email.templates` (`[id]/route.ts:78`). `TODO: verify` the exact 429 copy.

Accessibility: `noValidate` form with schema-driven markers; body fields are labelled monospace textareas; error region is `role="alert"`.
i18n: labels, the variables hint, and validation messages localize in `en` and `uk`.

---

## API keys

### UAT-ADMIN-AEK-APIKEYS-LIST - API keys governance

- Route: `/app/administrator/api-keys` · Example URL: `/en/app/administrator/api-keys` · Code: `src/app/[locale]/(secure)/app/administrator/api-keys/page.tsx:20`
- Purpose: The cross-user, cross-org API-key inventory. Read-only admins see the full inventory with a status filter and per-row detail; managers additionally get inline Rotate / Revoke. Secrets are never in list data (`_api-keys-grid.tsx:37`; API never returns the hash, `src/lib/api-auth/api-keys.server.ts:18`).
- Guard / who can access: `admin.apikeys.read` to view; Rotate/Revoke/Issue are gated on `admin.apikeys.manage` client-side and re-checked on every route (`api-keys/page.tsx:26`,`:30`; API `GET` at `src/app/api/administrator/api-keys/route.ts:59`).
- Access matrix:
  - Visitor / Member / Limited Admin -> Not Found.
  - Org Admin -> sees only their own org's keys; can rotate/revoke within their org (`route.ts:73`).
  - Superadmin -> sees every org's keys; can act everywhere.
- Preconditions and test data: at least one API key exists for a user in scope (issue one via the New API key screen first).

User stories

- UAT-ADMIN-AEK-APIKEYS-LIST-S1 — As an Org Admin, I want to review issued keys and their status, so that I can govern machine access.
  - Acceptance criteria: Given keys exist in my org, when I open the list, then I see Name, Prefix (`drk_..…`), Owner, Scopes count, Status, Last used, Expires, Created, newest first (`_api-keys-grid.tsx:126`,`:265`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local` and open the APIs group, then **API keys** | The inventory grid loads, newest first |
    | 2 | Read the columns | Name, Prefix, Owner, Scopes, Status, Last used, Expires, Created |
    | 3 | Confirm the Prefix cell shows a truncated `drk_<env>_...` value, never a full secret | Only the display prefix is shown |
    | 4 | Set the Status filter to **Revoked** | Only revoked keys remain |
    | 5 | Click a key **Name** (or **View**) | A side panel shows owner, creator, scopes, timestamps; no secret is present |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APIKEYS-LIST-S2 — As an Org Admin, I want to rotate a key, so that I can replace a possibly-leaked secret without disruption.
  - Acceptance criteria: Given an active key, when I confirm Rotate, then a new secret is revealed exactly once and the old key is immediately revoked (`_api-keys-grid.tsx:101`; rotate route returns the new plaintext once at `src/app/api/administrator/api-keys/[id]/rotate/route.ts:81`; atomic issue+revoke at `api-keys.server.ts:166`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, on an **active** key row, click **Rotate** | A confirm dialog appears with the key name |
    | 2 | Confirm | A reveal dialog shows the new full secret with a copy button and a "shown only once" warning |
    | 3 | Copy the secret and close the dialog | The grid refreshes |
    | 4 | Find the original key row | Its status is now Revoked |
    | 5 | Try to Rotate the now-revoked key | The Rotate/Revoke actions are no longer offered on that row (only active keys show them) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APIKEYS-LIST-S3 — As an Org Admin, I want to revoke a key, so that I can cut off access immediately.
  - Acceptance criteria: Given an active key, when I confirm Revoke, then the row becomes Revoked; revoking an already-revoked key is a no-op success (`_api-keys-grid.tsx:79`; DELETE idempotent at `src/app/api/administrator/api-keys/[id]/route.ts:128`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, on an active key row, click **Revoke** | A destructive confirm dialog appears |
    | 2 | Confirm | The row's status changes to Revoked after the grid refreshes |
    | 3 | Open the key's detail panel | The Revoked-by and Revoked-at fields are populated |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APIKEYS-LIST-S4 — As a read-only admin, I want the inventory without destructive controls, so that I can audit without acting.
  - Acceptance criteria: Given `admin.apikeys.read` but not `.manage`, when I open the list, then rows show only View — no Rotate/Revoke and no New API key button (`_api-keys-grid.tsx:215`; `api-keys/page.tsx:43`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as an admin holding only `admin.apikeys.read` | Console loads |
    | 2 | Open API keys | Rows show a View action only; there is no New API key button |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______  *(precondition: a read-only api-keys role is not in the default seed — `TODO: verify` by creating one)*

- UAT-ADMIN-AEK-APIKEYS-LIST-S5 — As a Member, I want the governance list to be unreachable, so that only admins govern keys.
  - Acceptance criteria: Given no `admin.*`, when I open the list URL, then I get Not Found.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a plain member | Dashboard loads |
    | 2 | Go to `/en/app/administrator/api-keys` | Not-Found page (404) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Out-of-scope -> org-scoped list; an Org Admin never sees other orgs' keys, and a detail/rotate/revoke by id for a foreign key returns Not Found (404), not 403 (`route.ts:63`; rotate `rotate/route.ts:58`; delete `[id]/route.ts:125`).
- Idempotent revoke -> revoking an already-revoked key returns success with `alreadyRevoked` and writes no duplicate audit row (`[id]/route.ts:129`).
- Rotate a non-active key -> 409 `api_key_inactive` (`rotate/route.ts:61`); a lost race also yields 409 (`rotate/route.ts:66`); the grid shows a rotate-error alert.
- Secret exposure -> the reveal dialog is the only place a plaintext is shown; the list/detail never contain it or its hash.
- Rate limit -> rotate/revoke are limited via `admin.apikeys.rotate` / `admin.apikeys.delete`; abuse yields a friendly failure. `TODO: verify` the exact 429 copy.

Accessibility: the reveal dialog is a focus-trapped modal with a read-only, selectable secret field and copy button (`src/components/api-keys/api-key-reveal.tsx:62`); confirm dialogs support Esc; the row error is `role="alert"`.
i18n: status labels, scope-count text, filter labels, and detail labels localize in `en` and `uk`.

### UAT-ADMIN-AEK-APIKEYS-NEW - Issue an API key on behalf of a user

- Route: `/app/administrator/api-keys/new` · Example URL: `/en/app/administrator/api-keys/new` · Code: `src/app/[locale]/(secure)/app/administrator/api-keys/new/page.tsx:18`
- Purpose: Mint a key for a specific user, choosing scopes and an optional expiry. The plaintext is revealed exactly once, then you return to the list.
- Guard / who can access: `admin.apikeys.manage` (page `new/page.tsx:24`; API `POST` at `src/app/api/administrator/api-keys/route.ts:154`).
- Access matrix:
  - Visitor / Member / Limited Admin / read-only apikeys admin -> Not Found (the page itself requires `.manage`).
  - Org Admin -> can issue keys only for a user in their own org; a foreign user is reported as "owner not found" (404) to avoid confirming existence (`route.ts:200`).
  - Superadmin -> can issue for any user.
- Preconditions and test data: the target user's app-user UUID (from the Users area). The requested scopes must be within the OWNER's own authority — you cannot mint a key that out-scopes the user who will wield it (`route.ts:204`).

User stories

- UAT-ADMIN-AEK-APIKEYS-NEW-S1 — As an Org Admin, I want to issue a scoped key for a user, so that their integration can call the API as themselves.
  - Acceptance criteria: Given a valid owner UUID and grantable scopes, when I submit, then the new secret is revealed exactly once and closing the dialog returns me to the list (`_new-api-key-form.tsx:73`,`:231`; API returns 201 with the plaintext at `route.ts:243`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, open the APIs group and click **New API key** | The issue form opens with a required-field legend |
    | 2 | Enter a **Name**, paste the target user's **owner** UUID | Fields accept the values |
    | 3 | Optionally set **Expires in days** (1–3650) | The field accepts the number or stays empty for no expiry |
    | 4 | Tick one or more **scopes** the user already holds | The checkboxes toggle |
    | 5 | Click Submit | A reveal dialog shows the full `drk_<env>_...` secret with a copy button and a once-only warning |
    | 6 | Copy the secret and click Done | You return to the API keys list, where the new key appears |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APIKEYS-NEW-S2 — As an Org Admin, I want clear errors when the owner is wrong or the scopes are too broad, so that I cannot mint an over-privileged key.
  - Acceptance criteria: Given a missing owner, then the owner field shows "owner not found" (404); given an inactive owner, "owner inactive" (409); given scopes the owner lacks, the scopes group shows which scopes are ungrantable (422 `invalid_scope` with `ungrantableScopes`) (`_new-api-key-form.tsx:78`,`:86`; `route.ts:189`,`:194`,`:206`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Enter a well-formed but non-existent owner UUID and submit | The owner field shows an "owner not found" error |
    | 2 | Enter the UUID of a blocked/suspended user and submit | The owner field shows an "owner inactive" error |
    | 3 | Enter a valid active owner, tick a scope that user does NOT hold, and submit | The scopes group shows an error naming the ungrantable scope(s) |
    | 4 | Clear the **Name** and submit | The Name shows a required error with a red border |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-APIKEYS-NEW-S3 — As an Org Admin, I want a foreign-org user to look identical to a missing user, so that cross-tenant existence never leaks.
  - Acceptance criteria: Given a valid, active user in a DIFFERENT org, when I submit, then I get "owner not found" (404) — the same as a non-existent user (`route.ts:200`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As `orgadmin@orga.local`, obtain the UUID of an active user in ORG B (via a Superadmin window) | You have the id |
    | 2 | Enter it as the owner and submit | The owner field shows "owner not found" — indistinguishable from a made-up id |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Owner validation: bad UUID format is caught client-side by the shared schema (`src/lib/validation/api-keys.ts:18`); missing/inactive/foreign owner is caught server-side (404/409/404).
- Ungrantable scopes: scopes are validated against the OWNER's authority, never the admin's (`route.ts:204`).
- Once-only reveal: the secret is returned exactly once; if the tester misses it they must rotate/re-issue.
- Rate limit: creation is limited via `admin.apikeys.create` (`route.ts:158`). `TODO: verify` the exact 429 copy.

Accessibility: scopes are a labelled `fieldset`/`legend` with checkboxes; the reveal dialog is a focus-trapped modal; root/field errors use `role="alert"` / form messages.
i18n: labels, help text, and error messages localize in `en` and `uk`.

---

## Audit

### UAT-ADMIN-AEK-AUDIT-LOG - Audit log

- Route: `/app/administrator/audit` · Example URL: `/en/app/administrator/audit` · Code: `src/app/[locale]/(secure)/app/administrator/audit/page.tsx:19`
- Purpose: A read-only, paginated explorer over `app_audit_events` — the append-only, tamper-evident record of admin/auth/account activity. Filters by event type, outcome, and actor; each row opens a detail panel with the full JSON metadata, IP, user agent, and reason.
- Guard / who can access: `admin.audit.read` (page `audit/page.tsx:25`; API `GET` at `src/app/api/administrator/audit/route.ts:65`). There is **no** create/update/delete route — the log is append-only and cannot be edited from the console (only `GET` exists at `src/app/api/administrator/audit/route.ts`).
- Access matrix:
  - Visitor / Member -> Not Found.
  - Limited Admin (`admin` role) -> **can** open the audit log (it holds `admin.audit.read`), scoped to its org.
  - Org Admin -> can open; sees only their org's events (platform events with a null org are superadmin-only) (`route.ts:86`).
  - Superadmin -> sees every org's events plus org-less platform events.
- Preconditions and test data: the seed back-dates an audit history (logins plus a spread of admin/account events) (`src/db/seeds/dev-init.ts:20`). Perform a couple of admin actions first (e.g. rotate a key) to generate fresh rows.

User stories

- UAT-ADMIN-AEK-AUDIT-LOG-S1 — As a Limited Admin, I want to scan recent activity, so that I can see who did what.
  - Acceptance criteria: Given `admin.audit.read`, when I open the log, then I see Created at, Event type, Outcome, Actor, Target, newest first, page size 50 (`_audit-grid.tsx:85`,`:176`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a user with the `admin` role (e.g. `user1@orga.local`, who gains it via the Engineering group) | Console loads with an Activity group in the sidebar |
    | 2 | Open **Audit log** | The grid loads, newest first |
    | 3 | Read the columns | Created at, Event type, Outcome, Actor, Target |
    | 4 | Confirm Outcome badges are colour-coded | success is muted; error/denied are destructive |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-AUDIT-LOG-S2 — As an Org Admin, I want to filter the log, so that I can find a specific event class or actor.
  - Acceptance criteria: Given the filter toolbar, when I set Event type / Outcome / Actor, then the grid narrows and the filters are reflected in the URL so a shared link reproduces the view (`_audit-grid.tsx:205`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Org Admin, open the Audit log | The filter toolbar shows Event type, Outcome, Actor |
    | 2 | Type `admin.api_key.rotated` into Event type | The grid narrows to rotation events |
    | 3 | Set Outcome to **Denied** | Only denied-outcome rows remain |
    | 4 | Copy the URL and open it in a new tab | The same filtered view is reproduced |
    | 5 | Click **View** on a row | A side panel shows actor, target ids, IP, user agent, reason, and the full JSON metadata |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-AUDIT-LOG-S3 — As an Org Admin, I want the log confined to my org, so that I never see another tenant's activity.
  - Acceptance criteria: Given I am an Org Admin, when I browse the log, then only my org's events appear; platform (org-less) events are not shown (`route.ts:86`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As Superadmin, note an event that belongs to ORG B (or a platform/system event) | You have a reference row |
    | 2 | Sign in as `orgadmin@orga.local` and open the Audit log | That ORG B / platform event does not appear anywhere in your results |
    | 3 | Filter by an actor from ORG B | No rows are returned |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ADMIN-AEK-AUDIT-LOG-S4 — As a Member, I want the audit log unreachable, so that activity data stays admin-only.
  - Acceptance criteria: Given no `admin.*`, when I open the log URL, then I get Not Found.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a plain member | Dashboard loads |
    | 2 | Go to `/en/app/administrator/audit` | Not-Found page (404) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative and edge cases
- Append-only / tamper-evident: there is no console affordance to edit or delete an audit row — the API exposes `GET` only. Confirm you cannot mutate an entry from the UI.
- Out-of-scope -> org-scoped; an Org Admin never sees other orgs' or platform events; a Member gets 404.
- Metadata safety: `metadata` is rendered as a JSON string and never executed (`_audit-grid.tsx:36`,`:270`).
- Empty/filtered-to-nothing: an over-narrow filter shows an empty grid, not an error.
- Legacy outcome values: `failure` is treated like `error` for colour so historical rows still render (`_audit-grid.tsx:195`); the Outcome filter still lists it.

Accessibility: the filter toolbar controls are labelled (`htmlFor` on each); the detail sheet is focus-trapped with Esc; metadata is a `pre` block.
i18n: column headers, outcome labels, and filter labels localize in `en` and `uk`; timestamps use the locale formatter.

---

## Coverage matrix (screens x personas)

Legend: `see` = can open and read · `act` = can perform the screen's mutations · `404` = Not Found (out of scope) · `n/a` = no mutation on this screen.

| Screen | Visitor | Member | Limited Admin | Org Admin | Superadmin |
| --- | --- | --- | --- | --- | --- |
| Enterprise apps list | 404 | 404 | 404 | see + act (own org) | see + act (all) |
| Enterprise app create | 404 | 404 | 404 | act (own org) | act (all) |
| Enterprise app detail | 404 | 404 | 404 | see + act (own org) | see + act (all) |
| Email outbox | 404 | 404 | 404 | see + act (test send) | see + act |
| Email templates list | 404 | 404 | 404 | see | see |
| Email template edit | 404 | 404 | 404 | see, **cannot save (403)** | see + act (save) |
| API keys list | 404 | 404 | 404 | see + act (own org) | see + act (all) |
| API key issue (new) | 404 | 404 | 404 | act (own org) | act (all) |
| Audit log | 404 | 404 | see (own org) | see (own org) | see (all) |

Notes on the matrix:
- **Limited Admin** (`admin` seed role) holds only `admin.users.*` + `admin.audit.read`, so of this set it can open **Audit** only; everything else is 404 (`src/db/seeds/dev-init.ts:249`).
- **Org Admin can open the template editor but not save** — the save is superadmin-only (`src/app/api/administrator/email/templates/[id]/route.ts:74`).
- Every "act" for an Org Admin is confined to their own org via ADR-0001 org-scoping; out-of-scope ids return 404, not 403.

## Inventory checklist (definition of done)

- [x] `enterprise-apps` (list) — UAT-ADMIN-AEK-APPS-LIST
- [x] `enterprise-apps/new` — UAT-ADMIN-AEK-APPS-NEW
- [x] `enterprise-apps/[appId]` (detail) — UAT-ADMIN-AEK-APPS-DETAIL
- [x] `email` (outbox) — UAT-ADMIN-AEK-EMAIL-OUTBOX
- [x] `email/templates` (list) — UAT-ADMIN-AEK-EMAIL-TEMPLATES
- [x] `email/templates/[templateId]` (edit) — UAT-ADMIN-AEK-EMAIL-TEMPLATE-EDIT
- [x] `api-keys` (list) — UAT-ADMIN-AEK-APIKEYS-LIST
- [x] `api-keys/new` — UAT-ADMIN-AEK-APIKEYS-NEW
- [x] `audit` — UAT-ADMIN-AEK-AUDIT-LOG
- [x] Each gated screen has a persona who can and one who cannot (asserting 404-not-403).
- [x] Each screen has a happy path plus negative/edge cases, empty/loading/error, required-field validation, and a11y + i18n notes.

## TODO: verify

- The exact user-facing message shown on an admin **rate-limit (HTTP 429)** for each mutating action (create/delete app, send test email, save template, issue/rotate/revoke key). The grids/forms map specific status codes (404/409/422/400/403) explicitly; 429 falls through to the generic error text, but the precise copy was not confirmed from code.
- **Read-only-in-one-area personas** (e.g. an admin with `admin.apps.read` but not `.manage`, or `admin.email.read` only, or `admin.apikeys.read` only) are **not** in the default seed. Stories that assert "read-only sees no destructive controls" require creating such a role first. Only `admin.platform` (full set) and `admin` (users + audit) exist by default (`src/db/seeds/dev-init.ts:239`).
- Enterprise-app **status values**: the create/edit form and grid filter expose `available` and `disabled` only (`src/lib/admin/enterprise-apps.ts:61`), but a `degraded` value is referenced by the launcher and the outbox/audit colour helpers. Confirm whether `degraded` is a still-reachable status for an enterprise app or purely legacy.
- Enterprise-app detail PATCH has **no If-Match / stale-edit protection**; confirm whether concurrency protection is expected for this form (last-write-wins today).
