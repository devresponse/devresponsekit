---
title: "UAT — Account & secure shell"
description: User-acceptance stories for the secure shell entry, dashboard, workspace, the five Account sections, and the in-app documentation viewer.
group: QA
visibility: internal
order: 20
---

# UAT — Account & secure shell

Screen-by-screen User Acceptance Testing stories for the authenticated **secure shell** (`/app` entry, dashboard, workspace), the self-service **Account** area (overview, profile, preferences, security, API keys), and the in-app **documentation viewer** (landing + article).

Every story is runnable by a non-technical tester from its preconditions. Each cites the code it was validated against. Where a fact could not be confirmed it is marked `TODO: verify`.

## Test environment & accounts

Seed the personas with the development fixture, then sign in at the base URL.

- Base URL: `http://localhost:3000` (dev). All routes are locale-prefixed, e.g. `/en/app/dashboard`.
- Seed: run `pnpm db:seed:dev` (source: `src/db/seeds/dev-init.ts`). This creates three orgs (`ORG A` / `ORG B` / `ORG C`, domains `orga.local` / `orgb.local` / `orgc.local`) and, per org, the accounts `superuser@<domain>`, `orgadmin@<domain>`, and `user1..5@<domain>`, plus three cross-org members `multi1..3@shared.local`.
- Reset: `pnpm db:reset:reload` re-provisions and reseeds (`src/db/seeds/dev-init.ts:747` refuses to run under `NODE_ENV=production`).
- Password: every seeded account shares one password, `DevPassword123!` (override with `DEV_SEED_PASSWORD`; `src/db/seeds/dev-init.ts:52`).
- Locales to test: `en` plus one non-Latin locale — use `uk` (Ukrainian) or `ja` (Japanese).

Persona-to-account map for this area:

| Persona | Seed account | Role / state |
|---|---|---|
| Member | `user5@orga.local` | `member` (USER) — secure-shell self-service, no admin |
| Limited Admin | `user1@orga.local` | `member` **plus** the `admin` role conferred by the Engineering group (`src/db/seeds/dev-init.ts:141`) |
| Org Admin | `orgadmin@orga.local` | `admin.platform` — full `admin.*` within ORG A |
| Superadmin | `superuser@orga.local` | `superuser` — every org |
| Multi-org member | `multi1@shared.local` | `member` in all three orgs (exercises the org switcher) |
| Visitor | (unauthenticated) | public pages + sign-in only |
| Pending user | a freshly self-signed-up account | `pending_approval` |
| Blocked user | an admin-blocked account | `blocked` / `suspended` |

Everything under `/[locale]/app/**` is guarded by the secure layout `SecureLayout` (`src/app/[locale]/(secure)/layout.tsx:56`), which calls `requireSecureSession` (`src/lib/auth-guard.ts:55`). That helper redirects: no session → `/{locale}/sign-in?returnTo=…`; status pending → `/{locale}/pending-approval`; status blocked/suspended → `/{locale}/blocked`. By the time any page in this area renders, the caller is guaranteed an `active` user with an `active` membership. Every Account and Docs page calls `requireSecureSession` a second time with its own `returnTo`, so a deep link is preserved through the sign-in bounce.

The Account write surface is strictly self-scoped: the API guard `requireAccountUser` (`src/lib/account/guard.server.ts:48`) exposes only the caller's own `appUserId`, and every route scopes its writes to it — no id is ever read from the request body. There is therefore no cross-tenant read/write to exercise in Account except the API-key `[id]` routes, which return **404 (not 403)** for a key that is not the caller's own (`src/app/api/v1/me/api-keys/[id]/route.ts:44`).

---

## Secure shell

### UAT-ACCOUNT-APP-ENTRY — App entry / redirect

- Route: `/app`  ·  Example URL: `/en/app`  ·  Code: `src/app/[locale]/(secure)/app/page.tsx:5`
- Purpose: The bare `/app` entry point. It does not render UI; it immediately redirects to the dashboard.
- Guard / who can access: Inherits `SecureLayout` → `requireSecureSession`. The page itself only sanitizes the locale (`isSupportedLocale`, else `en`) and redirects to `/{locale}/app/dashboard` (`src/app/[locale]/(secure)/app/page.tsx:8`).
- Access matrix:
  - Visitor: redirected to sign-in (layout guard) — cannot see.
  - Pending: redirected to `pending-approval` — cannot see.
  - Blocked: redirected to `blocked` — cannot see.
  - Member / Limited Admin / Org Admin / Superadmin: redirected to `dashboard` — can see (the dashboard).
- Preconditions & test data: A seeded active member (`user5@orga.local`).

User stories

- UAT-ACCOUNT-APP-ENTRY-S1 — As a Member, I want `/app` to take me to my dashboard, so that I have one stable entry URL that always lands somewhere useful.
  - Acceptance criteria: Given I am signed in, when I open `/en/app`, then the address bar ends at `/en/app/dashboard` and the Dashboard heading is shown.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local`. | You are on the dashboard. |
    | 2 | In the address bar, go to `/en/app`. | The URL changes to `/en/app/dashboard`; the page heading reads **Dashboard**. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-APP-ENTRY-S2 — As a Visitor, I want `/app` to send me to sign in, so that I cannot reach the shell unauthenticated.
  - Acceptance criteria: Given I am signed out, when I open `/en/app`, then I land on the sign-in page with a `returnTo` that points back into the shell.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign out (or use a private window). | You are unauthenticated. |
    | 2 | Open `/en/app`. | You land on `/en/sign-in`; the URL carries a `returnTo` parameter pointing to a `/en/app/...` path. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Unsupported locale: `/qq/app` treats the locale as `en` for the redirect target (`src/app/[locale]/(secure)/app/page.tsx:7`). Verify it does not error. `TODO: verify` how an unknown top-level locale segment is handled upstream by the locale routing (may 404 before reaching this page).
- Pending user hitting `/app` is redirected to `pending-approval`, not the dashboard.

Accessibility: No interactive UI — this is a redirect. The destination (dashboard) is covered below.
i18n: The redirect preserves the requested supported locale; an unsupported one falls back to `en`.

### UAT-ACCOUNT-DASHBOARD — Dashboard

- Route: `/app/dashboard`  ·  Example URL: `/en/app/dashboard`  ·  Code: `src/app/[locale]/(secure)/app/dashboard/page.tsx:11`
- Purpose: The default landing screen inside the secure shell. It is intentionally a minimal placeholder — a heading and a welcome line; dashboard widgets are out of scope for the scaffold (`src/app/[locale]/(secure)/app/dashboard/page.tsx:4`).
- Guard / who can access: No per-page guard call; protected by `SecureLayout` → `requireSecureSession`.
- Access matrix:
  - Visitor / Pending / Blocked: redirected away by the layout guard — cannot see.
  - Member / Limited Admin / Org Admin / Superadmin: can see; content is identical for every role (no permission-gated widgets here).
- Preconditions & test data: A seeded active member.

User stories

- UAT-ACCOUNT-DASHBOARD-S1 — As a Member, I want a dashboard landing page after sign-in, so that I know I am inside the secure app.
  - Acceptance criteria: Given I sign in, when the app loads, then I see a page whose heading is the localized **Dashboard** label and a welcome line naming the product.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local`. | The main heading reads **Dashboard** (from the `shell.dashboard` label). |
    | 2 | Read the body text. | A single welcome line is shown ("Welcome to the secure … shell."), naming the configured product. |
    | 3 | Confirm the left sidebar and top bar are present. | The shell chrome (sidebar, brand bar, sign-out) surrounds the content. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-DASHBOARD-S2 — As a Visitor, I want to be blocked from the dashboard, so that unauthenticated users never see shell content.
  - Acceptance criteria: Given I am signed out, when I open `/en/app/dashboard`, then I am redirected to sign-in and never see the Dashboard heading.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign out. | You are unauthenticated. |
    | 2 | Open `/en/app/dashboard` directly. | You are redirected to `/en/sign-in`; the Dashboard heading is not shown. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Pending user → `/app/dashboard` redirects to `pending-approval`; Blocked user → `blocked` (both via the layout guard, `src/lib/auth-guard.ts:67`).
- No empty/loading/error state applies — the page is static text.

Accessibility: One `<h1>`; keyboard focus lands on the shell skip-links first (`ShellSkipLinks`, `src/app/[locale]/(secure)/layout.tsx:75`). No axe violations expected on this minimal page.
i18n: The heading uses the `shell.dashboard` message; in `uk`/`ja` it must be translated, not a raw key. The welcome line is currently hardcoded English (`src/app/[locale]/(secure)/app/dashboard/page.tsx:17`) — flag this as a known non-localized string.

### UAT-ACCOUNT-WORKSPACE — Workspace

- Route: `/app/workspace`  ·  Example URL: `/en/app/workspace`  ·  Code: `src/app/[locale]/(secure)/app/workspace/page.tsx:3`
- Purpose: A nested shell content-area placeholder demonstrating a second in-shell route. Heading plus one descriptive line; no functional widgets.
- Guard / who can access: No per-page guard call; protected by `SecureLayout` → `requireSecureSession`.
- Access matrix:
  - Visitor / Pending / Blocked: redirected away — cannot see.
  - Member / Limited Admin / Org Admin / Superadmin: can see; identical for every role.
- Preconditions & test data: A seeded active member.

User stories

- UAT-ACCOUNT-WORKSPACE-S1 — As a Member, I want to open the Workspace area, so that I can navigate the shell beyond the dashboard.
  - Acceptance criteria: Given I am signed in, when I open `/en/app/workspace`, then I see a page whose heading is the localized **Workspace** label.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local`. | You are in the shell. |
    | 2 | Open `/en/app/workspace`. | The heading reads **Workspace** (from `shell.workspace`); a short line describes the nested content area. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-WORKSPACE-S2 — As a Visitor, I want the Workspace URL to be protected, so that shell routes are not reachable while signed out.
  - Acceptance criteria: Given I am signed out, when I open `/en/app/workspace`, then I am redirected to sign-in.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign out. | You are unauthenticated. |
    | 2 | Open `/en/app/workspace`. | You land on `/en/sign-in`. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Pending/Blocked redirect as above.
- No empty/loading/error state — static text.

Accessibility: Single heading; reachable by keyboard from the sidebar nav. No axe violations expected.
i18n: The **Workspace** heading is localized via `shell.workspace`; the descriptive line is currently hardcoded English (`src/app/[locale]/(secure)/app/workspace/page.tsx:8`) — flag as non-localized.

---

## Account

All Account pages live under `/[locale]/app/account/**`, each guarded by `requireSecureSession` and scoped to the caller's own record. The section titles/descriptions come from the `account.sections.*` messages.

### UAT-ACCOUNT-OVERVIEW — Account overview

- Route: `/app/account`  ·  Example URL: `/en/app/account`  ·  Code: `src/app/[locale]/(secure)/app/account/page.tsx:29`
- Purpose: A read-only summary of the caller's account: identity (display name, email, status, member-since), organization memberships, roles, and the full effective permission list. Editable areas live in the sub-sections; status/memberships/roles are admin-controlled and display-only here (`src/app/[locale]/(secure)/app/account/page.tsx:12`).
- Guard / who can access: `requireSecureSession(locale, "/{locale}/app/account")`. Additionally `notFound()` if the session has no provisioned `appUserId` or the overview row is missing (`src/app/[locale]/(secure)/app/account/page.tsx:38`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away — cannot see.
  - Member / Limited Admin / Org Admin / Superadmin: each sees **their own** overview only (data is keyed on `access.appUserId`). No cross-account view exists.
- Preconditions & test data: Sign in as a seeded account. For a rich permissions/roles display use `orgadmin@orga.local` (many permissions) vs. `user5@orga.local` (few/none).

User stories

- UAT-ACCOUNT-OVERVIEW-S1 — As a Member, I want to see all my account information at a glance, so that I can confirm who I am, my status, and what I can do.
  - Acceptance criteria: Given I am signed in, when I open Account overview, then I see my display name, email, status badge, member-since date, my organizations with per-org status badges, my roles, and my current permissions.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `orgadmin@orga.local`. | You are in the shell. |
    | 2 | Open `/en/app/account`. | The heading reads **Overview** with the description "A summary of your account information." |
    | 3 | Read the **Identity** card. | Shows Display name (or "—"), Email, a **Status** badge reading **Active**, and **Member since** with a long-form date. |
    | 4 | Read the **Organizations** card. | Lists **ORG A** with an **Active** badge; below it a **Roles** block lists your role name(s). |
    | 5 | Read the **Permissions** card. | Lists the permissions your roles grant, or the empty line if you have none. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-OVERVIEW-S2 — As a Member with no roles, I want clear empty messaging, so that a bare account does not look broken.
  - Acceptance criteria: Given I have no roles/permissions/memberships, when I open the overview, then each empty area shows its localized empty line rather than a blank space.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as a user with no roles (e.g. a freshly approved member). | You are in the shell. |
    | 2 | Open `/en/app/account`. | The Roles block shows **No roles assigned.** and the Permissions card shows **You have no permissions in the active organization.** |
    | 3 | If you belong to no org, read the Organizations card. | It shows **You are not a member of any organization.** |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Out-of-scope access: there is no id in the URL, so cross-account viewing is impossible by construction; the page is always the caller's own record.
- Not-provisioned session (no `appUserId`) → `notFound()` (404), not an error page (`src/app/[locale]/(secure)/app/account/page.tsx:38`).
- The status badge color varies: `active` is neutral; `blocked`/`suspended`/`deactivated` are destructive (`src/app/[locale]/(secure)/app/account/page.tsx:21`) — though a blocked user cannot reach this page, so this mainly affects a per-org membership status.
- No loading skeleton (server-rendered); no inline error (read-only).

Accessibility: Content is a set of definition lists (`<dl>`/`<dt>`/`<dd>`) and cards; status is conveyed by badge text, not color alone. Keyboard users can read top-to-bottom; no interactive controls to trap.
i18n: Status labels use `account.status.*`; run in `uk`/`ja` and confirm the status badge, the "Member since" date (formatted with `Intl.DateTimeFormat(locale, { dateStyle: "long" })`, `src/app/[locale]/(secure)/app/account/page.tsx:43`), and every card title localize; no raw keys.

### UAT-ACCOUNT-PROFILE — Profile

- Route: `/app/account/profile`  ·  Example URL: `/en/app/account/profile`  ·  Code: `src/app/[locale]/(secure)/app/account/profile/page.tsx:18`
- Purpose: Edit the caller's **Name** (Better Auth `user.name`) and optional **Display name** (app-side). Email is shown read-only — changing it is a future verified flow (`src/app/[locale]/(secure)/app/account/profile/page.tsx:11`).
- Guard / who can access: `requireSecureSession`; `notFound()` if no `appUserId` or profile row (`src/app/[locale]/(secure)/app/account/profile/page.tsx:27`). The write endpoint `PATCH /api/account/profile` is self-scoped via `requireAccountUser` (no scope required for a cookie session; `src/app/api/account/profile/route.ts:27`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away.
  - Member / Limited Admin / Org Admin / Superadmin: each edits **their own** profile only.
- Preconditions & test data: Sign in as `user5@orga.local`.
- Fields (`src/app/[locale]/(secure)/app/account/profile/_profile-form.tsx`): **Name** (required — validated by `updateProfileSchema`, `src/lib/validation/account.ts:14`, min 1 / max 120), **Display name** (optional, max 120), **Email** (read-only, disabled).

User stories

- UAT-ACCOUNT-PROFILE-S1 — As a Member, I want to update my name and display name, so that I appear correctly across the app.
  - Acceptance criteria: Given valid input, when I save, then the changes persist and a success line appears; the email field cannot be edited.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` and open `/en/app/account/profile`. | Heading **Profile**; a legend reads "\* indicates a required field". |
    | 2 | Confirm the **Name** label shows a required asterisk and **Display name** does not. | Name is marked required; Display name is optional. |
    | 3 | Change **Name** to `Sam Rivers` and **Display name** to `sam`. | Both accept the input. |
    | 4 | Confirm the **Email** field is disabled with the hint "Contact an administrator to change your email." | Email is read-only. |
    | 5 | Click **Save changes**. | A success line appears: "Your changes have been saved." |
    | 6 | Reload the page. | Name shows `Sam Rivers` and Display name shows `sam` (persisted). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-PROFILE-S2 — As a Member, I want the form to stop me submitting an empty name, so that I cannot blank out a required field.
  - Acceptance criteria: Given Name is empty, when I submit, then an inline required message appears, the field is marked invalid, and no save occurs.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | On the Profile form, clear the **Name** field. | Field is empty. |
    | 2 | Click **Save changes**. | An inline message appears under Name: **This field is required.**; the field shows an invalid state; the success line does NOT appear. |
    | 3 | Type any name and save. | The error clears and the save succeeds. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Server rejects a malformed body with 400 → the form shows the localized "Please check the form and try again." (`account.errors.invalid`); other failures show "Saving your changes failed. Please try again." (`src/app/[locale]/(secure)/app/account/profile/_profile-form.tsx:60`).
- Whitespace-only Name is trimmed to empty and rejected (schema `.trim().min(1)`).
- The Better Auth name write is attempted first; if it fails the API returns 502 and no display-name write happens (`src/app/api/account/profile/route.ts:59`). `TODO: verify` there is a UI way to trigger 502 in test (may need to stub Better Auth).
- No id is accepted from the client — you cannot edit another user's profile (self-scoped by session).

Accessibility: `noValidate` form with React-Hook-Form; each control has a `<label>`, required controls set `aria-required`, and the error message renders in a `role="alert"` region for the root error / `FormMessage` for fields. Cancel restores via `router.refresh()`.
i18n: Field labels (`account.fields.*`), the required legend, and validation messages (`validation.required`, `validation.max`) must localize in `uk`/`ja`; no raw keys.

### UAT-ACCOUNT-PREFERENCES — Preferences (locale switch)

- Route: `/app/account/preferences`  ·  Example URL: `/en/app/account/preferences`  ·  Code: `src/app/[locale]/(secure)/app/account/preferences/page.tsx:16`
- Purpose: Edit the caller's **Language**, **Time zone**, **Date format**, and **Number format**. The preferred language is mirrored onto `app_users.preferred_locale`, which drives the request locale — so this is the in-app locale switch (`src/app/api/account/preferences/route.ts:14`).
- Guard / who can access: `requireSecureSession`; `notFound()` if no `appUserId` (`src/app/[locale]/(secure)/app/account/preferences/page.tsx:25`). Write endpoint `PUT /api/account/preferences`, self-scoped (`src/app/api/account/preferences/route.ts:29`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away.
  - Member / Limited Admin / Org Admin / Superadmin: each edits **their own** preferences.
- Preconditions & test data: Sign in as `user5@orga.local`.
- Controls (`_preferences-form.tsx`, validated by `updatePreferencesSchema`, `src/lib/validation/account.ts:23`):
  - **Language** — select of the 8 supported locales (`preferredLocale`, must be supported).
  - **Time zone** — select including **System default** (empty) plus IANA zones from the runtime; validated by the engine (`isValidTimeZone`).
  - **Date format** — one of System default / ISO 8601 / US / European / Long (`DATE_FORMAT_OPTIONS`, `src/lib/account/preferences.ts:15`).
  - **Number format** — **System default** or one of the supported locales.

User stories

- UAT-ACCOUNT-PREFERENCES-S1 — As a Member, I want to change my language in Preferences, so that the app renders in my language.
  - Acceptance criteria: Given I choose a different language and save, then a success line appears and the UI re-renders in that language.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` and open `/en/app/account/preferences`. | Heading **Preferences**; the four selects show current values. |
    | 2 | Change **Language** to **Ukrainian**. | The select shows Ukrainian selected. |
    | 3 | Click **Save changes**. | A success line appears ("Your changes have been saved."); the page refreshes and its labels are now in Ukrainian. |
    | 4 | Navigate to another shell page (e.g. Dashboard). | The UI stays in Ukrainian (the preference drives the request locale). |
    | 5 | Change **Language** back to **English** and save. | The UI returns to English. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-PREFERENCES-S2 — As a Member, I want date/number/time-zone formatting to follow my choices, so that values display the way I expect.
  - Acceptance criteria: Given I pick a date format and time zone, when I save, then the choices persist across reloads.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | On Preferences, set **Date format** to **ISO 8601 (2026-06-13)**. | The select shows ISO 8601. |
    | 2 | Set **Time zone** to a specific zone (e.g. `Europe/Kyiv`) and **Number format** to a specific locale. | Both accept the value. |
    | 3 | Click **Save changes**. | Success line appears. |
    | 4 | Reload the page. | Date format, Time zone, and Number format retain your choices. |
    | 5 | Set **Time zone** back to **System default** and save. | It persists as the system default (stored as no override). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- The four choices are constrained selects, so invalid values are hard to submit via the UI; a tampered body is rejected server-side with 400 → the form shows "Please check the form and try again." (`_preferences-form.tsx:84`).
- An unrecognized time zone returns 400 `invalid_time_zone` (`src/app/api/account/preferences/route.ts:47`).
- **System default** for time zone / number format is stored as NULL (`normalizeOptional`, `src/lib/account/preferences.ts:45`); confirm re-opening shows **System default**, not an empty control.

Accessibility: Selects are native `<select>` with `<label>` via `FormLabel`; the required legend is shown; invalid state uses `aria-invalid` styling. Keyboard: Tab to each select, choose with arrows, submit with Enter.
i18n: Language option labels use `account.locales.*`; date-format labels use `account.dateFormats.*`. This is the locale-switch screen — verify that after switching to `uk`/`ja` there are no raw keys and the option labels themselves localize.

### UAT-ACCOUNT-SECURITY — Security (password + sessions)

- Route: `/app/account/security`  ·  Example URL: `/en/app/account/security`  ·  Code: `src/app/[locale]/(secure)/app/account/security/page.tsx:17`
- Purpose: Self-service security — change password and manage the caller's own active sessions. Both go through Better Auth's client, which is inherently bound to the current session (`src/app/[locale]/(secure)/app/account/security/page.tsx:9`).
- Guard / who can access: `requireSecureSession` (no `appUserId` guard needed — Better Auth is session-scoped). The page enforces the secure boundary then renders the two panels (`src/app/[locale]/(secure)/app/account/security/page.tsx:25`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away.
  - Member / Limited Admin / Org Admin / Superadmin: each manages **their own** password and sessions; there is no way to act on another account.
- Preconditions & test data: Sign in as `user5@orga.local`; to test "sign out other sessions", first sign in on a second browser/device with the same account.
- Password fields (`_password-form.tsx`, validated by `changePasswordSchema`, `src/lib/validation/account.ts:38`): **Current password** (required), **New password** (min 8 / max 128), **Confirm new password** (must match). On success `revokeOtherSessions: true` signs out other devices.

User stories

- UAT-ACCOUNT-SECURITY-S1 — As a Member, I want to change my password, so that I can keep my account secure.
  - Acceptance criteria: Given the correct current password and a valid, matching new password, when I submit, then the password changes, a confirmation appears, and other sessions are signed out.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` and open `/en/app/account/security`. | Heading **Security**; a **Password** section and an **Active sessions** section are shown. |
    | 2 | Enter **Current password** `DevPassword123!`. | Accepted. |
    | 3 | Enter **New password** `NewPassword123!` and **Confirm new password** `NewPassword123!`. | Both accepted. |
    | 4 | Click **Change password**. | A confirmation appears: "Your password has been changed. Other sessions were signed out."; the fields reset. |
    | 5 | (If a second device was signed in) refresh it. | That other session is signed out. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-SECURITY-S2 — As a Member, I want to revoke a stray session, so that I can sign out a device I no longer trust.
  - Acceptance criteria: Given more than one active session, when I sign out others (or revoke one), then the list updates and the revoked session can no longer act.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in with `user5@orga.local` on two browsers. | Two sessions exist. |
    | 2 | On browser one, open Security and read **Active sessions**. | A list of sessions shows each with an expiry, and (if available) IP and Device; a **Sign out other sessions** button is enabled. |
    | 3 | Click **Sign out other sessions**. | The list refreshes; browser two's session is gone. Refreshing browser two shows it signed out. |
    | 4 | (Alternative) click **Revoke** on a single row. | That row disappears after the list refreshes. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Wrong current password → the form shows "Could not change your password. Check your current password." (`account.errors.passwordChangeFailed`, `_password-form.tsx:52`).
- New password shorter than 8 → inline **Password must be at least 8 characters.** (`validation.passwordMin`).
- Confirm not matching New → inline **Passwords do not match.** on the confirm field (`validation.passwordsMismatch`).
- All three password fields show a required asterisk (the unrefined `passwordFieldsSchema` drives the markers; `_password-form.tsx:65`).
- Sessions panel: first render shows two skeleton bars; a load failure shows "Could not load your sessions." in `role="alert"`; a failed revoke shows "Could not revoke the session." (Better Auth returns `{ error }` rather than throwing, so the panel reads `result.error`; `_sessions-panel.tsx:73`).
- **Sign out other sessions** is disabled when only one session exists (`_sessions-panel.tsx:101`).

Accessibility: Password fields are typed `password` with correct `autoComplete` (`current-password` / `new-password`); errors are in alert/`FormMessage` regions. The sessions list is a keyboard-navigable list of buttons; the skeleton conveys loading.
i18n: Section titles (`account.security.*`), the confirmation, and validation messages localize in `uk`/`ja`; the expiry/IP/Device labels come from `account.security.*`; dates use `Intl.DateTimeFormat(locale, …)` (`_sessions-panel.tsx:39`).

### UAT-ACCOUNT-APIKEYS — API keys

- Route: `/app/account/api-keys`  ·  Example URL: `/en/app/account/api-keys`  ·  Code: `src/app/[locale]/(secure)/app/account/api-keys/page.tsx:24`
- Purpose: Self-service management of the caller's **own** API keys — create, rotate, and revoke — through the `/api/v1/me/api-keys` surface, which is inherently self-scoped to the session principal (`src/app/[locale]/(secure)/app/account/api-keys/page.tsx:9`). Secrets are shown exactly once.
- Guard / who can access: `requireSecureSession`. The grantable-scope list is computed from the caller's own authority: all `account.*` scopes are always self-grantable, plus any admin permission the caller happens to hold (`src/app/[locale]/(secure)/app/account/api-keys/page.tsx:33`). The create/rotate/revoke API requires the `account.apikeys.manage` scope for bearer callers; a cookie session passes unconditionally (`src/app/api/v1/me/api-keys/route.ts:54`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away.
  - Member: can create keys carrying `account.*` scopes only (they hold no admin permissions), and manage their own keys.
  - Limited Admin / Org Admin / Superadmin: can additionally grant the admin permissions they personally hold; each still only sees and manages **their own** keys.
- Preconditions & test data: Sign in as `user5@orga.local` (account scopes only) or `orgadmin@orga.local` (also offers admin scopes to grant).
- Create form (`_api-keys-panel.tsx`): **Name** (required, max 120), **Expires in (days)** (optional 1–3650), **Scopes** (checkbox list limited to grantable scopes; the endpoint re-validates via `ungrantableScopesForCaller`). Account scopes are `account.read`, `account.profile.write`, `account.preferences.write`, `account.apikeys.manage` (`src/lib/api-auth/scopes.ts:25`).

User stories

- UAT-ACCOUNT-APIKEYS-S1 — As a Member, I want to create an API key and copy its secret once, so that a script can call the API as me.
  - Acceptance criteria: Given a name (and optionally scopes/expiry), when I create the key, then the plaintext secret is revealed exactly once and the key appears in my list as **Active**.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` and open `/en/app/account/api-keys`. | Heading **API keys**; a **Create a new key** form and **Your API keys** list are shown. |
    | 2 | Enter **Name** `My laptop CLI`. Leave expiry empty. | Accepted. |
    | 3 | In **Scopes**, tick `account.read`. | The checkbox is selected. |
    | 4 | Click **Create key**. | A dialog **Copy your key now** appears with the full secret and a **Copy** button, warning it is shown only once. |
    | 5 | Click **Copy**, then **Done**. | The dialog closes; the new key appears in the list with an **Active** badge, its prefix (`…`), the `account.read` scope, and Created / Last used (**Never**) / Expires (**No expiry**). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-APIKEYS-S2 — As a Member, I want to rotate and then revoke a key, so that I can replace a leaked secret and later retire it.
  - Acceptance criteria: Given an active key, when I rotate it, then a new secret is revealed once and the key stays active; when I revoke it (confirming the dialog), then it becomes **Revoked** and loses its action buttons.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | On an existing active key, click **Rotate**. | A confirmation dialog **Rotate API key** appears naming the key. |
    | 2 | Confirm. | A **Copy your key now** dialog reveals a NEW secret (same scopes/expiry); the key remains **Active**. |
    | 3 | Click **Revoke** on that key. | A destructive confirmation **Revoke API key** appears naming the key. |
    | 4 | Confirm. | The key's badge changes to **Revoked**; the **Rotate** and **Revoke** buttons disappear for that row. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-APIKEYS-S3 — As a Member, I want to be stopped from granting scopes I do not hold, so that a key can never exceed my own permissions.
  - Acceptance criteria: Given I attempt to submit a scope outside my authority, when I create the key, then the server rejects it and names the ungrantable scopes.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` (no admin permissions). | Only `account.*` scopes appear in the Scopes list. |
    | 2 | Confirm no `admin.*` scope is offered in the checkbox list. | The picker itself omits scopes you cannot grant. |
    | 3 | `TODO: verify` (developer path) submit a POST to `/api/v1/me/api-keys` with an `admin.users.read` scope. | The API responds 403 and the form shows "You can't grant these scopes: admin.users.read" (`account.apiKeys.create.invalidScope`, `src/app/api/v1/me/api-keys/route.ts:85`). |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Out-of-scope access: revoking/rotating a key that is not yours returns **404, not 403** (so other users' key ids are not leaked; `src/app/api/v1/me/api-keys/[id]/route.ts:44`). A non-UUID id returns 400.
- Empty name → the form blocks submit with "Enter a name." (`_api-keys-panel.tsx:276`).
- Empty list → **You don't have any API keys yet.** First load shows two skeleton bars.
- Load / create / rotate / revoke failures each show their localized error in `role="alert"` (`loadError` / `create.error` / `rotateError` / `revokeError`).
- Rotating a non-active key returns 409 "Key is not active and cannot be rotated." (`src/app/api/v1/me/api-keys/[id]/rotate/route.ts:51`); the panel only offers Rotate on active keys, so this is an edge/tamper case.
- Rate limit: create / rotate / revoke share a per-principal token bucket; exceeding it returns 429 with `Retry-After` (`src/app/api/v1/me/api-keys/route.ts:64`). `TODO: verify` the exact UI message on a client-side 429 (the panel maps non-OK create to the generic `create.error`).

Accessibility: The create form has labelled inputs and a `<fieldset>`/`<legend>` for scopes; the reveal and confirm dialogs are managed by the dialog manager (focus-trap + Esc — `TODO: verify` Esc closes each). Status is a labelled badge, not color alone.
i18n: All labels/messages are under `account.apiKeys.*`; run in `uk`/`ja` and confirm the create form, list metadata (Created/Last used/Expires, Never/No expiry), status badges, and both dialogs localize; dates use `Intl.DateTimeFormat(locale, …)`.

---

## Documentation viewer

The in-app docs viewer renders the same Markdown under `docs/` that this file lives in, filtered by visibility. It is frontmatter-driven: a document's `visibility`, `group`, `order`, and optional `requires` come from its YAML frontmatter, and the catalog is assembled and visibility-filtered server-side (`src/lib/docs/catalog.server.ts`).

Key visibility rule (`filterCatalogForViewer`, `src/lib/docs/catalog.server.ts:35`): a doc marked `visibility: internal` is dropped unless the server env `DOCS_INTERNAL_VISIBLE` is truthy (default false; `src/lib/env.ts:176`); a doc with `requires` is dropped unless the viewer holds **all** listed permission keys. The same filter powers both the landing catalog and the per-article guard, so a hidden doc never appears and 404s if its URL is guessed.

> Note for testers: because these UAT files are themselves `visibility: internal`, they are hidden in the viewer unless `DOCS_INTERNAL_VISIBLE=true` is set for the server. Use a public doc (e.g. the architecture guide) for the visible-catalog stories, and set `DOCS_INTERNAL_VISIBLE=true` only to exercise the internal-visibility path.

### UAT-ACCOUNT-DOCS-LANDING — Documentation landing

- Route: `/app/docs`  ·  Example URL: `/en/app/docs`  ·  Code: `src/app/[locale]/(secure)/app/docs/page.tsx:19`
- Purpose: The documentation landing — the catalog the caller may see, grouped, with each entry linking into its article. Read-only; visibility is enforced server-side by `getVisibleGroupedCatalog` (the same filter that builds the sidebar), so a doc the caller cannot see never appears (`src/app/[locale]/(secure)/app/docs/page.tsx:10`).
- Guard / who can access: `requireSecureSession(locale, "/{locale}/app/docs")`. The catalog is then filtered by `access.permissions` and the `DOCS_INTERNAL_VISIBLE` flag (`src/app/[locale]/(secure)/app/docs/page.tsx:24`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away — cannot see. (Note: a separate PUBLIC `/docs` exists outside the shell; that is covered in the public/auth UAT set.)
  - Member: sees all non-internal docs that have no unmet `requires`.
  - Limited Admin / Org Admin / Superadmin: additionally see docs whose `requires` keys they hold (more admin-oriented docs appear as permissions increase).
- Preconditions & test data: Sign in as `user5@orga.local` (baseline visible set) and `orgadmin@orga.local` (broader set) to compare. To see internal docs, set `DOCS_INTERNAL_VISIBLE=true`.

User stories

- UAT-ACCOUNT-DOCS-LANDING-S1 — As a Member, I want to browse the documentation catalog, so that I can find guidance for the platform.
  - Acceptance criteria: Given documents are available to me, when I open the docs landing, then I see them grouped by section as clickable cards, and clicking one opens the article.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` and open `/en/app/docs`. | Heading **Documentation** with the description "Browse guides and reference material for the platform." |
    | 2 | Read the page. | Documents appear grouped under uppercase section headings; each is a card showing a title and (if present) a description. |
    | 3 | Click a document card. | You navigate to `/en/app/docs/<slug>` and the article renders. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-DOCS-LANDING-S2 — As a Member, I want internal/maintainer docs hidden from me, so that the catalog only shows what I'm meant to read.
  - Acceptance criteria: Given `DOCS_INTERNAL_VISIBLE` is false, when I open the landing, then no `visibility: internal` document (e.g. the UAT set) is listed.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Ensure the server runs with `DOCS_INTERNAL_VISIBLE` unset/false. | Default configuration. |
    | 2 | Sign in as `user5@orga.local` and open `/en/app/docs`. | The catalog does NOT list any internal doc (no "UAT —" cards, no QA-group internal docs). |
    | 3 | Compare with `orgadmin@orga.local`. | The admin may see additional docs that carry `requires` keys they hold, but still no `internal` docs while the flag is off. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Empty catalog (nothing visible to this viewer) → the page shows **No documents are available to you yet.** (`docs.emptyCatalog`, `src/app/[locale]/(secure)/app/docs/page.tsx:35`).
- `requires`-gated doc: a Member does not see a doc that requires an admin permission; the same doc appears for an admin who holds that key. Verify by comparing `user5@` vs `orgadmin@`.
- No loading skeleton (server-rendered); no inline error surface on the landing.

Accessibility: Each card is a focusable link with a visible focus ring (`focus-visible:ring-2`, `src/app/[locale]/(secure)/app/docs/page.tsx:48`); group headings are `<h2>`. Keyboard users can Tab card-to-card and activate with Enter.
i18n: The landing title/description use `docs.index.*`; the empty line uses `docs.emptyCatalog`. Document titles/descriptions come from each file's frontmatter and are not translated per-locale — `TODO: verify` whether the catalog is localized or always English (the catalog cache is permission-keyed, not locale-keyed; `src/lib/docs/catalog.server.ts:77`). Run in `uk`/`ja` and confirm the page chrome localizes even if doc titles remain in their source language.

### UAT-ACCOUNT-DOCS-ARTICLE — Documentation article

- Route: `/app/docs/[...slug]`  ·  Example URL: `/en/app/docs/architecture`  ·  Code: `src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:27`
- Purpose: Renders a single document: breadcrumbs, the sanitized article body, an "On this page" table of contents, and a "Last updated" line. The body is rendered server-side through the sanitizing pipeline; document JavaScript is never evaluated (`src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:26`).
- Guard / who can access: Layered — (1) `requireSecureSession`; (2) `canViewDoc(slug, access.permissions)` → `notFound()` if the doc is hidden (internal-with-flag-off, or unmet `requires`), so a hidden doc 404s even if its URL is known; (3) the slug resolves through a path-safe resolver, and a traversal/missing slug returns null → `notFound()` (`src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:34`).
- Access matrix:
  - Visitor / Pending / Blocked: redirected away.
  - Member: can open any doc `canViewDoc` allows (non-internal, no unmet `requires`); a hidden/unknown slug → 404.
  - Limited Admin / Org Admin / Superadmin: can additionally open docs whose `requires` keys they hold.
- Preconditions & test data: Know a visible slug (e.g. `architecture`). For the hidden-doc 404, use an internal doc's slug while `DOCS_INTERNAL_VISIBLE` is false.

User stories

- UAT-ACCOUNT-DOCS-ARTICLE-S1 — As a Member, I want to read a document with a table of contents, so that I can navigate a long article.
  - Acceptance criteria: Given a visible slug, when I open the article, then I see breadcrumbs, the rendered body, an on-this-page list, and (if the doc has a date) a "Last updated" line.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user5@orga.local` and open `/en/app/docs`. | The catalog lists visible docs. |
    | 2 | Click a document (e.g. the architecture guide). | The article opens at `/en/app/docs/<slug>`. |
    | 3 | Read the top of the page. | Breadcrumbs show the Documentation home, the doc's group, and its title. |
    | 4 | Look to the right (wide screen). | An **On this page** list links to the article's headings. |
    | 5 | Scroll to the end. | A **Last updated …** line appears if the doc has an updated date. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-ACCOUNT-DOCS-ARTICLE-S2 — As a Member, I want a hidden or unknown document to 404, so that guessing a URL never leaks a maintainer-only doc.
  - Acceptance criteria: Given a slug I may not view (internal with the flag off, or a `requires` I lack, or a non-existent slug), when I open it, then I get Not Found — never Forbidden and never the content.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | With `DOCS_INTERNAL_VISIBLE` false, sign in as `user5@orga.local`. | Internal docs are hidden. |
    | 2 | Open the URL of an internal doc directly, e.g. `/en/app/docs/uat/account`. | You get a **Not Found** (404) page — not a 403, and not the document. |
    | 3 | Open a made-up slug, e.g. `/en/app/docs/does-not-exist`. | You get **Not Found** (404). |
    | 4 | Try a path-traversal slug, e.g. `/en/app/docs/../secret`. | You get **Not Found** (404); no file outside the docs root is served. |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases
- Out-of-scope / hidden doc → **404, not 403** (existence is never leaked; `src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:38`).
- Traversal/missing slug → 404 via the path-safe resolver (`src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:40`).
- A doc with no headings shows an empty/absent table of contents; a doc with no updated date omits the "Last updated" line.
- Rendered HTML is sanitized — embedded scripts do not execute. `TODO: verify` a fixture doc containing a `<script>` renders inert (relates to the Mermaid/DOMPurify handling noted in project memory).

Accessibility: Breadcrumbs are a labelled navigation; the ToC is a list of in-page anchors with visible focus; headings give the article a logical outline. `TODO: verify` no axe violations on a representative article (tables/code blocks/diagrams).
i18n: Page chrome (breadcrumb home `docs.breadcrumbHome`, "On this page" `docs.onThisPage`, "Last updated {date}" `docs.lastUpdated`) localizes; the updated date uses `Intl.DateTimeFormat(locale, { dateStyle: "long" })` (`src/app/[locale]/(secure)/app/docs/[...slug]/page.tsx:51`). Document body text is the source-language Markdown — same `TODO: verify` on per-locale content as the landing.

---

## Coverage matrix (screens × personas)

Legend: **See** = can load the screen; **Act** = has a meaningful action (edit/create/revoke). "—" = redirected away by the guard. "R/O" = read-only (no action on the screen).

| Screen | Visitor | Pending | Member | Limited Admin | Org Admin | Superadmin |
|---|---|---|---|---|---|---|
| `/app` (entry) | — (→ sign-in) | — (→ pending) | See (→ dashboard) | See | See | See |
| `/app/dashboard` | — | — | See (R/O) | See | See | See |
| `/app/workspace` | — | — | See (R/O) | See | See | See |
| `/app/account` (overview) | — | — | See (R/O, own) | See | See | See |
| `/app/account/profile` | — | — | See + Act (own) | Act | Act | Act |
| `/app/account/preferences` | — | — | See + Act (own) | Act | Act | Act |
| `/app/account/security` | — | — | See + Act (own) | Act | Act | Act |
| `/app/account/api-keys` | — | — | See + Act (account scopes) | Act (+own admin scopes) | Act (+own admin scopes) | Act (+all held scopes) |
| `/app/docs` (landing) | — | — | See (visible set) | See (broader) | See (broader) | See (broadest) |
| `/app/docs/[...slug]` | — | — | See visible / 404 hidden | See broader | See broader | See broadest |

## Coverage checklist

- [x] `/app` — happy (redirect) + negative (unauth) — 2 stories.
- [x] `/app/dashboard` — happy + negative — 2 stories.
- [x] `/app/workspace` — happy + negative — 2 stories.
- [x] `/app/account` — happy + empty-state — 2 stories.
- [x] `/app/account/profile` — happy + required-field negative — 2 stories.
- [x] `/app/account/preferences` — locale-switch happy + formatting persistence — 2 stories (locale switch noted).
- [x] `/app/account/security` — password change + session revoke — 2 stories.
- [x] `/app/account/api-keys` — create + rotate/revoke + scope-escalation negative — 3 stories.
- [x] `/app/docs` — browse + internal-hidden — 2 stories.
- [x] `/app/docs/[...slug]` — read article + 404-not-403 for hidden/unknown/traversal — 2 stories.
- [x] Every gated screen has a persona who can and one who cannot (unauth → redirect; API-key `[id]` → 404-not-403; hidden doc → 404-not-403).
- [x] Empty / loading / error states covered (overview empty, sessions skeleton/error, api-keys skeleton/empty/errors, docs empty catalog).
- [x] Required-field validation covered (profile Name; password fields; api-key Name).
- [x] a11y + i18n notes on every screen.

## TODO: verify list

- `TODO: verify` how an unknown top-level locale segment (`/qq/app`) is handled by the locale router before the redirect page runs.
- `TODO: verify` a UI-reachable way to trigger the profile 502 (Better Auth name-update failure).
- `TODO: verify` the exact client-side message shown when an API-key create/rotate/revoke hits the 429 rate limit (the panel maps non-OK create to the generic `create.error`).
- `TODO: verify` the API-key reveal and confirm dialogs trap focus and close on Esc.
- `TODO: verify` whether the docs catalog/titles are localized per-locale or always render in the document's source language (catalog cache is permission-keyed, not locale-keyed).
- `TODO: verify` a fixture doc containing a `<script>` renders inert through the sanitizing pipeline; and no axe violations on a representative article.
- `TODO: verify` the two hardcoded English strings (dashboard welcome line, workspace description) are intended to remain non-localized.
