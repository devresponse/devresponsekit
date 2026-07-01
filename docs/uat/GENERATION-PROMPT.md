---
title: UAT User-Story Generation Prompt
description: A reusable prompt that drives generation of the full, screen-by-screen UAT user-story set — executable by real testers and doubling as living documentation.
group: QA
visibility: internal
order: 90
---

# UAT User-Story Generation Prompt

This file is a **reusable prompt**. Hand it to an AI coding agent (or follow it yourself) to generate the complete, screen-by-screen **User Acceptance Testing** story set under `docs/uat/`. It is intentionally grounded in this application's actual routes, roles, and conventions. Keep it in sync with the app: when a screen is added, add it to the inventory below.

---

## Your role & goal

You are a QA + product-documentation author. Produce a **complete, screen-by-screen set of user stories** for **User Acceptance Testing (UAT)** of the DevResponseKit application. The output is **dual-purpose**:

1. **Testable by real, non-technical users** — every story includes a plain-language, numbered test script with concrete expected results.
2. **Living documentation** — the set is organized to **follow every screen**, so a reader learns what each screen is, who can use it, and what it does.

**Hard rule: validate every statement against the code before writing it.** Read the relevant `page.tsx`, its guard, its components, and the API route it calls. Cite `file:line`. Never invent a button, field, permission, or behavior — if you cannot verify it, write `TODO: verify`.

## The application (grounding)

DevResponseKit is a multi-tenant, security-first **enterprise application shell**: Next.js 16 (App Router, React 19), Better Auth, PostgreSQL + Kysely, next-intl (8 locales: `en`, `es`, `fr`, `hi`, `ja`, `pt`, `uk`, `zh`). Core concepts the stories must reflect:

- **Three-tier RBAC** (see `docs/architecture.md`, "Access-control design decisions"): **SUPERADMIN** (holds the `superuser` marker → all orgs), **ORG ADMIN** (holds `admin.*`, no marker → their single org only), **USER** (no `admin.*`). A user's permissions = **direct roles ∪ group-conferred roles** in their active org.
- **404-not-403 invariant**: an out-of-scope resource returns **Not Found**, never Forbidden — cross-tenant existence is never leaked. Test this.
- **Permission-gated everything**: each admin screen requires a specific `admin.*.read` / `.manage` / `.assign` key; the nav only surfaces links the user can actually open. (A real bug was a nav link that 404'd because its gate did not match the page guard — your stories must catch that class of issue, per screen and per role.)
- Surrounding capabilities: **groups** (cohorts that bundle roles), **cross-subdomain SSO handoff**, a versioned **machine API** (`/api/v1`, API keys + EdDSA JWTs), **audit logging**, **outbox-first email**, **impersonation**.

## Personas (real testers are assigned one)

Define each story's actor as one of these. Map each to a seed role (`superuser`, `admin.platform`, `admin`, `member` — see `src/db/seeds/`) and state its access.

| Persona | Seed role / state | Can do |
| --- | --- | --- |
| **Visitor** | unauthenticated | public pages, sign-in/up |
| **Pending user** | signed up, `pending_approval` | only the pending-approval screen |
| **Blocked user** | `blocked` / `suspended` | only the blocked screen |
| **Member** | `member` (USER) | secure-shell self-service (dashboard, workspace, account, docs) — no admin |
| **Org Admin** | `admin.platform` | full `admin.*` **within one org**; sees only their org's data |
| **Limited Admin** | `admin` | a subset of `admin.*` (for testing partial-permission gating) |
| **Superadmin** | `superuser` | every org; the only persona that can create/delete orgs and the global catalogs |
| **Impersonator** | admin impersonating a target | acts as the target; "Stop impersonating" returns to admin |
| **(Optional) Machine client** | API key / JWT | the `/api/v1` surface (cover separately if API testing is in scope) |

## The screen inventory (the definition of "every screen")

This is the source of truth for coverage. Verify it against `src/app/[locale]/**/page.tsx` and flag any additions. Cover each **route** AND its **sub-screens** (tabs, dialogs, grid states).

- **Public:** `/` (landing) · `/about` · `/docs` (public docs) · `/logged-out`
- **Auth:** `/sign-in` · `/sign-up` · `/forgot-password` · `/reset-password` · `/pending-approval` · `/blocked` · `/sso/confirm`
- **Secure shell:** `/app` (entry) · `/app/dashboard` · `/app/workspace`
- **Account:** `/app/account` (overview) · `/profile` · `/preferences` · `/security` · `/api-keys`
- **Docs viewer:** `/app/docs` (landing) · `/app/docs/[...slug]` (article)
- **Administrator console:** `/app/administrator` (overview) · `users` (+ `/new`, `/[userId]`) · `roles` (+ `/new`, `/[roleId]`) · `groups` (+ `/new`, `/[groupId]`) · `permissions` (+ `/new`) · `organizations` (+ `/new`, `/[orgId]`) · `memberships` · `enterprise-apps` (+ `/new`, `/[appId]`) · `email` outbox (+ `/templates`, `/templates/[templateId]`) · `api-keys` (+ `/new`) · `audit`

**Sub-screens you must also cover:**

- **User detail tabs:** Overview · Roles (assign/remove) · Groups (add/remove) · Memberships · Sessions (revoke) · Audit.
- **Group detail tabs:** Roles editor · Members (add/remove) · Settings.
- **Shared data-grid affordances** (every list screen): search, column sort, filters, pagination, bulk actions, CSV export, the row-action menu.
- **Dialogs / pickers:** assign-role, add-to-group, add-member, create / confirm-delete, impersonate, send-test-email.
- **Cross-cutting UI states:** empty list, loading skeleton, inline error (`role="alert"`), the 404 / 403 / error boundaries, and required-field markers (the `*`).

## Per-screen output template (use verbatim for every screen)

```
### <SCREEN-ID> — <Screen name>
- Route: <route>  ·  Example URL: /en<route>  ·  Code: <page.tsx file:line>
- Purpose: <1-2 sentences>
- Guard / who can access: <permission key or session requirement, from the page guard>
- Access matrix: Visitor / Pending / Member / Limited Admin / Org Admin / Superadmin -> can see? can act?
- Preconditions & test data: <accounts, seed data, locale, anything that must exist first>

User stories
- <SCREEN-ID>-S1 — As a <persona>, I want <goal>, so that <benefit>.
  - Acceptance criteria: Given <state>, when <action>, then <observable result>. (one or more)
  - UAT script (a real user can run this):
    | # | Step (what to do) | Expected result |
    |---|---|---|
    | 1 | ... | ... |
  - Result: [ ] Pass  [ ] Fail  — Notes: ______
- (repeat S2, S3... for each distinct goal/persona on this screen)

Negative & edge cases (each a short numbered check)
- Out-of-scope access -> Not Found (cross-tenant; verify it is 404, not 403).
- Validation errors (each required field; the `*` marker appears; error border + localized message).
- Empty state / loading skeleton / inline error.
- Rate-limit (admin mutations) -> friendly message; bulk/export limits.
- Concurrency / stale If-Match where applicable.

Accessibility: keyboard-only path, visible focus, labelled controls, dialog focus-trap + Esc, no axe violations.
i18n: run in `en` + one non-Latin locale (e.g. `ja` or `uk`); no raw message keys; dates/labels localize.
```

## Cross-cutting end-to-end journeys (multi-screen — write each as its own story)

Each walks several screens; give one combined UAT script:

1. **Onboarding:** sign-up → `pending-approval` → admin approves the user (Users → user detail) → user signs in → lands on `dashboard`.
2. **Grant access via a group:** Org Admin creates a group → bundles a role (Group → Roles) → adds the user (Group → Members **or** User → Groups) → the user gains the capability and the matching nav link **opens** (no 404). _(Make the "the link must open, not 404" assertion explicit — this is the exact real-world flow that previously broke.)_
3. **Direct role assignment:** assign/remove a role on the User → Roles tab; confirm effective permissions change.
4. **Impersonation:** admin impersonates a user → acts with the target's permissions → "Stop" returns to admin (reloads to `/app`).
5. **SSO handoff:** launch an enterprise app from the hub → consume on the satellite (`/sso/confirm`) → land signed in.
6. **API key lifecycle:** create a key (Account → API keys, or Admin → API keys) → call `/api/v1/me` with it → rotate → revoke → confirm it is rejected.
7. **Password reset:** forgot-password → email (check the outbox) → reset-password → sign-in.
8. **Org lifecycle (Superadmin):** create org → add members → assign roles → confirm an Org Admin of that org sees only it.
9. **Email:** edit a template (incl. a non-English locale) → send a test → view it in the outbox.
10. **Locale switch:** change preferred locale in Preferences → the UI and the next email localize.

## Coverage rules (definition of done)

- **Every** route in the inventory has ≥1 story; **every gated screen** has a story for a persona who _can_ and one for a persona who _cannot_ (asserting 404-not-403).
- Each screen: ≥1 happy path + ≥1 negative path; empty / loading / error states; required-field validation; a11y + i18n notes.
- The 10 journeys are all covered.
- Produce a final **coverage matrix** (screens × personas) and a checklist confirming each inventory item is done; list any `TODO: verify` items.

## Deliverable shape

- Write Markdown under `docs/uat/` — a master `README.md` index plus one file per area (e.g. `public-auth.md`, `account.md`, `administrator-users.md`, `administrator-roles-groups-permissions.md`, `administrator-orgs-memberships.md`, `administrator-apps-email-apikeys-audit.md`, `journeys.md`). Add YAML frontmatter (`title`, `description`, `group: QA`, `visibility: internal`) so the in-app `/app/docs` viewer picks them up but keeps them maintainer-only.
- **Lychee-safe links:** every relative link + `#anchor` must resolve, and the CI link check resolves **bare** relative links too. Avoid `·` / `&` / `—` in headings you link to — they slug to fragile multi-hyphen anchors. Prefer inline code over links for file paths so there is nothing to rot.
- Give every story a **stable ID** (`UAT-<AREA>-<SCREEN>-Sn`) for a test-management tool.
- Also emit a flat **CSV** (`docs/uat/uat-stories.csv`: `id, area, screen, persona, story, steps, expected, status`) for import into a UAT tracker.
- Open with a **"Test environment & accounts"** section: how to seed the personas (`pnpm db:seed` / the dev fixture), credentials per persona, how to reset, the base URL, and the locale to test.

## Style for the test scripts

Plain language a non-technical tester can follow; imperative steps ("Click **Add member**"); concrete expected results (exact button/label text, the resulting status badge, the toast or inline message); one assertion per step; each story independently runnable from its preconditions. Mark every assumption.

## Process

Work screen-by-screen in inventory order. For each: read the `page.tsx` + its guard + components + the API route, then write the section. Keep a running coverage checklist. Validate links/anchors before finishing (mirror the CI: resolve every relative link + `#anchor`). End with the coverage matrix and the list of `TODO: verify` items.
