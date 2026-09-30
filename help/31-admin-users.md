---
title: "Administrator · Users"
description: "Browse, filter, export, and open every user account."
group: "4. Administrator console"
order: 31
route: /en/app/administrator/users
area: admin
requires: admin.users.read
captured: 2026-09-29
---

# Administrator · Users

![Admin users list](screenshots/31-admin-users.png)

## Purpose
Platform-wide user management: browse, filter, export, and open every user account.

## Key elements
- Status filter: All / Active / Pending approval / Blocked / Suspended / Deactivated.
- **Bulk actions** menu and **Export CSV**.
- **New user** button → [create form](33-admin-user-create.md).
- Sortable table: Email, Name, Organization, Status, Created; rows link to the [user detail page](32-admin-user-detail.md).
- Pagination with selectable page size (10/25/50/100).

## Actions available
- Filter/sort/paginate the list; export to CSV; open a user; create a user; apply bulk actions to selected rows.

## Navigation
- Reached from: admin sidebar (Identity → Users) or the primary sidebar's "Users" shortcut.
- Leads to: user detail pages, user creation form.

## Access
`admin.users.read` to view; mutating actions map to the finer-grained `admin.users.*` permissions.

## Observations
The capture shows the synthetic seed data (`pnpm db:seed` plus `pnpm db:seed:dev`): 25 active users across the Default Organization and three fixture organizations, with the cross-organization members listing all three.
