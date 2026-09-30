---
title: "Administrator · Audit log"
description: "Read-only log of administrator and authentication events."
group: "4. Administrator console"
order: 46
route: /en/app/administrator/audit
area: admin
requires: admin.audit.read
captured: 2026-09-29
---

# Administrator · Audit log

![Admin audit log](screenshots/46-admin-audit.png)

## Purpose
"Read-only paginated view of administrator and authentication events. Each row opens a panel with the full metadata, IP address, user agent, and reason."

## Key elements
- Filters: **Event type** (free text, e.g. `admin.user.banned`), **Outcome** (Any/…), and **Actor** (Better Auth user id).
- Table: Time, Event type, Outcome, Actor, Target — the capture shows the capture tool's own sign-ins (`auth.session.created`), the `admin.api_key.created` behind the [API keys](42-admin-api-keys.md) screenshot, and the fixture's back-dated history, all `success`.
- Row click → detail panel with full event metadata.

## Actions available
- Filtering and inspection only — the log is read-only by design.

## Navigation
- Reached from: admin sidebar (Activity → Audit log) or the primary sidebar's "Audit log" shortcut.

## Access
`admin.audit.read` (the permission catalog also carries a broader `audit.view` key).

## Observations
The same event stream feeds the "Daily audit events" chart on the admin overview. (Note: during exploration this page appeared stuck on "Loading…" in one embedded-browser session, but it renders normally in a clean browser — the capture above is the real state.)
