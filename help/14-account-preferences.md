---
title: "Account · Preferences"
description: "Language, time zone, and formatting preferences."
group: "3. Application"
order: 14
route: /en/app/account/preferences
area: app
captured: 2026-07-10
---

# Account · Preferences

![Account preferences](screenshots/14-account-preferences.png)

## Purpose
Per-user localization and formatting preferences, persisted to the account (not just the browser).

## Key elements
- **Language** (required): English, French, Spanish, Ukrainian, Portuguese, Chinese (Simplified), Hindi, Japanese.
- **Time zone**: **System default** or any IANA zone. The System default option names the deployment's own zone, e.g. **System default (UTC)**: that is the zone you see times in until you pick one. It is not your browser's zone.
- **Date format**: System default (the language's own style), ISO 8601 (2026-06-13), US (06/13/2026), European (13/06/2026) or Long (June 13, 2026).
- **Number format**: System default (the language's own) or one of the supported locales, which sets the digit grouping and decimal mark.
- **Save changes** / **Cancel**.

## Actions available
- Save changes → persists the preferences and applies them at once:
  - A new **Language** moves you to the same page in that language (the address changes from `/en/…` to `/uk/…`). It also picks the language of your transactional emails.
  - **Time zone** and **Date format** apply to every date and time in the app: the Account overview, the Security page's sessions, the Administrator overview and every Administrator grid and detail panel. Pages rendered on the server and in the browser show the same time.
  - **Number format** applies to the Administrator overview's headline counts.

## Navigation
- Reached from: Account sub-navigation → Preferences.

## Access
Any signed-in user; self-scoped.

## Observations
The language list here matches the locale switcher in the brand bar. Both switch the page's language at once and store it. The language in the address wins: signing in on `/fr/sign-in` opens the app in French whatever language is stored here. The audit-event and outbox-message detail panels also show the raw stored timestamp (UTC, ending in `Z`); the grid row they open from shows the same moment in your zone.
