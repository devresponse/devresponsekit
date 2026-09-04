---
title: "Introduction"
description: "What this walkthrough covers, how it was captured, and the app map."
group: "1. Overview"
order: 0
captured: 2026-07-10
---
# DevResponseKit demo walkthrough

A screenshot-based tour of **https://demo.devresponse.ca**, captured 2026-07-10 at 1440×900 (light theme, English locale), signed in as an account that holds the full administrator-console permission set. Every screen has its own page embedding its screenshots. The images are produced by the repository's capture tooling, which is not part of the served help content; see the repository's CONTRIBUTING guide to regenerate them.

## App map

```
demo.devresponse.ca
├── /en ····························· public landing page
│   ├── /sign-in                      email/password + Google/Microsoft/GitHub
│   ├── /sign-up                      self-registration (policy-governed)
│   └── /forgot-password              reset-link request
└── /en/app ························· authenticated shell (sidebar + app switcher)
    ├── /dashboard                    default home
    ├── /workspace                    nested-shell demo section
    ├── /account                      overview · profile · preferences · security · API keys
    ├── /docs                         embedded docs viewer (13 documents)
    └── /administrator ·············· admin console
        ├── Identity:  users (list · detail · create)
        ├── Access:    roles (list · detail) · permissions · groups
        ├── Tenancy:   organizations (list + sign-up defaults · detail) · memberships
        ├── Apps:      enterprise applications
        ├── APIs:      API keys · MCP agents
        ├── Communication: email outbox · email templates
        └── Activity:  audit log
```

## Screens

| # | Screen | Route | Area | Doc |
|---|--------|-------|------|-----|
| 01 | Landing page | `/en` | public | [01-landing.md](01-landing.md) |
| 02 | Sign in | `/en/sign-in` | public | [02-sign-in.md](02-sign-in.md) |
| 03 | Sign up | `/en/sign-up` | public | [03-sign-up.md](03-sign-up.md) |
| 04 | Forgot password | `/en/forgot-password` | public | [04-forgot-password.md](04-forgot-password.md) |
| 10 | Dashboard | `/en/app/dashboard` | app | [10-dashboard.md](10-dashboard.md) |
| 11 | Workspace | `/en/app/workspace` | app | [11-workspace.md](11-workspace.md) |
| 12 | Account · Overview | `/en/app/account` | app | [12-account-overview.md](12-account-overview.md) |
| 13 | Account · Profile | `/en/app/account/profile` | app | [13-account-profile.md](13-account-profile.md) |
| 14 | Account · Preferences | `/en/app/account/preferences` | app | [14-account-preferences.md](14-account-preferences.md) |
| 15 | Account · Security | `/en/app/account/security` | app | [15-account-security.md](15-account-security.md) |
| 16 | Account · API keys | `/en/app/account/api-keys` | app | [16-account-api-keys.md](16-account-api-keys.md) |
| 17 | Docs catalog | `/en/app/docs` | app | [17-docs-catalog.md](17-docs-catalog.md) |
| 18 | Docs · Architecture | `/en/app/docs/architecture` | app | [18-docs-architecture.md](18-docs-architecture.md) |
| 30 | Admin · Overview | `/en/app/administrator` | admin | [30-admin-overview.md](30-admin-overview.md) |
| 31 | Admin · Users | `/en/app/administrator/users` | admin | [31-admin-users.md](31-admin-users.md) |
| 32 | Admin · User detail | `/en/app/administrator/users/{id}` | admin | [32-admin-user-detail.md](32-admin-user-detail.md) |
| 33 | Admin · Create user | `/en/app/administrator/users/new` | admin | [33-admin-user-create.md](33-admin-user-create.md) |
| 34 | Admin · Roles | `/en/app/administrator/roles` | admin | [34-admin-roles.md](34-admin-roles.md) |
| 35 | Admin · Role detail | `/en/app/administrator/roles/{id}` | admin | [35-admin-role-detail.md](35-admin-role-detail.md) |
| 36 | Admin · Permissions | `/en/app/administrator/permissions` | admin | [36-admin-permissions.md](36-admin-permissions.md) |
| 37 | Admin · Groups | `/en/app/administrator/groups` | admin | [37-admin-groups.md](37-admin-groups.md) |
| 38 | Admin · Organizations | `/en/app/administrator/organizations` | admin | [38-admin-organizations.md](38-admin-organizations.md) |
| 39 | Admin · Organization detail | `/en/app/administrator/organizations/{id}` | admin | [39-admin-org-detail.md](39-admin-org-detail.md) |
| 40 | Admin · Memberships | `/en/app/administrator/memberships` | admin | [40-admin-memberships.md](40-admin-memberships.md) |
| 41 | Admin · Enterprise apps | `/en/app/administrator/enterprise-apps` | admin | [41-admin-enterprise-apps.md](41-admin-enterprise-apps.md) |
| 42 | Admin · API keys | `/en/app/administrator/api-keys` | admin | [42-admin-api-keys.md](42-admin-api-keys.md) |
| 43 | Admin · MCP agents | `/en/app/administrator/agents` | admin | [43-admin-agents.md](43-admin-agents.md) |
| 44 | Admin · Email outbox | `/en/app/administrator/email` | admin | [44-admin-email-outbox.md](44-admin-email-outbox.md) |
| 45 | Admin · Email templates | `/en/app/administrator/email/templates` | admin | [45-admin-email-templates.md](45-admin-email-templates.md) |
| 46 | Admin · Audit log | `/en/app/administrator/audit` | admin | [46-admin-audit.md](46-admin-audit.md) |

30 screens, 41 screenshots (long pages have additional `--N` scrolled views).

## Deliberately skipped

- **Token-gated pages**: `/reset-password` and the invitation-accept flow need a live emailed token.
- **Create/editor forms beyond the captured representatives**: `roles/new`, `groups/new`, `organizations/new`, `enterprise-apps/new`, `api-keys/new`, and per-entity editor pages follow the same form pattern as [Create user](33-admin-user-create.md) and the captured detail pages.
- **Duplicate detail pages**: one representative user, role, and organization detail was captured; sibling rows render identically.
- **Mutating states**: nothing was created, edited, deleted, invited, impersonated, or toggled; the login form was the only form submitted. Dark theme and non-English locales were left uncaptured for consistency.
- **In-page tab states** (user detail's Roles/Sessions/… tabs, org detail's Providers/Authentication/Settings tabs, role detail's Members/Settings tabs): documented textually in each screen doc; only the default tab was photographed.

## Observations worth knowing

1. **Docs page TOC overlap at 1024px**: on `/en/app/docs/architecture`, the right-hand "On this page" list overlaps table text at this viewport width.
2. `/en/app/workspace/settings` 404s — the nested Workspace nav's "Settings" item is placeholder content, not a link.
3. During exploration, the Email outbox, Email templates, and Audit log pages appeared stuck on "Loading…" in one embedded-browser session, but all three render normally in a clean Chromium (the captures show the real content) — an environment quirk, not a site issue.
