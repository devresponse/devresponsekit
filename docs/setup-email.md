# Email — Setup & Provider Integration Guide

This document is the canonical guide for the **devresponsekit** email
subsystem: how outbound email is rendered and recorded, how to plug in a
third-party delivery provider (Resend or Mailgun), how to edit templates,
and how to add a new provider. It is the operational companion to
[specs.md §35](../specs.md#35-email-subsystem).

All file paths and commands referenced below correspond to actual
artifacts in this repository.

---

## Table of Contents

1. [Architecture: outbox-first](#1-architecture-outbox-first)
2. [Data model](#2-data-model)
3. [Configuration](#3-configuration)
   - [Resend](#31-resend)
   - [Mailgun](#32-mailgun)
4. [Flows](#4-flows)
5. [The administrator Email workspace](#5-the-administrator-email-workspace)
6. [Editing templates](#6-editing-templates)
7. [Adding a new provider](#7-adding-a-new-provider)
8. [Local development & CI](#8-local-development--ci)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Architecture: outbox-first

Every outbound email is **rendered and recorded in `app_outbox` before
any delivery attempt**. This makes the outbox a complete, inspectable
record of what the system tried to send — independent of whether a
delivery provider is configured or whether delivery succeeded.

```
sendAppEmail(input)
  │
  ├─ resolve recipient locale (input → app user preferred_locale → default)
  ├─ resolve template          (DB row for locale → DB row for default → code default)
  ├─ render subject + bodies   (HTML-escaping variable VALUES in HTML mode)
  ├─ INSERT app_outbox         (status: 'pending' if provider else 'logged')
  │
  └─ provider configured?
       ├─ no  → done (status stays 'logged')
       └─ yes → provider.deliver()
                  ├─ ok    → UPDATE status='sent',  provider_message_id, sent_at
                  └─ throw → UPDATE status='failed', error      (NEVER re-thrown)
```

Delivery failures are **recorded, not thrown**: a password-reset request
must not return a 500 because a third-party API had a transient error.
Operators watch the outbox (and the audit log) for `failed` rows.

The sender lives in
[`src/lib/email/send.server.ts`](../src/lib/email/send.server.ts);
providers in
[`src/lib/email/providers.server.ts`](../src/lib/email/providers.server.ts);
templates + renderer in
[`src/lib/email/templates.ts`](../src/lib/email/templates.ts).

---

## 2. Data model

The consolidated initial schema
[`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql)
includes the two email tables (along with every other application table):

- **`app_email_templates`** — editable templates, unique on
  `(key, locale)`. Seeded with the built-in defaults. The runtime falls
  back to the code-level defaults in `templates.ts` when no row matches,
  so deleting or breaking a row can never block a flow.
- **`app_outbox`** — one row per outbound email. `status` is one of
  `pending`, `sent`, `failed`, `logged`.

It also defines the `admin.email.read` / `admin.email.manage` permissions
and grants the full catalog to the `superuser` role.

A first-time setup applies it with (no separate email migration needed):

```bash
pnpm db:app:migrate
```

---

## 3. Configuration

All email configuration is validated in
[`src/lib/env.ts`](../src/lib/env.ts). A provider selected without its
credentials **fails at boot**, not at first send.

| Variable | Purpose |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` \| `mailgun` \| unset (no delivery → `logged`) |
| `EMAIL_FROM` | From header, e.g. `App <no-reply@example.com>` |
| `RESEND_API_KEY` | Required when `EMAIL_PROVIDER=resend` |
| `MAILGUN_API_KEY` | Required when `EMAIL_PROVIDER=mailgun` |
| `MAILGUN_DOMAIN` | Required when `EMAIL_PROVIDER=mailgun` |
| `MAILGUN_BASE_URL` | Defaults to `https://api.mailgun.net`; use `https://api.eu.mailgun.net` for the EU region |

With **no `EMAIL_PROVIDER` set**, every flow still works end to end —
emails are rendered and recorded with status `logged`. This is the
default for local development and CI.

### 3.1 Resend

1. Create an API key at <https://resend.com/api-keys>.
2. Verify your sending domain at <https://resend.com/domains> and set
   `EMAIL_FROM` to an address on it.
3. Configure:

   ```bash
   EMAIL_PROVIDER="resend"
   EMAIL_FROM="DevResponse <no-reply@yourdomain.com>"
   RESEND_API_KEY="re_xxxxxxxx"
   ```

The integration posts to `https://api.resend.com/emails`
([API reference](https://resend.com/docs/api-reference/emails/send-email)).

### 3.2 Mailgun

1. Create a sending API key in the Mailgun dashboard.
2. Add and verify your domain; note whether it is in the US or EU region.
3. Configure:

   ```bash
   EMAIL_PROVIDER="mailgun"
   EMAIL_FROM="DevResponse <no-reply@mg.yourdomain.com>"
   MAILGUN_API_KEY="key-xxxxxxxx"
   MAILGUN_DOMAIN="mg.yourdomain.com"
   # EU region only:
   # MAILGUN_BASE_URL="https://api.eu.mailgun.net"
   ```

The integration posts (form-encoded, HTTP Basic `api:<key>`) to
`${MAILGUN_BASE_URL}/v3/${MAILGUN_DOMAIN}/messages`
([API reference](https://documentation.mailgun.com/docs/mailgun/api-reference/send/)).

---

## 4. Flows

| Flow | Trigger | Template |
| --- | --- | --- |
| Password reset (self-service) | `/[locale]/forgot-password` form | `password_reset` |
| Password reset (admin-initiated) | Admin user detail → "send reset email" (`/api/administrator/users/[id]/password`, mode `reset_email`) | `password_reset` |
| Test email | Email workspace → "send test email" (`/api/administrator/email/test`) | `test_email` |

The password-reset flows are wired through Better Auth's
`sendResetPassword` callback in
[`src/lib/auth.ts`](../src/lib/auth.ts), which calls `sendAppEmail`. The
emailed link lands on `/[locale]/reset-password?token=…`; Better Auth
validates the one-time, short-lived token when the new password is
submitted.

---

## 5. The administrator Email workspace

Under `/[locale]/app/administrator/email`:

- **Outbox** (`admin.email.read`) — paginated grid over `app_outbox`
  with status/template filters and a per-row detail sheet. Bodies are
  shown as text (never `dangerouslySetInnerHTML`). The "send test email"
  toolbar action requires `admin.email.manage` and is the fastest way to
  confirm a provider is wired correctly.
- **Templates** (`admin.email.read`; editing requires
  `admin.email.manage`) — list and standard edit page.

---

## 6. Editing templates

Templates use `{{variable}}` placeholders. At send time:

- In the **HTML body**, variable VALUES are HTML-escaped, so
  user-controlled values (display names, emails) can never inject markup.
  Reset URLs are generated by Better Auth and survive escaping inside
  `href="…"`.
- In the **text body** and **subject**, values are substituted verbatim.
- Unknown placeholders are left as-is (`{{typo}}`) so a mistake is
  visible in the outbox rather than silently dropped.

`key` and `locale` are immutable — flows send against the key, so
renaming would silently detach the flow from its template. To support a
new locale for a template, insert a new `(key, locale)` row.

Built-in template defaults and their declared variables live in
[`templates.ts`](../src/lib/email/templates.ts) (`DEFAULT_EMAIL_TEMPLATES`).
Keep them in sync with the seeded defaults in
[`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql).

---

## 7. Adding a new provider

1. Implement the `EmailProvider` interface in
   [`providers.server.ts`](../src/lib/email/providers.server.ts) — a
   single `deliver(email)` method returning `{ providerMessageId? }` and
   throwing on a non-OK response.
2. Add its env vars to [`env.ts`](../src/lib/env.ts) and extend the
   `EMAIL_PROVIDER` enum; add a `superRefine` check so missing
   credentials fail at boot.
3. Wire it into `getConfiguredEmailProvider()`.
4. Document the new vars in `.env.example` and §3 above.

No other code changes are needed — `sendAppEmail` is provider-agnostic.

---

## 8. Local development & CI

Neither local dev nor CI configures a provider, so emails are recorded as
`logged` and never sent. This keeps tests hermetic and inspectable:

- The unit tests
  ([`tests/unit/email-templates.test.ts`](../tests/unit/email-templates.test.ts),
  [`tests/unit/email-send.test.ts`](../tests/unit/email-send.test.ts))
  cover rendering/escaping and the status lifecycle.
- The integration tests
  ([`tests/integration/administrator-email.test.ts`](../tests/integration/administrator-email.test.ts))
  cover the API guards.
- The e2e test
  ([`tests/e2e/email-outbox.spec.ts`](../tests/e2e/email-outbox.spec.ts))
  exercises the full password-reset round trip: form → outbox →
  emailed link → new password.

---

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| App fails to boot: "Invalid server environment variables: RESEND_API_KEY" | `EMAIL_PROVIDER=resend` set without `RESEND_API_KEY` (the boot-time guard). |
| Outbox rows are all `logged`, nothing delivered | No `EMAIL_PROVIDER` configured — expected in dev/CI. |
| Outbox rows are `failed` | Delivery threw; the `error` column holds the provider response (truncated to 500 chars). Check the API key, domain verification, and region (`MAILGUN_BASE_URL`). |
| Reset email never arrives but the row is `sent` | Delivery succeeded at the provider — check the provider's own logs / spam folder. |
| `{{variable}}` appears literally in a received email | The template references a variable the flow does not provide; check `DEFAULT_EMAIL_TEMPLATES[*].variables`. |
