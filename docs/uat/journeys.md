---
title: "UAT — End-to-end journeys"
description: Cross-cutting, multi-screen UAT journeys a real tester walks end to end, each with one combined numbered script validated against the code.
group: QA
visibility: internal
order: 80
---

# UAT End-to-end journeys

This file covers the **cross-cutting journeys** — the multi-screen flows a real tester walks from start to finish. Each journey is one story with a single **combined, numbered UAT script** (each step is an action plus its expected result), its preconditions and personas, and a Pass/Fail row. Per-screen stories live in the sibling area files under `docs/uat/`.

Every assertion below was checked against the code; the relevant `file:line` is cited inline. Where a claim could not be fully verified, it is marked `TODO: verify`.

## Test environment and accounts

- **Seed the personas** with `pnpm db:seed:dev` (the `dev_init` fixture — `src/db/seeds/dev-init.ts`). It provisions three orgs (`org-a`, `org-b`, `org-c`), each with a superuser, an org admin and five members, plus two groups in ORG A. Every seeded account is created **pre-approved** (`active`) — `src/db/seeds/dev-init.ts:32-34`.
- **Base URL:** `http://localhost:3000`. Sign in at `/en/sign-in` (`src/db/seeds/dev-init.ts:737`).
- **Shared password:** `DevPassword123!` (override with `DEV_SEED_PASSWORD`) — `src/db/seeds/dev-init.ts:52-53`.
- **Locale to test:** run each journey in `en` and repeat the localized steps in one non-Latin locale — `uk`, `zh`, `hi` or `ja` (`src/config/i18n-config.ts:10`).
- **Reset:** the seed is idempotent (re-run to reconcile); to start clean, reset the database (`pnpm db:reset` / the provisioning scripts under `src/db/`) then re-seed.

### Personas and seed credentials

| Persona | Seed account (ORG A) | Role / marker | Access |
| --- | --- | --- | --- |
| **Visitor** | (none — signed out) | unauthenticated | public pages, sign-in / sign-up |
| **Pending user** | a freshly self-signed-up account | `pending_approval` | only the pending-approval screen |
| **Member** | `user3@orga.local` | `member` (`shell.view`) | secure-shell self-service only |
| **Limited Admin** | `user1@orga.local` | `admin` role via the **Engineering** group | `admin.users.read` + `.manage`, `admin.audit.read` only |
| **Org Admin** | `orgadmin@orga.local` | `admin.platform` (no marker) | full `admin.*` **within ORG A** |
| **Superadmin** | `superuser@orga.local` | `superuser` marker | every org; the only persona that can create orgs |
| **Impersonator** | any admin, impersonating a target | acts as the target | "Stop" returns to the admin |
| **Machine client** | an API key minted by any user | Bearer `drk_…` key | the `/api/v1` surface |

The `admin` role granted to the Limited Admin holds exactly `shell.view`, `admin.users.read`, `admin.users.manage`, `admin.audit.read` — `src/db/seeds/dev-init.ts:246-250`. This is deliberate: the `*.read` key is what lets the page open, and `*.manage` is what lets the action run.

## How access is enforced (shared background)

- `src/proxy.ts` only redirects a request with **no session cookie** to `/sign-in` (`src/proxy.ts:103-113`); it is explicitly **not** the authorization boundary.
- The real gate is `requireSecureSession` (`src/lib/auth-guard.ts:55-76`): it resolves the user's access context and calls `decideSecureAccess(status, membershipStatus)` (`src/lib/auth-status.ts:66-77`) — a `pending_approval` decision redirects to `/pending-approval`, a `blocked` decision to `/blocked`.
- A user's effective permissions in their active org are `direct roles ∪ group-conferred roles`, deduped by a SQL `UNION` (`src/lib/auth-status.ts:185-202`); the `superuser` marker then expands to the full permission set (`src/lib/auth-status.ts:218-221`).
- Admin screens gate on a specific key via `checkAdminPermissionServer(...)`; a denial returns **404 Not Found**, never 403, so a foreign resource's existence is never leaked (e.g. `src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:35-38`; `canAccessOrg` → `not_found` at `src/app/api/administrator/organizations/[id]/members/route.ts:52-56`).
- The admin nav only surfaces links whose required key the user holds (`ADMINISTRATOR_NAV_GROUPS` in `src/app/[locale]/(secure)/app/administrator/_components/administrator-navigation.ts`), and every nav key matches its destination page guard (verified per link in Journey 2).

---

## UAT-JOURNEY-1 — Onboarding: sign-up to first dashboard

- **Screens:** `/sign-up` to `/pending-approval` to (admin) Users list to (member) `/sign-in` to `/app/dashboard`.
- **Personas:** a new **Visitor**/**Pending user**, then an **Org Admin** (`orgadmin@orga.local`) to approve.
- **Preconditions:** app running and seeded; you can receive or invent a fresh email such as `newhire@example.com`; the Org Admin is signed in in a second browser/profile.
- **Code:** sign-up form `src/components/auth/email-password-sign-up-form.tsx:43-48`; new users become `pending_approval` at `src/lib/user-provisioning.server.ts:134`; pending redirect `src/lib/auth-guard.ts:67-69`; approve action `src/lib/admin/user-actions.server.ts:84-88` (event `admin.user.approved`) requiring `admin.users.manage` (`src/lib/admin/user-actions.server.ts:404-405`); `/app` redirects to `/app/dashboard` (`src/app/[locale]/(secure)/app/page.tsx:8`).

**Note (approve is a Users-list bulk action):** approval is performed from the **Users list** by selecting the pending row and choosing **Approve** (`src/app/[locale]/(secure)/app/administrator/users/_users-grid.tsx:195-200` → `POST /api/administrator/users/bulk`). The user **detail** page shows only a read-only status badge — there is no per-user approve button there (`src/app/[locale]/(secure)/app/administrator/users/[userId]/page.tsx:100-117`).

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As the Visitor, open `/en/sign-up`. | The sign-up form shows **Name**, **Email** and **Password** fields, each with a required marker. |
| 2 | Enter a name, `newhire@example.com`, a strong password, then submit. | The account is created and the browser lands on `/en/pending-approval`. |
| 3 | Read the pending-approval screen. | It shows a "waiting for approval" title and description and a sign-out control; no app navigation is available. |
| 4 | In the address bar, try to open `/en/app/dashboard`. | You are redirected straight back to `/en/pending-approval` (the guard blocks a pending user). |
| 5 | Switch to the **Org Admin** browser. Open the Administrator area, then **Users**. | The users grid lists members of ORG A, including `newhire@example.com` with a **Pending approval** status badge. |
| 6 | Select the `newhire@example.com` row and choose **Approve**. | A success toast appears and the row's status badge changes to **Active**. |
| 7 | Back in the Visitor browser, sign out (if still on the pending screen), then sign in at `/en/sign-in` as `newhire@example.com`. | Sign-in succeeds. |
| 8 | Observe the landing page. | The browser lands on `/en/app/dashboard` and the dashboard renders (welcome + charts area). |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-2 — Grant access via a group (the link must OPEN, not 404)

- **Screens:** (admin) Groups → New → Group detail (Roles tab, Members tab) → then the **target member** signs in and the newly conferred admin nav link **opens**.
- **Personas:** **Org Admin** (`orgadmin@orga.local`) sets it up; **Member** `user5@orga.local` is the target (pick a member NOT already in a role-bearing group).
- **Preconditions:** app seeded; both accounts available; the target starts with no admin access.
- **Code:** create-group guard `admin.groups.create` (`src/app/[locale]/(secure)/app/administrator/groups/new/page.tsx:18`), form fields `key`/`name`/`description` (`.../groups/new/_new-group-form.tsx`); add-role and add-member both require `admin.groups.assign` (`src/app/api/administrator/groups/[id]/roles/route.ts:80`; `src/app/api/administrator/groups/[id]/members/route.ts:106`); effective-permission UNION `src/lib/auth-status.ts:185-202`.

**The explicit assertion this journey exists to catch:** a nav link's required key must equal its destination page guard, or the link 404s. Verified pairs (nav key = page guard):

- Users: nav `admin.users.read` (`administrator-navigation.ts:62-67`) = page guard `admin.users.read` (`users/page.tsx:29`).
- Roles: nav `admin.roles.read` = page guard `admin.roles.read` (`roles/page.tsx:28`).
- Groups: nav `admin.groups.read` = page guard `admin.groups.read` (`groups/page.tsx:24`).
- Audit: nav `admin.audit.read` = page guard `admin.audit.read` (`audit/page.tsx:25`).

So bundle a role whose permissions include a `*.read` key (the **Administrator** role includes `admin.users.read` — `src/db/seeds/dev-init.ts:249`) and assert the **Users** link both appears and opens for the target.

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As the Org Admin, open Administrator → **Groups** → **New group**. | The new-group form shows **Key**, **Name** and **Description** fields. |
| 2 | Enter key `uat-access`, name `UAT Access`, a description, then submit. | The group is created and you land on its detail page. |
| 3 | On the group detail, open the **Roles** tab and add the **Administrator** role. | The Administrator role is listed as conferred by this group. |
| 4 | Open the **Members** tab and add `user5@orga.local`. | `user5@orga.local` appears in the group's member list. |
| 5 | In a second browser, sign in at `/en/sign-in` as `user5@orga.local`. | Sign-in succeeds and the dashboard loads. |
| 6 | Look at the left navigation. | An **Administrator** entry and a **Users** link are now visible (they were absent before the group grant). |
| 7 | Click the **Users** link. | **The page OPENS — it does NOT 404.** The users grid renders (the conferred `admin.users.read` matches the page guard). |
| 8 | Back as the Org Admin, remove `user5@orga.local` from the group (Members tab), then have `user5` reload. | After reload, the **Users** link disappears and visiting `/en/app/administrator/users` returns Not Found. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-3 — Direct role assignment on the User → Roles tab

- **Screens:** (admin) Users → user detail → **Roles** tab (assign, then remove) → confirm the effective permission changed.
- **Personas:** **Org Admin** (`orgadmin@orga.local`) with `admin.roles.assign`; target **Member** `user4@orga.local`.
- **Preconditions:** app seeded; the target holds only `member` initially.
- **Code:** Roles tab panel `src/app/[locale]/(secure)/app/administrator/users/[userId]/_user-roles-panel.tsx`; assign/remove call `POST` / `DELETE /api/administrator/users/{userId}/app-roles` requiring `admin.roles.assign` (`src/app/api/administrator/users/[id]/app-roles/route.ts:92`); the assign control is gated on `canAssignRoles` (`users/[userId]/page.tsx:121`).

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As the Org Admin, open Administrator → **Users** and click `user4@orga.local`. | The user detail page opens showing the current status badge and detail tabs. |
| 2 | Open the **Roles** tab. | The tab lists the user's directly-assigned roles (initially just **Member**) and an **Assign role** control. |
| 3 | Assign the **Administrator** role via the role picker. | A success toast appears and **Administrator** now appears in the user's role list. |
| 4 | In a second browser, sign in as `user4@orga.local` and check the left nav. | The **Administrator** / **Users** links are now visible (the assigned role confers `admin.users.read`). |
| 5 | Back as the Org Admin, on the same Roles tab, remove the **Administrator** role and confirm the prompt. | The role is removed from the list. |
| 6 | Have `user4` reload the app. | The admin nav links disappear again, confirming the effective permission set changed with the direct assignment. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-4 — Impersonation: impersonate, act, then Stop returns to admin

- **Screens:** (admin) Users → user detail (**Impersonate**) → act as the target across the shell → **Stop impersonating** banner → back in the admin's own session.
- **Personas:** **Superadmin** (`superuser@orga.local`) as the impersonator (a superadmin can impersonate anyone without the escalation guard tripping); target **Member** `user2@orga.local`.
- **Preconditions:** app seeded; the impersonator holds `admin.users.impersonate`.
- **Code:** Impersonate button renders only when the caller holds `admin.users.impersonate` (`.../users/[userId]/_impersonate-button.tsx`) and `POST /api/administrator/users/[id]/impersonate` re-checks it (`src/app/api/administrator/users/[id]/impersonate/route.ts:46`); the **Stop** authority is deliberately NOT a permission check — it derives from the session being an impersonation session via `getImpersonatorId` reading `session.impersonatedBy` (`src/lib/auth-guard.ts:31-41`; DELETE handler note at `.../impersonate/route.ts:126-137`); the banner renders in the secure layout (`src/app/[locale]/(secure)/layout.tsx:99`) and its Stop button hard-reloads to `/{locale}/app/dashboard` on success (`src/components/admin/impersonation-banner-client.tsx:52-58`).

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As the Superadmin, open Administrator → **Users** and click `user2@orga.local`. | The user detail page shows an **Impersonate** button next to the status badge. |
| 2 | Click **Impersonate**, tick the acknowledgement, and confirm. | The app hard-reloads into the secure shell (`/en/app/dashboard`) as `user2@orga.local`. |
| 3 | Observe the top of the shell. | An impersonation banner is shown naming the impersonated account, with a **Stop impersonating** button. |
| 4 | Open the left nav and try an admin-only screen (e.g. `/en/app/administrator/users`). | It returns Not Found — you now hold only the target member's permissions, not the admin's. |
| 5 | Open **Account → Profile** or the dashboard. | Content renders as the target user (self-service is available to the member). |
| 6 | Click **Stop impersonating**. | The session is restored to the Superadmin and the browser reloads to `/en/app/dashboard` (the secure shell, not the public landing). |
| 7 | Open Administrator → **Users** again. | The users grid opens normally — you are back to full admin access. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-5 — SSO handoff: launch from the hub, consume at `/sso/confirm`

- **Screens:** shell **Applications** switcher (the hub) → `GET /api/sso/launch` redirect → satellite `/sso/confirm` interstitial → explicit continue → signed in on the satellite.
- **Personas:** any signed-in **Member** or admin with an active membership.
- **Preconditions:** app seeded (the three placeholder enterprise apps exist — `src/db/seeds/seed-local.ts:133-164`); the SSO handoff env is configured. To exercise the full cross-subdomain hop you need a satellite origin that also runs this kit and shares the handoff secret — `SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID` (`src/app/[locale]/(auth)/sso/confirm/page.tsx:25-27`, `src/lib/jwt-handoff.server.ts:68`). `TODO: verify` the satellite/env is provisioned in your test setup; without it, step 3 shows the invalid-token screen.
- **Code:** the hub is the **Applications** sheet in the top shell bar, rendering each app as an anchor to its `ssoLaunchUrl` = `/api/sso/launch?...` (`src/components/app-shell/application-switcher-sheet.tsx:31-33,135-140`); launch mints a short-lived one-time HS256 JWT and redirects to the target's `/api/sso/consume?token=…` (`src/app/api/sso/launch/route.ts:45-63`, `src/lib/sso.server.ts`); the consume GET verifies the token and redirects to `/sso/confirm`, which re-verifies the token to show the account and requires a same-origin POST back to `/api/sso/consume` (`src/app/[locale]/(auth)/sso/confirm/page.tsx:8-22,78-90`).

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | Sign in on the hub, then click **Applications** in the top bar. | A sheet opens listing the enterprise applications (Portal, Analytics, Documentation). |
| 2 | Click one application entry. | The browser is redirected through `/api/sso/launch` to the satellite's consume endpoint (no token is exposed in any JSON response). |
| 3 | Wait for the satellite's confirmation page at `/{locale}/sso/confirm`. | An interstitial shows the account email you are about to sign in as (re-derived from the signed token, not a query param) and a **Continue** button. |
| 4 | Click **Continue**. | The same-origin POST to `/api/sso/consume` is accepted, the one-time token is burned, and you land signed in on the satellite. |
| 5 | Reload `/{locale}/sso/confirm` in place (re-using the same token). | It shows the invalid/expired screen with a link back to sign-in — the token is single-use. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-6 — API-key lifecycle: create, call, rotate, revoke, rejected

- **Screens:** Account → **API keys** (create) → an external HTTP client calling `/api/v1/me` → rotate → revoke → confirm rejection.
- **Personas:** any signed-in user as the key owner; a **Machine client** using the key (use curl or any HTTP tool).
- **Preconditions:** app seeded; you can run an HTTP client against `http://localhost:3000`.
- **Code:** account keys screen `src/app/[locale]/(secure)/app/account/api-keys/_api-keys-panel.tsx`; create `POST /api/v1/me/api-keys` returns the secret **once** (`src/app/api/v1/me/api-keys/route.ts:124`); `GET /api/v1/me` authenticates a Bearer key (`src/app/api/v1/me/route.ts`; Bearer `drk_…` resolution `src/lib/api-auth/resolve-caller.server.ts:20,74`); key format `drk_<env>_<random>` (`src/lib/api-auth/api-key.ts:8-9,59`); rotate `POST /api/v1/me/api-keys/[id]/rotate` returns a new secret and sets the old key `revoked_reason = "rotated"` atomically (`src/lib/api-auth/api-keys.server.ts:177-206`); revoke `DELETE /api/v1/me/api-keys/[id]`; verification returns `null` for a non-active or expired key → `401` (`src/lib/api-auth/api-keys.server.ts:223-250`).

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | Sign in, open **Account → API keys**, and create a key (give it a name; leave scopes at the account default). | The key is created and its full secret (`drk_...`) is shown **exactly once**, with a warning to copy it now. Copy it. |
| 2 | From a terminal, call `GET /api/v1/me` with header `Authorization: Bearer <the-secret>`. | HTTP 200 with a JSON body describing the caller (identity, granted/effective scopes, preferred locale). |
| 3 | Back on the API-keys screen, choose **Rotate** on that key and confirm. | A new secret is shown once; the key's display prefix updates. Copy the new secret. |
| 4 | Repeat the `GET /api/v1/me` call using the **new** secret. | HTTP 200 — the rotated key works. |
| 5 | Repeat the `GET /api/v1/me` call using the **old** (pre-rotation) secret. | HTTP 401 Unauthorized — the old secret was revoked by the rotation. |
| 6 | On the API-keys screen, **Revoke** the key and confirm. | The key's status shows **Revoked** (or it is removed from the active list). |
| 7 | Call `GET /api/v1/me` once more with the (now revoked) current secret. | HTTP 401 Unauthorized — a revoked key is rejected. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-7 — Password reset: forgot, outbox email, reset, sign-in

- **Screens:** `/forgot-password` → (admin) Email **outbox** to read the reset link → `/reset-password` → `/sign-in`.
- **Personas:** a **Member** (`user3@orga.local`) resetting; an **Org Admin** (or Superadmin) to read the outbox in a dev environment with no mail provider.
- **Preconditions:** app seeded; no external mail provider configured (so the email is recorded as `logged` in the outbox and its reset URL is readable there).
- **Code:** forgot-password form calls `authClient.requestPasswordReset` (`src/components/auth/forgot-password-form.tsx:45`, anti-enumeration: always reports success); `sendResetPassword` sends the `password_reset` template through the outbox pipeline (`src/lib/auth.ts:83-91`); every email is written to `app_outbox` before any delivery attempt (`src/lib/email/send.server.ts:138-157`); reset-password reads the token from the `?token=` query param and calls `authClient.resetPassword` (`src/app/[locale]/(auth)/reset-password/page.tsx:48`, `src/components/auth/reset-password-form.tsx:52-55`); outbox view guard `admin.email.read` (`src/app/[locale]/(secure)/app/administrator/email/page.tsx:26`).

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | Open `/en/forgot-password`, enter `user3@orga.local`, and submit. | A neutral confirmation appears ("if the account exists, a reset link was sent") — the same message regardless of whether the email exists. |
| 2 | As the Org Admin (in another browser), open Administrator → **Email**. | The outbox grid lists a recent row with template `password_reset` addressed to `user3@orga.local`, status **logged** (no provider configured). |
| 3 | Open that outbox row's detail and locate the reset URL in the rendered body. | The detail sheet shows the rendered subject and body containing a `/reset-password?token=...` link. Copy that URL. |
| 4 | Open the copied reset URL in the Member's browser. | The reset-password form loads with **New password** and **Confirm password** fields (a valid token was accepted). |
| 5 | Enter a new password in both fields and submit. | A success confirmation appears with a link to sign in. |
| 6 | Go to `/en/sign-in` and sign in as `user3@orga.local` with the **new** password. | Sign-in succeeds and the dashboard loads. |
| 7 | Reopen the same reset URL from step 3. | It shows an invalid/expired-token message — the reset token is single-use. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-8 — Org lifecycle as Superadmin: create, add members, assign roles, scope

- **Screens:** (superadmin) Organizations → New → New user (into the new org) → User → **Roles** tab → then an Org Admin of the new org signs in and sees only it.
- **Personas:** **Superadmin** (`superuser@orga.local`) — the only persona that can create an org; then the org admin you promote inside the new org.
- **Preconditions:** app seeded; the Superadmin is signed in.
- **Code:** create-org guard `admin.orgs.create` on the page (`src/app/[locale]/(secure)/app/administrator/organizations/new/page.tsx:20`) and an explicit `isSuperadmin` gate in the API — a non-superadmin gets 403 (`src/app/api/administrator/organizations/route.ts:147-151`); create-org fields `slug`/`name`/`isDefault` (`.../organizations/new/_new-organization-form.tsx:36-38`); new user is created into a chosen org via `admin.users.create` (`src/app/[locale]/(secure)/app/administrator/users/new/page.tsx:23`, `POST /api/administrator/users`); direct role assignment on the User → Roles tab requires `admin.roles.assign` (`src/app/api/administrator/users/[id]/app-roles/route.ts:92`); org-scoping — an org admin (no marker) is confined to their org by `canAccessOrg` / `canAccessUser`, superadmin bypasses (`src/lib/admin/access-scope.server.ts:37-40,65-70,96-100`).

**Note (adding members to an org):** the org **detail → Members** tab currently exposes remove (`DELETE .../members`) in its grid (`.../organizations/[orgId]/_organization-members-grid.tsx:57-61`). Adding a member is done either by creating the user into that org via **New user**, or via `POST /api/administrator/organizations/:id/members` (guard `admin.orgs.update`, body `{ appUserId, status }` — `src/app/api/administrator/organizations/[id]/members/route.ts:104-124`). `TODO: verify` whether the Members tab renders an explicit **Add member** button in the UI, or whether add is New-user-only from the console.

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As the Superadmin, open Administrator → **Organizations** → **New organization**. | The form shows **Slug**, **Name** and a **default** toggle. |
| 2 | Enter slug `uat-org`, name `UAT Org`, leave default off, and submit. | The org is created and appears in the organizations list. |
| 3 | Open Administrator → **Users** → **New user**; create `uatadmin@uat-org.local`, selecting **UAT Org** as the organization. | The user is created with an active membership in **UAT Org**. |
| 4 | Open that user's detail → **Roles** tab and assign the **Platform Administrator** (`admin.platform`) role. | **Platform Administrator** now appears in the user's role list. |
| 5 | In a second browser, sign in as `uatadmin@uat-org.local`. | Sign-in succeeds; the Administrator area is available (this user is now an Org Admin of UAT Org). |
| 6 | As `uatadmin`, open Administrator → **Organizations**. | Only **UAT Org** is visible — the other seeded orgs are not listed (org-scoped). |
| 7 | As `uatadmin`, try to open one of ORG A's resources by URL (e.g. an ORG A user detail id). | It returns Not Found (404, not 403) — cross-org existence is not leaked. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-9 — Email: edit a template (incl. a non-English locale), send a test, view in outbox

- **Screens:** (admin) Email → **Templates** → template detail (edit, incl. a non-English-locale row) → Email **outbox** toolbar (**Send test email**) → outbox row detail.
- **Personas:** **Org Admin** or **Superadmin** holding `admin.email.manage`.
- **Preconditions:** app seeded (template rows exist per key and locale).
- **Code:** templates list guard `admin.email.read`, edit link per row (`src/app/[locale]/(secure)/app/administrator/email/templates/page.tsx:35,94`); edit page guard `admin.email.manage`, with `key` and `locale` shown but **immutable** — each `(key, locale)` is its own row (`src/app/[locale]/(secure)/app/administrator/email/templates/[templateId]/page.tsx:16-17,27,50-53`); save is `PUT /api/administrator/email/templates/[id]` (`.../[templateId]/_template-edit-form.tsx:64`); send-test lives in the outbox toolbar and posts to `/api/administrator/email/test` (`src/app/[locale]/(secure)/app/administrator/email/_outbox-grid.tsx:214-261`), which sends the fixed `test_email` template through the outbox and requires `admin.email.manage` (`src/app/api/administrator/email/test/route.ts:32,65`); outbox row detail renders the stored subject/body (`.../email/_outbox-grid.tsx:263-305`).

**Note (which template the test sends):** the outbox **Send test email** action sends the dedicated `test_email` template to prove the render + outbox pipeline end to end — it does **not** re-send the specific template you just edited (`src/app/api/administrator/email/test/route.ts:65`). `TODO: verify` whether the template editor offers a per-template preview or test-send of the exact edited row; if not, editing and test-sending are verified as two independent assertions below.

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As the admin, open Administrator → **Email** → **Templates**. | A table lists template rows by **key** and **locale** (one row per key per locale). |
| 2 | Open a non-English row — e.g. `password_reset` / `uk` (or `ja`) — via its edit link. | The edit page opens showing the immutable **key** and **locale** header and editable **Subject**, **Body (HTML)**, **Body (text)** and **Description** fields with the localized content. |
| 3 | Make a small visible edit to the subject (keep any `{{variables}}` intact) and save. | The change is saved and you return to the templates list (no error). |
| 4 | Go to Administrator → **Email** (the outbox). Use the **Send test email** control in the toolbar; enter your address and send. | A result appears next to the control showing the outcome (e.g. **logged** with no provider, or **sent**). |
| 5 | Find the new row at the top of the outbox grid (template `test_email`, addressed to you) and open its detail. | The detail sheet shows the recipient, template key, status, and the rendered subject and body of the test email. |
| 6 | Repeat step 4 in a non-Latin UI locale (open the console under `/uk` or `/ja`). | The action and outbox render correctly with no raw message keys; labels are localized. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## UAT-JOURNEY-10 — Locale switch: Preferences localizes the UI and the next email

- **Screens:** Account → **Preferences** (change locale) → the shell UI reflects the new locale → trigger an email → (admin) Email **outbox** shows the next email localized.
- **Personas:** a **Member** (`user3@orga.local`) changing their own locale; an **Org Admin**/Superadmin to read the outbox.
- **Preconditions:** app seeded; the Member starts in `en`; no mail provider (so the triggered email is `logged` and readable in the outbox).
- **Code:** preferences page + locale selector (`src/app/[locale]/(secure)/app/account/preferences/page.tsx:37-45`, form `.../preferences/_preferences-form.tsx:99-117`); save is `PUT /api/account/preferences` then `router.refresh()` (`.../preferences/_preferences-form.tsx:67-81`); the API mirrors the choice onto `app_users.preferred_locale` (`src/app/api/account/preferences/route.ts:53-57`); the next email resolves the recipient's locale from `app_users.preferred_locale` and picks the matching template row (falling back to `en`) (`src/lib/email/send.server.ts:111-122`, template resolution `:61-82`); supported locales `src/config/i18n-config.ts:10`.

| # | Step (what to do) | Expected result |
|---|---|---|
| 1 | As `user3@orga.local`, open **Account → Preferences**. | The form shows a **Language** selector plus time-zone / date-format / number-format controls. |
| 2 | Change the language to a non-Latin locale — e.g. **Ukrainian** (`uk`) or **Japanese** (`ja`) — and save. | A saved confirmation appears; the view refreshes. |
| 3 | Navigate the shell (e.g. open the dashboard and the account menu). | The UI now renders in the chosen locale — navigation labels and headings are translated, with no raw message keys and no `en` fallback in the chrome. |
| 4 | Trigger a user-addressed email for this account — the simplest is to sign out and run **forgot-password** for `user3@orga.local` (as in Journey 7). | The request is accepted. |
| 5 | As the Org Admin, open Administrator → **Email** and open the newest `password_reset` row for `user3@orga.local`. | The email's subject and body are rendered in the locale chosen in step 2 (the recipient's preferred locale drove template selection), confirming the next email localized. |

- Result: [ ] Pass  [ ] Fail  — Notes: ______

---

## Coverage and open items

**Journeys covered: 10 of 10** (`UAT-JOURNEY-1` … `UAT-JOURNEY-10`).

| # | Journey | Screens walked | Key guard / route asserted |
|---|---|---|---|
| 1 | Onboarding | sign-up, pending-approval, Users, sign-in, dashboard | `admin.users.manage` approve; pending redirect |
| 2 | Group grant | Groups new/detail, member sign-in | `admin.groups.assign`; nav key = page guard (no 404) |
| 3 | Direct role | User → Roles tab | `admin.roles.assign` |
| 4 | Impersonation | User detail, shell banner | `admin.users.impersonate`; Stop via `impersonatedBy` |
| 5 | SSO handoff | Applications hub, `/sso/confirm` | `/api/sso/launch` → `/api/sso/consume`, one-time JWT |
| 6 | API-key lifecycle | Account API keys, `/api/v1/me` | Bearer `drk_…`; rotate revokes old → 401 |
| 7 | Password reset | forgot, outbox, reset, sign-in | `password_reset` template, outbox-first |
| 8 | Org lifecycle | Organizations new, New user, Roles | `isSuperadmin` create; `canAccessOrg` scope (404) |
| 9 | Email | Templates, template edit, outbox test | `admin.email.manage`; `(key, locale)` rows; `test_email` |
| 10 | Locale switch | Preferences, shell, outbox | `PUT /api/account/preferences`; recipient-locale email |

**`TODO: verify` items:**

1. **Journey 5** — the cross-subdomain hop needs a satellite origin plus the shared handoff env (`SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID`); confirm the satellite is provisioned in your test setup, otherwise the confirm page shows the invalid-token screen.
2. **Journey 8** — confirm whether the org detail **Members** tab renders an explicit **Add member** button in the UI (the grid read exposes only remove/`DELETE`); adding is otherwise via **New user** into the org or `POST /api/administrator/organizations/:id/members`.
3. **Journey 9** — confirm whether the template editor offers a preview or test-send of the exact edited template row; the outbox **Send test email** action sends the fixed `test_email` template, so editing and test-sending are asserted independently here.
4. **Journey 1** — noted, not blocking: approval is a **Users-list bulk action** (select the pending row → **Approve**); the user detail page shows a read-only status badge with no per-user approve control.
