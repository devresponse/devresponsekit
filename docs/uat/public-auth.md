---
title: "UAT — Public & Auth screens"
description: Screen-by-screen User Acceptance Testing user stories for the public marketing pages and the authentication flows (sign-in, sign-up, password reset, gate screens, SSO confirm).
group: QA
visibility: internal
order: 10
---

# UAT — Public and Auth screens

Executable, screen-by-screen User Acceptance Testing (UAT) stories for the
**public** pages (`/`, `/about`, `/docs`, `/logged-out`) and the
**authentication** flows (`/sign-in`, `/sign-up`, `/forgot-password`,
`/reset-password`, `/pending-approval`, `/blocked`, `/sso/confirm`).

Every claim below is grounded in the code; the source file and line are cited
inline. Where a claim could not be fully verified from code alone it is flagged
`TODO: verify`.

Story IDs follow `UAT-AUTH-<SCREEN>-Sn` so they map cleanly into a
test-management tool. A condensed one-row-per-story export lives at
`docs/uat/_csv/public-auth.csv`.

---

## Test environment and accounts

- **Base URL:** `http://localhost:3000`. All app routes are locale-prefixed, so
  the canonical form is `/<locale><route>` (e.g. `/en/sign-in`). `/` redirects
  to `/<defaultLocale>` via the proxy — see `src/proxy.ts:103` and the
  next-intl middleware wiring at `src/proxy.ts:122`.
- **Locales (8):** `en`, `es`, `fr`, `hi`, `ja`, `pt`, `uk`, `zh`. Test every
  screen in `en` plus one non-Latin locale — `uk` (Cyrillic) is a good choice
  for i18n checks.
- **Seeding personas:**
  - `pnpm db:seed` — the canonical single **Local Admin** (from
    `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env`); this account holds
    `admin`, `admin.platform`, and `superuser` roles in the `default` org
    (`src/db/seeds/seed-local.ts:307-355`).
  - `pnpm db:seed:dev` — the richer multi-org fixture: 3 orgs (`org-a`,
    `org-b`, `org-c`), each with `superuser@`, `orgadmin@`, and `user1..5@`
    accounts, plus 3 cross-org `multi*@shared.local` members and 2 groups in
    ORG A (`src/db/seeds/dev-init.ts:84-152`). Every dev account shares one
    password: `DevPassword123!` (override with `DEV_SEED_PASSWORD`) —
    `src/db/seeds/dev-init.ts:52`.
- **Persona credentials (dev fixture):**

  | Persona | Example account | Password | Seed role |
  | --- | --- | --- | --- |
  | Visitor | (none — signed out) | — | unauthenticated |
  | Member | `user1@orga.local` | `DevPassword123!` | `member` |
  | Org Admin | `orgadmin@orga.local` | `DevPassword123!` | `admin.platform` |
  | Limited Admin | member of the ORG A **Engineering** group (`user1@orga.local`) | `DevPassword123!` | `admin` role via group (`src/db/seeds/dev-init.ts:142`) |
  | Superadmin | `superuser@orga.local` | `DevPassword123!` | `superuser` |
  | Pending user | freshly self-signed-up account | (as chosen) | `pending_approval` (auto) |
  | Blocked user | an account an admin has blocked/suspended | (as set) | `blocked` / `suspended` / `deactivated` |

  > **Note on the Limited Admin persona.** The dev fixture does not seed a user
  > whose *direct* role is `admin`; instead the `admin` role is conferred to
  > `user1@orga.local` and `user2@orga.local` through the ORG A **Engineering**
  > group (`src/db/seeds/dev-init.ts:135-143`). Effective permissions =
  > direct roles ∪ group-conferred roles (`src/lib/auth-status.ts:185-202`), so
  > `user1@orga.local` is a valid Limited Admin for partial-permission tests.

- **Resetting:** the dev seed is idempotent — re-run `pnpm db:seed:dev` to
  restore state (`src/db/seeds/dev-init.ts:28`). To create a fresh Pending user,
  sign up with a new email; to create a Blocked user, have an admin block an
  existing account.
- **Signing up creates a pending account.** Self-registration always lands the
  new user in `pending_approval` (the sign-up form redirects straight to the
  pending page — `src/components/auth/email-password-sign-up-form.tsx:53`) until
  an administrator approves it.

### Access model in one paragraph

None of the public or auth pages are permission-gated — they render for anyone.
The **authorization boundary is the secure shell** (`/<locale>/app/*`), enforced
in two layers: a cookie-only early redirect in the proxy
(`src/proxy.ts:103-113`) and the real server-side check in
`requireSecureSession` (`src/lib/auth-guard.ts:55-76`), which calls
`decideSecureAccess` (`src/lib/auth-status.ts:66-77`). That function routes a
signed-in user to `/pending-approval` (pending status or no active membership)
or `/blocked` (blocked/suspended/deactivated) before any secure page renders.
The auth pages themselves have **no session check** — an already-signed-in user
who navigates to `/sign-in` still sees the form (verified: no `getSession` /
`redirect` in any `(auth)` page).

---

## Public screens

### AUTH-LANDING — Landing (marketing home)

- Route: `/` (locale root)  ·  Example URL: `/en`  ·  Code: `src/app/[locale]/(public)/page.tsx:77`
- Purpose: Public marketing home for DevResponseKit. Renders hero, feature grid,
  "why", tech-stack, and CTA sections, all localized via the `public` message
  namespace. Primary CTA links to the public GitHub repo; secondary CTAs go to
  sign-up / sign-in.
- Guard / who can access: None. Lives in the `(public)` route group with a
  lightweight shell, no session required (`src/app/[locale]/(public)/layout.tsx:29`).
- Access matrix: Visitor -> see: yes, act: yes · Pending / Member / Limited
  Admin / Org Admin / Superadmin -> see: yes, act: yes (all personas can view
  the public home regardless of status).
- Preconditions & test data: None. No DB rows required.

User stories

- UAT-AUTH-LANDING-S1 — As a Visitor, I want to reach sign-up from the landing
  page, so that I can start creating an account.
  - Acceptance criteria: Given I am on `/en`, when I click the "Create account"
    secondary CTA (button text from `public.hero.secondaryCta`,
    `src/app/[locale]/(public)/page.tsx:127-129`), then I land on `/en/sign-up`.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en` in a signed-out browser | The landing page renders: hero heading, a "Star on GitHub"-style primary button, and two more buttons in the hero |
    | 2 | Click the second hero button (create-account CTA) | The URL changes to `/en/sign-up` and the sign-up card appears |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-AUTH-LANDING-S2 — As a Visitor, I want the primary call to action to open
  the project's GitHub, so that I can view the source.
  - Acceptance criteria: Given I am on `/en`, when I click the primary hero CTA,
    then a new tab opens to `https://github.com/devresponse/devresponsekit`
    (`src/app/[locale]/(public)/page.tsx:38`, `:121`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en` | Landing renders with the hero primary button |
    | 2 | Click the primary hero button (GitHub icon + `hero.primaryCta` label) | A new browser tab opens at `github.com/devresponse/devresponsekit` (opens with `target="_blank"` + `rel="noopener noreferrer"`) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-AUTH-LANDING-S3 — As a Visitor, I want to switch the site language from the
  brand bar, so that I can read the page in my language.
  - Acceptance criteria: Given I am on `/en`, when I pick another language in the
    brand-bar locale switcher, then the URL locale prefix and the visible copy
    change to that language (brand bar from `src/app/[locale]/(public)/layout.tsx:54-70`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en` | Brand bar shows a language switcher plus "Sign in" and "Sign up" links |
    | 2 | Open the language switcher and choose Ukrainian | URL becomes `/uk`; hero, features and stats render in Ukrainian; no raw keys like `public.hero.title` are shown |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Unknown locale in the URL (e.g. `/xx`): the proxy classifies unknown locales
  as public and next-intl falls back; the page coerces to `en`
  (`src/app/[locale]/(public)/page.tsx:79`). Expected: renders in English, no crash.
- Missing localized hero screenshot: a locale without its own capture falls back
  to the English AVIF so the hero image never 404s
  (`src/app/[locale]/(public)/page.tsx:45-54`, `:91`). Expected: image always loads.
- No inline-error / empty / loading states apply — this is a static server-rendered
  marketing page with no data fetch and no forms.

Accessibility: Sections use `aria-labelledby` on headings
(`src/app/[locale]/(public)/page.tsx:98`, `:172`, `:202`); decorative glyphs are
`aria-hidden`. Keyboard: Tab reaches every CTA link/button; visible focus ring on
each. Skip links are rendered by the shell (`ShellSkipLinks`,
`src/app/[locale]/(public)/layout.tsx:43`).
i18n: Run in `en` + `uk`. All copy comes from the `public` namespace; verify no
raw message keys and that stats/labels localize.

### AUTH-ABOUT — About

- Route: `/about`  ·  Example URL: `/en/about`  ·  Code: `src/app/[locale]/(public)/about/page.tsx:3`
- Purpose: Placeholder public marketing/about page. Renders the brand name and a
  single line of placeholder copy.
- Guard / who can access: None (`(public)` group).
- Access matrix: Visitor / Pending / Member / Limited Admin / Org Admin /
  Superadmin -> see: yes, act: n/a (no interactive controls on the page body).
- Preconditions & test data: None.

User stories

- UAT-AUTH-ABOUT-S1 — As a Visitor, I want to open the About page, so that I can
  learn what the product is.
  - Acceptance criteria: Given I navigate to `/en/about`, then a page renders
    with the brand name as an `<h1>` and a short description
    (`src/app/[locale]/(public)/about/page.tsx:6-11`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en/about` | An `<h1>` shows the brand name; below it one line: "<brand name> Platform — public marketing/landing content goes here." |
    | 2 | Confirm the brand bar is present | Sign in / Sign up links and the language switcher appear at the top (shared public layout) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Content is **not** localized on this page: the body text is hard-coded English
  interpolated with the brand name (`src/app/[locale]/(public)/about/page.tsx:8-10`),
  not drawn from a message namespace. `TODO: verify` whether this placeholder is
  expected to remain un-localized; flag if product wants it translated.
- No forms/data — no empty/loading/error states.

Accessibility: single `<h1>` in a `<main>` landmark; keyboard Tab reaches only
the shared brand-bar controls. No axe violations expected on the body.
i18n: The brand bar localizes; the body paragraph does not (see edge case above).

### AUTH-DOCS-PUBLIC — Public documentation index

- Route: `/docs`  ·  Example URL: `/en/docs`  ·  Code: `src/app/[locale]/(public)/docs/page.tsx:1`
- Purpose: Placeholder public-facing documentation index. Static heading +
  one-line description. (Distinct from the in-app docs viewer at `/app/docs`,
  which is behind the secure shell.)
- Guard / who can access: None (`(public)` group).
- Access matrix: Visitor / Pending / Member / Limited Admin / Org Admin /
  Superadmin -> see: yes, act: n/a.
- Preconditions & test data: None.

User stories

- UAT-AUTH-DOCS-PUBLIC-S1 — As a Visitor, I want to open the public docs index,
  so that I can find documentation entry points.
  - Acceptance criteria: Given I navigate to `/en/docs`, then a page renders with
    the heading "Documentation" and the line "Public-facing documentation index."
    (`src/app/[locale]/(public)/docs/page.tsx:3-6`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en/docs` | An `<h1>` reads "Documentation"; a paragraph reads "Public-facing documentation index." |
    | 2 | Confirm access without signing in | The page renders for a signed-out visitor (no redirect to sign-in) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Content is hard-coded English (`src/app/[locale]/(public)/docs/page.tsx:4-5`),
  not localized. `TODO: verify` whether this placeholder should localize.
- Do **not** confuse with `/app/docs` (the secure, frontmatter-driven viewer) —
  that one requires a session and is covered in the account/docs UAT set.
- No forms/data — no empty/loading/error states.

Accessibility: `<h1>` in a `<main>` landmark; only brand-bar controls are
focusable on this page.
i18n: Brand bar localizes; body is static English (edge case above).

### AUTH-LOGGED-OUT — Logged out

- Route: `/logged-out`  ·  Example URL: `/en/logged-out`  ·  Code: `src/app/[locale]/(public)/logged-out/page.tsx:12`
- Purpose: Confirmation shown after `SignOutButton` completes a local-only
  sign-out. Renders `LoggedOutPanel` (an alert + a link back to sign-in). Lives
  in `(public)` so it never re-engages the secure shell
  (`src/components/auth/logged-out-panel.tsx:11-18`).
- Guard / who can access: None. Reached programmatically after sign-out
  (`src/components/auth/sign-out-button.tsx:29`), but directly navigable by anyone.
- Access matrix: Visitor / Pending / Member / Limited Admin / Org Admin /
  Superadmin -> see: yes, act: yes (the only action is the "Sign in" link).
- Preconditions & test data: None to view. To reach it via the real flow, be
  signed in first, then use "Sign out".

User stories

- UAT-AUTH-LOGGED-OUT-S1 — As a Member who just signed out, I want a confirmation
  and a way back in, so that I know my session ended and can sign in again.
  - Acceptance criteria: Given I click "Sign out" anywhere in the secure shell,
    when the local sign-out completes, then I am redirected to `/<locale>/logged-out`
    (`src/components/auth/sign-out-button.tsx:29`) showing the "You have been
    signed out" alert with a "Sign in" link.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign in as `user1@orga.local` and open any `/en/app/*` page | The secure shell renders with a "Sign out" button in the top bar |
    | 2 | Click "Sign out" | The browser navigates to `/en/logged-out` |
    | 3 | Read the panel | An alert titled "You have been signed out" with body "Sign in again to continue." (`auth.loggedOutTitle` / `auth.loggedOutDescription`) |
    | 4 | Click the "Sign in" link | You land on `/en/sign-in` |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-AUTH-LOGGED-OUT-S2 — As a Visitor, I want the page to be directly reachable,
  so that a bookmarked/shared logged-out URL still works.
  - Acceptance criteria: Given I open `/en/logged-out` directly while signed out,
    then the same panel renders (no redirect, no secure API calls).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en/logged-out` directly in a signed-out browser | The "You have been signed out" alert renders with a working "Sign in" link |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Sign-out is **local-only** (this subdomain): other subdomain sessions are
  intentionally left intact (`src/components/auth/sign-out-button.tsx:14-16`).
  Expected: signing out here does not sign you out of a sibling app.
- Locale coercion: an unsupported locale segment coerces to `en`
  (`src/app/[locale]/(public)/logged-out/page.tsx:14`). Expected: renders in English.
- No form validation / empty / loading states.

Accessibility: The panel is an `Alert` with a titled region; the "Sign in" link
is keyboard-focusable with a visible ring.
i18n: Title/description come from the `auth` namespace and the link label from
`common.signIn` (`src/components/auth/logged-out-panel.tsx:20-33`); run in `uk`
to confirm both localize.

---

## Auth screens

> **Shared context for all auth screens.** They live in the `(auth)` route group,
> which has **no dedicated layout** (verified: no `src/app/[locale]/(auth)/layout.tsx`);
> they render under the root locale layout only, so the secure navigation shell
> never mounts. There is **no server-side session check** on these pages — a
> signed-in user visiting `/sign-in` still sees the form. Only `sign-in`,
> `sign-up`, `forgot-password`, `reset-password`, `pending-approval`, and
> `blocked` are classified as `auth` routes; `sso/confirm` (also under the
> `(auth)` folder) is classified as `public` by the route-region map
> (`src/config/route-regions.ts:27-34`).

### AUTH-SIGNIN — Sign in

- Route: `/sign-in`  ·  Example URL: `/en/sign-in`  ·  Code: `src/app/[locale]/(auth)/sign-in/page.tsx:14`
- Purpose: Email/password + social sign-in. Sanitizes the `returnTo` query
  server-side (`getSafeReturnTo`, `src/app/[locale]/(auth)/sign-in/page.tsx:25`)
  so it cannot drive an open redirect, then passes it to Better Auth as
  `callbackURL`.
- Guard / who can access: None. Unauthenticated deep-links into secure routes are
  bounced here by the proxy with a `returnTo` param (`src/proxy.ts:106-112`) and
  by `requireSecureSession` (`src/lib/auth-guard.ts:58-62`).
- Access matrix: Visitor -> see: yes, act: yes · Pending / Blocked / Member /
  admins -> see: yes (no redirect away from the form) but signing in again just
  re-runs the flow.
- Fields & controls (verified against `src/components/auth/email-password-login-form.tsx`
  and `src/components/auth/sign-in-form.tsx`):
  - Email input (`type="email"`, `autoComplete="email"`, label `common.email`) — required.
  - Password input (`type="password"`, `autoComplete="current-password"`, label
    `common.password`) — required (any non-empty value; Better Auth verifies).
  - Primary submit button, label `common.signIn`.
  - Three social buttons: "Continue with Google", "Continue with Microsoft",
    "Continue with GitHub" (`src/components/auth/social-login-buttons.tsx:32-41`).
  - Links: "Forgot password?" -> `/forgot-password`; "Create account" -> `/sign-up`
    (`src/components/auth/sign-in-form.tsx:39-52`).
  - A required-field legend ("\* indicates a required field") from `RequiredLegend`
    (`src/components/auth/email-password-login-form.tsx:61`).
- Validation schema: `signInSchema` — `email` must be a valid email; `password`
  min length 1 (`src/lib/validation/auth.ts:10-13`).
- Preconditions & test data: an `active` account with an `active` membership,
  e.g. `user1@orga.local` / `DevPassword123!`.

User stories

- UAT-AUTH-SIGNIN-S1 — As a Member, I want to sign in with my email and password,
  so that I reach my dashboard.
  - Acceptance criteria: Given valid credentials for an `active` account, when I
    submit, then Better Auth signs me in and the `callbackURL` (sanitized
    `returnTo`, defaulting to `/<locale>/app/dashboard` —
    `src/lib/safe-return-to.ts:17`) is honored.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en/sign-in` | Sign-in card: title "Sign in to your account", email + password fields, a "Sign in" button, three social buttons, and Forgot/Create links |
    | 2 | Enter `user1@orga.local` and `DevPassword123!` | Both fields accept input; no validation error |
    | 3 | Click "Sign in" | Button shows "Loading…" while submitting, then you are redirected into the secure shell at `/en/app/dashboard` |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-AUTH-SIGNIN-S2 — As a Visitor deep-linking into a secure page, I want to be
  returned there after signing in, so that I don't lose my place.
  - Acceptance criteria: Given I open a secure URL while signed out, when the
    proxy redirects me to sign-in with `returnTo` and I then sign in, then I land
    on the originally requested secure page (`src/proxy.ts:108`, honored via
    `callbackURL` at `src/components/auth/email-password-login-form.tsx:46`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Signed out, open `/en/app/workspace` | You are redirected to `/en/sign-in?returnTo=%2Fen%2Fapp%2Fworkspace` |
    | 2 | Sign in as `user1@orga.local` / `DevPassword123!` | After sign-in you land on `/en/app/workspace`, not the default dashboard |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- UAT-AUTH-SIGNIN-S3 (wrong password) — Given a real email with a wrong password,
  when I submit, then an inline alert reads "Invalid email or password."
  (`auth.invalidCredentials`, rendered in a `role="alert"` paragraph —
  `src/components/auth/email-password-login-form.tsx:49`, `:91-95`). The message
  is generic (no account-existence leak).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open `/en/sign-in`, enter `user1@orga.local` + `wrong-pass` | Fields accept the input |
    | 2 | Click "Sign in" | An alert "Invalid email or password." appears; you stay on the sign-in page |
- Empty required fields: submitting with an empty email shows "Enter a valid
  email address." (`validation.email`); empty password shows "This field is
  required." (`validation.required`) — both via `FormMessage`
  (`src/components/ui/form.tsx:193-219`), with the field getting `aria-invalid`
  and an error border. The `*` marker appears on both labels (schema-derived,
  `src/components/ui/form.tsx:144-151`).
- Malicious `returnTo`: an absolute URL, `//evil.com`, a backslash-smuggled path,
  an `/api/*` path, or an auth/status page all fall back to
  `/<locale>/app/dashboard` (`src/lib/safe-return-to.ts:23-44`). Expected: no
  open redirect off-site.
- Blocked/pending user signing in: sign-in itself succeeds, then the secure
  layout's `requireSecureSession` redirects them to `/blocked` or
  `/pending-approval` (`src/lib/auth-guard.ts:67-73`). Assert they never see a
  secure page.
- Unexpected transport error: the catch branch surfaces
  "An unexpected error occurred. Please try again." (`auth.unexpectedError`,
  `src/components/auth/email-password-login-form.tsx:51`).
- Rate-limit: `TODO: verify` — no rate-limit handling is visible in the sign-in
  form; confirm whether Better Auth applies one server-side and how it surfaces.

Accessibility: labelled email/password controls (`FormLabel` + `htmlFor`,
`src/components/ui/form.tsx:126-155`); the error is a live `role="alert"`;
`aria-required` / `aria-invalid` are set on the controls
(`src/components/ui/form.tsx:157-172`); social buttons are real `<button>`s.
Keyboard-only: Tab through email -> password -> Sign in -> social buttons ->
Forgot/Create links; visible focus throughout.
i18n: Titles, labels, and errors come from the `auth` / `common` / `validation`
namespaces; run in `uk`, confirm no raw keys and localized error text.

### AUTH-SIGNUP — Sign up

- Route: `/sign-up`  ·  Example URL: `/en/sign-up`  ·  Code: `src/app/[locale]/(auth)/sign-up/page.tsx:6`
- Purpose: Self-registration (name + email + password) plus the same three social
  providers. On success the user is provisioned as `pending_approval` and sent
  straight to the pending page.
- Guard / who can access: None.
- Access matrix: Visitor -> see: yes, act: yes · signed-in personas -> see: yes
  (no redirect away).
- Fields & controls (verified against
  `src/components/auth/email-password-sign-up-form.tsx` and
  `src/components/auth/sign-up-form.tsx`):
  - Name input (`type="text"`, `autoComplete="name"`, label `common.displayName`
    = "Name") — required, trimmed, max 200.
  - Email input — required, valid email.
  - Password input (`autoComplete="new-password"`) — required, **min 8**, max 128.
  - Submit button, label `auth.createAccount` ("Create account").
  - Three social buttons + a "Already have an account?" link to `/sign-in`.
  - Required-field legend.
- Validation schema: `signUpSchema` — `name` min 1 / max 200; `email` valid;
  `password` min 8 (`passwordMin`) / max 128 (`passwordMax`)
  (`src/lib/validation/auth.ts:17-21`).
- Preconditions & test data: an email address not already registered.

User stories

- UAT-AUTH-SIGNUP-S1 — As a Visitor, I want to register a new account, so that I
  can request access to the app.
  - Acceptance criteria: Given a fresh email and a password of at least 8
    characters, when I submit, then Better Auth creates the account and I am
    redirected to `/<locale>/pending-approval`
    (`src/components/auth/email-password-sign-up-form.tsx:43-53`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en/sign-up` | Sign-up card: title "Create your account"; Name, Email, Password fields; "Create account" button; social buttons; a "Already have an account?" link |
    | 2 | Enter Name "Test User", a new email, and a password ≥ 8 chars | Fields accept input; no validation errors |
    | 3 | Click "Create account" | The button shows "Loading…", then you are redirected to `/en/pending-approval` |
    | 4 | Read the pending page | It states the account is pending administrator approval |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- UAT-AUTH-SIGNUP-S2 (short password) — Given a password under 8 characters,
  when I submit, then the Password field shows "Password must be at least 8
  characters." (`validation.passwordMin`) and the form does not submit.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open `/en/sign-up`, fill Name + a fresh email, enter password `abc` | — |
    | 2 | Click "Create account" | Inline error "Password must be at least 8 characters." under Password; field shows an error border (`aria-invalid`); no navigation |
- Empty required fields: Name empty -> "This field is required." (`validation.required`);
  Email empty/invalid -> "Enter a valid email address." (`validation.email`). The
  `*` marker appears on all three labels (all schema-required).
- Duplicate email: Better Auth returns an error; the form maps *any* server error
  to the generic "An unexpected error occurred. Please try again."
  (`auth.unexpectedError`, `src/components/auth/email-password-sign-up-form.tsx:50`).
  `TODO: verify` whether product wants a specific "email already registered"
  message (current behavior is intentionally generic).
- Max-length: name over 200 chars -> `validation.max`; password over 128 ->
  `validation.passwordMax`.
- Rate-limit: `TODO: verify` — no client handling of a sign-up rate-limit is
  present.

Accessibility: three labelled controls; error alert is `role="alert"`;
`aria-required` on each control; keyboard order Name -> Email -> Password ->
Create account -> social -> sign-in link.
i18n: card title from `auth.signUpTitle`, labels from `common`, errors from
`validation`; run in `uk`.

### AUTH-FORGOT — Forgot password

- Route: `/forgot-password`  ·  Example URL: `/en/forgot-password`  ·  Code: `src/app/[locale]/(auth)/forgot-password/page.tsx:13`
- Purpose: Requests a Better Auth password-reset email. Anti-enumeration: the
  same confirmation shows whether or not the address exists
  (`src/components/auth/forgot-password-form.tsx:26-31`). The emailed link lands
  on `/<locale>/reset-password` (`redirectTo`,
  `src/app/[locale]/(auth)/forgot-password/page.tsx:23`).
- Guard / who can access: None.
- Access matrix: Visitor / any persona -> see: yes, act: yes.
- Fields & controls (verified against `src/components/auth/forgot-password-form.tsx`):
  - A short description paragraph (`auth.forgotPasswordDescription`).
  - Required-field legend.
  - Email input (`type="email"`, `autoComplete="email"`, label `common.email`) — required.
  - Submit button, label `auth.sendResetLink` ("Send reset link"); shows
    "Loading…" while submitting.
  - Card title "Choose a new password" — actually the page title is
    `auth.forgotPassword` ("Forgot password?") from
    `src/app/[locale]/(auth)/forgot-password/page.tsx:20`.
- Validation schema: `forgotPasswordSchema` — just a valid `email`
  (`src/lib/validation/auth.ts:25-27`).
- Preconditions & test data: to see a real email arrive, use an existing account
  and check the outbox (emails are recorded through the outbox pipeline —
  `src/app/[locale]/(auth)/forgot-password/page.tsx:8-11`); the confirmation is
  identical regardless.

User stories

- UAT-AUTH-FORGOT-S1 — As a Member who forgot my password, I want to request a
  reset link, so that I can set a new password.
  - Acceptance criteria: Given a valid email, when I submit, then a success
    message renders ("If an account exists for that address, a password reset
    link is on its way." — `auth.resetEmailSent`,
    `src/components/auth/forgot-password-form.tsx:56-62`) in a `role="status"`
    region.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open `/en/forgot-password` | A card titled "Forgot password?" with a description, an Email field, and a "Send reset link" button |
    | 2 | Enter `user1@orga.local` | Field accepts input |
    | 3 | Click "Send reset link" | The button shows "Loading…", then the form is replaced by the confirmation message |
    | 4 | Check the admin email outbox | A password-reset email to that address is recorded (outbox pipeline) |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-AUTH-FORGOT-S2 — As a Visitor, I want the same confirmation for an unknown
  email, so that the app never reveals whether an account exists.
  - Acceptance criteria: Given an email with no account, when I submit, then the
    **identical** confirmation appears and no error is shown
    (`src/components/auth/forgot-password-form.tsx:26-31`).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open `/en/forgot-password`, enter `nobody@example.com` | — |
    | 2 | Click "Send reset link" | The same "If an account exists…" confirmation appears; no "user not found" hint |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Invalid email format: submitting `not-an-email` shows "Enter a valid email
  address." (`validation.email`); the `*` marker is on the Email label.
- Empty email: "Enter a valid email address." (the schema rejects an empty string
  as an invalid email, `src/lib/validation/auth.ts:25`).
- Transport failure: the `result.error` and catch branches both set the root
  error to "An unexpected error occurred. Please try again."
  (`auth.unexpectedError`), rendered in a `role="alert"`
  (`src/components/auth/forgot-password-form.tsx:46-53`, `:86-90`).
- Rate-limit: `TODO: verify` — no explicit rate-limit surface in the form.

Accessibility: labelled Email control; success is `role="status"` (polite),
error is `role="alert"`; keyboard Tab: Email -> Send reset link.
i18n: description/button/confirmation from the `auth` namespace; run in `uk`.

### AUTH-RESET — Reset password

- Route: `/reset-password`  ·  Example URL: `/en/reset-password?token=<t>`  ·  Code: `src/app/[locale]/(auth)/reset-password/page.tsx:13`
- Purpose: Completes the reset flow using the one-time `?token=` from the emailed
  link. Better Auth validates the token when the new password is submitted; an
  invalid/expired/missing token shows a path back to `/forgot-password`.
- Guard / who can access: None (but the flow is meaningless without a valid token).
- Access matrix: Visitor / any persona with a token -> see: yes, act: yes.
- Fields & controls (verified against `src/components/auth/reset-password-form.tsx`):
  - **No-token state:** if `?token` is absent, the form is replaced by a
    `role="alert"` line "This reset link is invalid or has expired."
    (`auth.resetTokenInvalid`) plus a "Request a new link" link to
    `/forgot-password` (`src/components/auth/reset-password-form.tsx:66-75`).
  - **Form state (token present):** required-field legend; New password
    (`auth.newPassword`, `autoComplete="new-password"`) — required, min 8, max
    128; Confirm password (`auth.confirmPassword`) — required and must match;
    submit button `auth.setNewPassword` ("Set new password").
  - **Done state:** a `role="status"` line "Your password has been updated."
    (`auth.resetPasswordDone`) + a "Sign in" link
    (`src/components/auth/reset-password-form.tsx:77-86`).
  - Card title "Choose a new password" (`auth.resetPasswordTitle`,
    `src/app/[locale]/(auth)/reset-password/page.tsx:27`).
- Validation schema: `resetPasswordSchema` = fields + refine (passwords must
  match; the mismatch message `validation.passwordsMismatch` is surfaced on the
  Confirm field). The unrefined `resetPasswordFieldsSchema` drives the required
  `*` markers so **both** fields show one (`src/lib/validation/auth.ts:34-42`,
  wired at `src/components/auth/reset-password-form.tsx:45`, `:91`).
- Preconditions & test data: complete AUTH-FORGOT first and copy the `token` from
  the emailed link (or the outbox record).

User stories

- UAT-AUTH-RESET-S1 — As a Member with a valid reset link, I want to set a new
  password, so that I can sign in again.
  - Acceptance criteria: Given a valid token and two matching passwords ≥ 8 chars,
    when I submit, then Better Auth resets the password and a success message with
    a "Sign in" link appears (`src/components/auth/reset-password-form.tsx:49-63`).
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Open the reset link, e.g. `/en/reset-password?token=<valid>` | A card titled "Choose a new password" with New password + Confirm password fields and a "Set new password" button |
    | 2 | Enter a new password (≥ 8 chars) in both fields, matching | Fields accept input; no error |
    | 3 | Click "Set new password" | The form is replaced by "Your password has been updated." and a "Sign in" link |
    | 4 | Click "Sign in" and log in with the new password | You reach the sign-in page and can authenticate with the new password |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- UAT-AUTH-RESET-S2 (mismatched passwords) — Given two different passwords, when I
  submit, then the Confirm field shows "Passwords do not match."
  (`validation.passwordsMismatch`, `src/lib/validation/auth.ts:38-41`) and the
  form does not submit.
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open `/en/reset-password?token=<valid>`, enter `password123` / `password124` | — |
    | 2 | Click "Set new password" | Inline error "Passwords do not match." under Confirm password; no navigation |
- UAT-AUTH-RESET-S3 (no / invalid token) — Given the page opened without a token
  (`/en/reset-password`), then no form renders; instead "This reset link is
  invalid or has expired." + a "Request a new link" link
  (`src/components/auth/reset-password-form.tsx:66-75`).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open `/en/reset-password` with no `token` param | The alert "This reset link is invalid or has expired." shows with a "Request a new link" link to `/en/forgot-password` |
- Expired/used token (token present but rejected by Better Auth on submit): the
  `result.error` branch sets the root error to "This reset link is invalid or has
  expired." (`auth.resetTokenInvalid`, `src/components/auth/reset-password-form.tsx:57`).
  Expected: a `role="alert"` with that message; user can go request a new link.
- Short/long password: New password under 8 -> "Password must be at least 8
  characters."; over 128 -> `validation.passwordMax`. The `*` marker is on both
  labels.
- Empty Confirm password -> "This field is required." (`validation.required`).

Accessibility: both password fields labelled and `aria-required`; the no-token
and error states are `role="alert"`, the done state is `role="status"`; keyboard
Tab: New -> Confirm -> Set new password (and the in-message links).
i18n: title, labels, and messages from `auth` / `validation`; run in `uk`.

### AUTH-PENDING — Pending approval

- Route: `/pending-approval`  ·  Example URL: `/en/pending-approval`  ·  Code: `src/app/[locale]/(auth)/pending-approval/page.tsx:12`
- Purpose: Landing page for a signed-in user whose account (or membership) is
  `pending_approval`. Renders `PendingApprovalPanel` — an informational alert
  plus a local "Sign out" button. Guaranteed not to mount the secure shell or
  call secure menu APIs (`src/components/auth/pending-approval-panel.tsx:12-22`).
- Guard / who can access: None on the page itself; it is the **destination** of
  `requireSecureSession` when `decideSecureAccess` returns `pending_approval`
  (`src/lib/auth-guard.ts:67-69`; decision logic
  `src/lib/auth-status.ts:70-76` — pending status, or a null / pending membership).
- Access matrix: Pending user -> see: yes, act: yes (sign out). Any other persona
  -> can view the page directly, but only a genuinely pending user is *routed*
  here by the shell.
- Preconditions & test data: a freshly self-signed-up account (never approved),
  e.g. sign up with a new email, then attempt to open `/en/app/dashboard`.

User stories

- UAT-AUTH-PENDING-S1 — As a newly registered (Pending) user, I want to be told my
  account awaits approval, so that I understand why I can't reach the app yet.
  - Acceptance criteria: Given I am signed in but `pending_approval`, when I try
    to open any secure page, then I am redirected to `/<locale>/pending-approval`
    (`src/lib/auth-guard.ts:68`) showing the pending alert and a "Sign out" button.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Sign up with a brand-new email at `/en/sign-up` | You are redirected to `/en/pending-approval` |
    | 2 | Read the panel | Card + alert titled "Your account is pending approval"; body: "An administrator must approve your account before you can access secure pages." (`auth.pendingApprovalTitle` / `auth.pendingApprovalDescription`) |
    | 3 | Manually open `/en/app/dashboard` | You are redirected back to `/en/pending-approval` (the shell guard blocks pending users) |
    | 4 | Click "Sign out" | You are signed out and land on `/en/logged-out` |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Pending user cannot bypass into a secure page: every `/en/app/*` request
  re-runs `requireSecureSession` and re-redirects
  (`src/lib/auth-guard.ts:67-69`). Assert no secure content flashes.
- No membership at all (provisioned user, zero active memberships) also resolves
  to `pending_approval` (`src/lib/auth-status.ts:72-73`), so the same screen is
  shown. `TODO: verify` this specific sub-case with a user that has no membership
  row.
- The panel deliberately shows only generic copy — no admin/operational detail.
- No form fields; the only control is "Sign out". No validation states.

Accessibility: the message is an `Alert` with a titled region; "Sign out" is a
labelled `<button>`; keyboard reaches it with a visible focus ring.
i18n: title/description from `auth`, button label from `common.signOut`
(`src/components/auth/pending-approval-panel.tsx:26-35`); run in `uk`.

### AUTH-BLOCKED — Blocked / suspended / deactivated

- Route: `/blocked`  ·  Example URL: `/en/blocked`  ·  Code: `src/app/[locale]/(auth)/blocked/page.tsx:12`
- Purpose: Landing page when the user's application status forbids secure access
  (`blocked`, `suspended`, or `deactivated`). Renders `BlockedAccountPanel` — a
  destructive-variant alert with generic copy plus a "Sign out" button; never
  reveals who/why (`src/components/auth/blocked-account-panel.tsx:12-24`).
- Guard / who can access: None on the page; it is the destination of
  `requireSecureSession` when `decideSecureAccess` returns `blocked`
  (`src/lib/auth-guard.ts:71-73`). The shell appends `?reason=<status>` to the
  redirect URL (`src/lib/auth-guard.ts:72`), though the panel does not display it.
- Access matrix: Blocked user -> see: yes, act: yes (sign out). Others -> can view
  directly, but only a blocked/suspended/deactivated user is *routed* here.
- Preconditions & test data: an account an admin has blocked/suspended (or whose
  status is `deactivated`). Also reached for an unknown/corrupt status because the
  status coercion fails **closed** to `deactivated` (`src/lib/auth-status.ts:48-52`).

User stories

- UAT-AUTH-BLOCKED-S1 — As a Blocked user, I want a clear "access restricted"
  message, so that I know my account is not usable and can contact an admin.
  - Acceptance criteria: Given my status is `blocked` (or `suspended` /
    `deactivated`), when I try to open a secure page, then I am redirected to
    `/<locale>/blocked` (`src/lib/auth-guard.ts:72`) showing the restricted alert
    and a "Sign out" button.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | As an admin, block/suspend a member account (Admin console -> Users) | The target account's status becomes blocked/suspended |
    | 2 | Sign in as that blocked user and open `/en/app/dashboard` | You are redirected to `/en/blocked?reason=<status>` |
    | 3 | Read the panel | A destructive-styled alert titled "Account access is restricted"; body: "Your account is currently blocked, suspended, or deactivated. Contact your administrator." (`auth.blockedTitle` / `auth.blockedDescription`) |
    | 4 | Click "Sign out" | You are signed out and land on `/en/logged-out` |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- No moderation context leaks: the panel shows only the generic description, never
  who blocked the account or why (`src/components/auth/blocked-account-panel.tsx:14-19`).
  Assert the `?reason=` value is not rendered on screen.
- Blocked user cannot reach secure pages: every `/en/app/*` request re-redirects
  to `/blocked` (`src/lib/auth-guard.ts:71-73`).
- Unknown/corrupt DB status: fails closed to `deactivated` -> `blocked` decision
  (`src/lib/auth-status.ts:48-52`, `:70`), so a bad row can never grant access.
  `TODO: verify` behavior with a deliberately corrupted status row.
- No form fields; only "Sign out". No validation states.

Accessibility: destructive `Alert` with a titled region; "Sign out" is a labelled
`<button>`, keyboard-focusable with visible focus.
i18n: title/description from `auth`, button from `common.signOut`; run in `uk`.

### AUTH-SSO-CONFIRM — SSO consume confirmation

- Route: `/sso/confirm`  ·  Example URL: `/en/sso/confirm?token=<jwt>`  ·  Code: `src/app/[locale]/(auth)/sso/confirm/page.tsx:39`
- Purpose: Security interstitial for the cross-subdomain SSO handoff. The GET
  `/api/sso/consume` verifies the handoff token (no nonce burn) and redirects
  here; this page **re-verifies** the signed token to display the target email
  and requires an explicit same-origin POST back to `/api/sso/consume` to
  actually establish the session — defeating login-CSRF / session fixation
  (`src/app/[locale]/(auth)/sso/confirm/page.tsx:8-22`). `export const dynamic =
  "force-dynamic"` (`:6`).
- Guard / who can access: None (public). The security control is the token
  re-verification + the trusted-origin-guarded POST, not a session.
- Access matrix: Visitor arriving from an enterprise app launch -> see: yes, act:
  yes (Continue / Cancel). Note: this route is classified `public`, not `auth`
  (`src/config/route-regions.ts:27-34`).
- Controls (verified against `src/app/[locale]/(auth)/sso/confirm/page.tsx`):
  - **Valid token:** heading "Confirm sign-in" (`sso.confirm.title`); body "You're
    about to sign in as {email}." with the email from the *re-verified* token
    (`:71-74`); a **Continue** submit button in a `method="post"` form to
    `/api/sso/consume` carrying a hidden `token` (`:78-90`); a **Cancel** link to
    `/sign-in` (`:91-97`).
  - **Missing/invalid token:** heading "Sign-in link invalid" (`sso.confirm.invalidTitle`),
    body `sso.confirm.invalidBody`, and a "Back to sign in" link
    (`:53-67`). The invalid state also triggers when `SSO_HANDOFF_AUDIENCE_PREFIX`
    / `SSO_HANDOFF_APPLICATION_ID` env are unset (`:25-27`) or verification throws
    (`:34-36`).
- Preconditions & test data: a valid SSO handoff token (produced by launching an
  enterprise app from the hub). `SSO_HANDOFF_AUDIENCE_PREFIX` and
  `SSO_HANDOFF_APPLICATION_ID` must be configured for the satellite. `TODO:
  verify` the exact launch steps and env values for a local end-to-end run.

User stories

- UAT-AUTH-SSO-CONFIRM-S1 — As a user handed off from another app, I want to see
  which account I'm signing in as and confirm it, so that I'm not silently signed
  into someone else's session.
  - Acceptance criteria: Given a valid handoff token, when the confirm page loads,
    then it shows "You're about to sign in as <email>" (email from the verified
    token) and a Continue button; clicking Continue POSTs to `/api/sso/consume`
    and establishes the session.
  - UAT script:
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | Launch an enterprise app from the hub, following the SSO handoff to the satellite | You land on `/en/sso/confirm?token=…` |
    | 2 | Read the interstitial | Heading "Confirm sign-in"; body "You're about to sign in as <your email>."; a "Continue" button and a "Cancel" link |
    | 3 | Verify the email shown matches your account | The address is your own (re-verified from the token, not a query param) |
    | 4 | Click "Continue" | A same-origin POST runs and you are signed in on the satellite |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

- UAT-AUTH-SSO-CONFIRM-S2 — As a user with a bad/expired handoff link, I want a
  clear invalid message, so that I can restart from the source app.
  - Acceptance criteria: Given a missing or invalid token, when the page loads,
    then no Continue form renders; instead the "Sign-in link invalid" message and
    a "Back to sign in" link (`src/app/[locale]/(auth)/sso/confirm/page.tsx:53-67`).
  - UAT script:
    | # | Step | Expected result |
    |---|---|---|
    | 1 | Open `/en/sso/confirm` with no `token` (or a tampered one) | Heading "Sign-in link invalid"; body explaining the link is invalid/expired; a "Back to sign in" link |
    | 2 | Click "Back to sign in" | You land on `/en/sign-in` |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______

Negative & edge cases

- Cancel: clicking "Cancel" navigates to `/sign-in` without consuming the token
  (`src/app/[locale]/(auth)/sso/confirm/page.tsx:91-97`). No session is created.
- Spoofed email: the displayed email comes only from re-verifying the signed token
  (`:33`), never a query param, so a foreign account cannot be made to look
  familiar. Assert you cannot change the shown email by editing the URL.
- Login-CSRF: because consumption requires a same-origin POST whose Origin the
  handler checks (`:75-90`), a cross-site page cannot auto-submit it on a
  victim's behalf. `TODO: verify` the POST handler's trusted-origin rejection
  (in `/api/sso/consume`) as a separate API-level check.
- Env misconfiguration: with `SSO_HANDOFF_*` unset, even a real token renders the
  invalid state (`:25-27`). Expected: graceful "invalid" screen, not an error.
- No form validation fields; the token is a hidden input.

Accessibility: the Continue control is a real submit `<button>`; Cancel / Back
are links; single `<h1>` per state; centered text layout is keyboard-navigable
with visible focus.
i18n: all strings from the `sso.confirm` namespace with the email interpolated
into `sso.confirm.body` (`src/app/[locale]/(auth)/sso/confirm/page.tsx:49`,
`:73`); run in `uk`.

---

## Coverage matrix (screens x personas)

Legend: **V** can view · **A** can act (has a meaningful action) · **route** =
this persona is *routed here* by the shell guard · **—** persona not the target
audience (but page still renders on direct navigation, since none of these pages
are gated).

| Screen | Visitor | Pending | Blocked | Member | Limited Admin | Org Admin | Superadmin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AUTH-LANDING | V/A | V/A | V/A | V/A | V/A | V/A | V/A |
| AUTH-ABOUT | V | V | V | V | V | V | V |
| AUTH-DOCS-PUBLIC | V | V | V | V | V | V | V |
| AUTH-LOGGED-OUT | V/A | V/A | V/A | V/A | V/A | V/A | V/A |
| AUTH-SIGNIN | V/A | V/A | V/A | V/A | V/A | V/A | V/A |
| AUTH-SIGNUP | V/A | V/A | V/A | V/A | V/A | V/A | V/A |
| AUTH-FORGOT | V/A | V/A | V/A | V/A | V/A | V/A | V/A |
| AUTH-RESET | V/A | V/A | V/A | V/A | V/A | V/A | V/A |
| AUTH-PENDING | V | V/A route | V | V | V | V | V |
| AUTH-BLOCKED | V | V | V/A route | V | V | V | V |
| AUTH-SSO-CONFIRM | V/A | V/A | V/A | V/A | V/A | V/A | V/A |

> There is no 404-not-403 assertion to make on this set: none of the public or
> auth screens are permission-gated, so no persona is denied access to any of
> them. The 404-not-403 invariant applies to the secure `/app/*` screens and is
> covered in those UAT sets. What *is* enforced here is status-based routing: the
> secure shell sends pending users to AUTH-PENDING and blocked users to
> AUTH-BLOCKED before any secure page renders.

## Coverage checklist

- [x] AUTH-LANDING — happy + negative + a11y/i18n
- [x] AUTH-ABOUT — view + edge (un-localized body) + a11y/i18n
- [x] AUTH-DOCS-PUBLIC — view + edge (un-localized body, distinct from `/app/docs`)
- [x] AUTH-LOGGED-OUT — via-flow + direct-nav + local-only-signout edge
- [x] AUTH-SIGNIN — happy + returnTo + wrong-password + validation + open-redirect + gate routing
- [x] AUTH-SIGNUP — happy (-> pending) + short-password + duplicate-email + validation
- [x] AUTH-FORGOT — happy + anti-enumeration + invalid-email + transport error
- [x] AUTH-RESET — happy + mismatch + no/invalid token + expired token + length
- [x] AUTH-PENDING — routed-here + cannot-bypass + generic-copy
- [x] AUTH-BLOCKED — routed-here + no-leak + fail-closed status
- [x] AUTH-SSO-CONFIRM — confirm-happy + invalid-token + cancel + spoof/CSRF notes

## Open TODO: verify items

1. **AUTH-ABOUT / AUTH-DOCS-PUBLIC copy is hard-coded English** (not from a
   message namespace) — confirm with product whether these placeholders should be
   localized (`src/app/[locale]/(public)/about/page.tsx:8-10`,
   `src/app/[locale]/(public)/docs/page.tsx:4-5`).
2. **Rate-limiting on sign-in / sign-up / forgot-password** — no client-side
   rate-limit handling is visible in the forms; verify whether Better Auth
   enforces limits server-side and how (if at all) they surface to the user.
3. **Sign-up duplicate-email message** — currently mapped to the generic
   `auth.unexpectedError`; confirm whether a specific "email already registered"
   message is desired (`src/components/auth/email-password-sign-up-form.tsx:50`).
4. **AUTH-PENDING no-membership sub-case** — confirm a provisioned user with zero
   active memberships lands on `/pending-approval`
   (`src/lib/auth-status.ts:72-73`).
5. **AUTH-BLOCKED corrupt-status sub-case** — confirm a deliberately corrupted DB
   status coerces to `deactivated` and routes to `/blocked`
   (`src/lib/auth-status.ts:48-52`).
6. **AUTH-SSO-CONFIRM end-to-end** — document the exact enterprise-app launch
   steps and the local `SSO_HANDOFF_AUDIENCE_PREFIX` / `SSO_HANDOFF_APPLICATION_ID`
   values needed, and verify the `/api/sso/consume` POST handler's trusted-origin
   rejection at the API layer.
