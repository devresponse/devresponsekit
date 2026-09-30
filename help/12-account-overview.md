---
title: "Account · Overview"
description: "Identity, memberships, roles, and the resolved permission list."
group: "3. Application"
order: 12
route: /en/app/account
area: app
captured: 2026-07-10
---

# Account · Overview

![Account overview](screenshots/12-account-overview.png)

![Account · Overview — permissions list, scrolled](screenshots/12-account-overview--2.png)

## Purpose
A read-only summary of the signed-in user's identity, organization memberships, roles, and the exact permission set those roles grant in the active organization.

## Key elements
- Account sub-navigation: Overview, Profile, Preferences, Security, API keys.
- **Identity** card: display name, email, status (Active), member-since date.
- **Organizations** list with membership status (Default Organization · Active for the seed admin).
- **Roles**: Administrator, Platform Administrator, Superuser (for the seed admin).
- **Permissions**: the full effective permission list — 39 keys for the seed admin, from `admin.apikeys.manage` through `superuser`, including the `shell.view` membership baseline.

- **Your data** card: a **Download my data (JSON)** link.

## Actions available
- **Download my data (JSON)** — downloads one JSON file with everything the platform holds about you: profile, organizations, roles, sign-in methods, sessions, API keys (never their secrets) and your activity in the audit log. Not offered while an administrator is impersonating you.
- Nothing else on this tab is editable; edits happen on the sibling tabs.

## Navigation
- Reached from: primary sidebar → Account.
- Leads to: Profile, Preferences, Security, API keys sub-pages.

## Access
Any signed-in user; content is self-scoped.

## Observations
The permission list is a genuinely useful debugging surface: it shows the resolved union of role grants, so permission questions ("why can't this user see X?") can be answered from the user's own account page.
