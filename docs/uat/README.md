---
title: "UAT — Overview & index"
description: The user-acceptance-testing story set — screen-by-screen user stories with runnable test scripts, organized by area, for real testers.
group: QA
visibility: internal
order: 5
---

# UAT — User Acceptance Testing

This is the **user-acceptance-testing (UAT) story set**: screen-by-screen user stories, each with a plain-language, numbered **test script a real (non-technical) tester can run**, plus a per-screen access matrix, negative/edge cases, accessibility, and i18n notes. It doubles as **living documentation** of every screen.

Generated from the reusable prompt in [`GENERATION-PROMPT.md`](./GENERATION-PROMPT.md), validated against the code (every claim cites `file:line`). **155 stories** across 40+ screens plus 10 end-to-end journeys.

## The story documents

| Area | Covers | Stories |
| --- | --- | --- |
| [Public & Auth](./public-auth.md) | landing, about, docs; sign-in/up, verify-email, forgot/reset, pending/blocked, SSO confirm | 23 |
| [Account & secure shell](./account.md) | app entry, dashboard, workspace, account (+ profile/preferences/security/api-keys), docs viewer | 21 |
| [Administrator: Users](./administrator-users.md) | console overview, users list/new/detail + its 6 tabs | 27 |
| [Administrator: Roles, Groups & Permissions](./administrator-roles-groups-permissions.md) | roles, groups (+ tabs), the permission catalog | 28 |
| [Administrator: Organizations & Memberships](./administrator-orgs-memberships.md) | orgs list/new/detail, cross-org memberships | 16 |
| [Administrator: Apps, Email, API Keys & Audit](./administrator-apps-email-apikeys-audit.md) | enterprise apps, email outbox/templates, API keys, audit log | 30 |
| [End-to-end journeys](./journeys.md) | 10 multi-screen flows (onboarding, group-grant, impersonation, SSO, API-key lifecycle, …) | 10 |

Each area doc carries its own screen × persona coverage matrix and checklist. Machine-readable rows for a test tracker are in [`uat-stories.csv`](./uat-stories.csv).

## Personas (a tester is assigned one)

| Persona | Seed role / state | Scope |
| --- | --- | --- |
| **Visitor** | unauthenticated | public pages + sign-in/up |
| **Pending user** | signed up, `pending_approval` | only the pending-approval screen |
| **Blocked user** | `blocked` / `suspended` | only the blocked screen |
| **Member** | `member` (USER) | secure-shell self-service; no admin |
| **Limited Admin** | `admin` | a subset of `admin.*` (partial-permission gating) |
| **Org Admin** | `admin.platform` | full `admin.*` within **one** org |
| **Superadmin** | `superuser` | every org; the only persona that can create/delete orgs + the global catalogs |
| **Impersonator** | admin impersonating a target | acts as the target; "Stop" returns to admin |

## Test environment & accounts

- **Seed:** `pnpm db:seed:dev` builds the multi-org dev fixture; the shared password is `DevPassword123!`. **Never run `db:seed:dev` against production.**
- **Base URL:** local `http://localhost:3000` (or your deployed URL). Every route is **locale-prefixed** — e.g. `/en/app/administrator/users`.
- **Persona → account:** personas map to the seed roles `superuser` / `admin.platform` / `admin` / `member`. See `src/db/seeds/dev-init.ts` for the exact accounts and their org assignments (the authoritative source).
- **Setup caveats surfaced during generation** (see each area doc's TODO list): the plain `admin` role (Limited Admin) is conferred via a group rather than a direct assignment; and a few personas — an `admin`-only login, a read-only-in-one-area role, and pending/blocked accounts — may need a role assigned or a user created manually before their stories can run.
- **Locale:** run each story in `en` plus one non-Latin locale (e.g. `ja` or `uk`) to confirm localization; a raw message key on screen is a failure.
- **Visibility note:** these UAT docs are `visibility: internal`, so they appear in the in-app `/app/docs` viewer only when `DOCS_INTERNAL_VISIBLE=true`.

## How to run

Pick a persona, sign in, open the relevant area doc, and follow each numbered step — recording **Pass / Fail** in the story's result row. Import `uat-stories.csv` into your test-management tool (Xray / TestRail / Zephyr / a spreadsheet) to assign runs and track results. When a screen changes, re-run the prompt in `GENERATION-PROMPT.md` for that area to refresh its stories.
