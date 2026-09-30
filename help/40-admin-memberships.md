---
title: "Administrator · Memberships"
description: "Every user-to-organization membership in one view."
group: "4. Administrator console"
order: 40
route: /en/app/administrator/memberships
area: admin
requires: admin.orgs.read
captured: 2026-09-29
---

# Administrator · Memberships

![Admin memberships](screenshots/40-admin-memberships.png)

## Purpose
A flat, cross-organization view of every user↔organization membership — the join table made browsable.

## Key elements
- Status filter: All / Active / Pending approval / Blocked / Suspended.
- Table: Organization, User, Status, Source (how the membership came to be, e.g. "email" sign-up), Created.
- Pagination controls.

## Actions available
- Filtering and sorting only — membership mutations happen on the organization detail or user detail pages.

## Navigation
- Reached from: admin sidebar (Tenancy → Memberships).

## Access
`admin.orgs.read`.

## Observations
Useful for answering "which org is this user in, and how did they get there?" across tenants without opening each organization. The capture shows the fixture data: a cross-organization member has one row per organization it belongs to.
