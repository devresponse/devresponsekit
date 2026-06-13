# External API & CLI Integration Guide

> **Audience:** engineers building external command-line tools, scripts,
> or service integrations that drive authentication and administration of
> a **devresponsekit** deployment over HTTP.
>
> **Scope:** every externally reachable HTTP route that participates in
> auth or admin management, the authentication/authorization model those
> routes enforce, the request/response contracts a CLI must implement,
> and the security implications of building such tooling.
>
> This document describes the routes **as implemented** in
> `src/app/api/**` and the guard pipeline in `src/lib/**`. Where a route
> is owned by the Better Auth library, the exact path set is
> version-dependent — regenerate it with `pnpm db:auth:generate` and
> consult the [Better Auth docs](https://www.better-auth.com/docs).

---

## Table of contents

1. [The most important fact: two ways to authenticate](#1-the-most-important-fact-two-ways-to-authenticate)
2. [Authentication & authorization model](#2-authentication--authorization-model)
3. [Route surface overview](#3-route-surface-overview)
4. [Better Auth endpoints (`/api/auth/*`)](#4-better-auth-endpoints-apiauth)
5. [Administrator API (`/api/administrator/*`)](#5-administrator-api-apiadministrator)
6. [Account self-service API (`/api/account/*`, `/api/preferences/*`)](#6-account-self-service-api)
7. [SSO handoff API (`/api/sso/*`)](#7-sso-handoff-api-apisso)
8. [Navigation API (`/api/navigation/*`)](#8-navigation-api-apinavigation)
9. [Permission catalog](#9-permission-catalog)
10. [Shared contracts (pagination, filtering, errors)](#10-shared-contracts)
11. [Building a CLI: end-to-end recipe](#11-building-a-cli-end-to-end-recipe)
12. [Security implications of CLIs, API keys & secrets](#12-security-implications-of-clis-api-keys--secrets)

---

## 1. The most important fact: two ways to authenticate

There are **two** distinct ways to call this application over HTTP, and
which one you use determines almost everything else.

**1. Browser-style session cookies (the legacy/auth surface).** The
Better Auth instance in [`src/lib/auth.ts`](../src/lib/auth.ts) uses the
`admin()`, `ssoSession()`, and `nextCookies()` plugins — there is **no**
Better Auth `apiKey()` / `bearer()` / JWT plugin. So the `/api/auth/*`,
`/api/administrator/*`, `/api/account/*`, `/api/sso/*`, and
`/api/navigation/*` routes covered in §4–§8 are authenticated **only** by
a Better Auth **session cookie**, and a CLI hitting them must log in like
a browser (POST credentials to the sign-in endpoint, capture the cookie,
replay it, and satisfy the CSRF origin check on mutations — see §2.4).

**2. Machine credentials (the versioned `/api/v1` surface).** There
**is** now a first-class machine-credential API — added after this guide
was first written — under `/api/v1`. It accepts:

- **API keys**: `Authorization: Bearer drk_…` (stored only as a SHA-256
  hash; created/rotated via `/api/v1/me/api-keys` and the admin routes),
- **Ed25519 JWT access tokens**: minted at `POST /api/v1/auth/token`
  (OAuth2 `client_credentials` or an `api_key` grant), verifiable against
  the JWKS at `GET /api/v1/jwks.json`.

It is implemented with `jose` and the helpers in
[`src/lib/api-auth/`](../src/lib/api-auth) (not a Better Auth plugin), and
it ships **disabled by default** — enable per environment with
`API_KEYS_ENABLED` / `API_JWT_ENABLED`. A credential's effective
authority is its **scopes ∩ its owner's permissions**, so it can never
exceed its owner. **If you are building a machine integration, use this
surface** — the full contract (endpoints, scopes, token format, error
model) is documented in
[`docs/design-api-keys-and-tokens.md`](design-api-keys-and-tokens.md) and
exposed as an OpenAPI document at `GET /api/v1/openapi.json`. The rest of
this guide (§4–§8) covers the cookie-authenticated surface.

---

## 2. Authentication & authorization model

### 2.1 Identity vs. profile vs. authorization

Three layers cooperate (see
[`docs/setup-better-auth.md`](setup-better-auth.md) §2):

| Layer | Owner | Tables | Carries |
| --- | --- | --- | --- |
| **Identity** | Better Auth | `user`, `account`, `session`, `verification` | credentials, sessions, the Better Auth `role` (`user`/`admin`) and `banned` flag |
| **Profile** | App (Kysely) | `app_users` | application `status`, display name, locale; linked by `better_auth_user_id` |
| **Authorization** | App (Kysely) | `app_roles`, `app_permissions`, `app_role_permissions`, `app_user_roles`, `app_organization_memberships` | the **permission catalog** that gates every admin route |

A request is admitted to an admin route only when **all three** agree:
a valid session (identity), an `active` app user + `active` membership
(profile), and the specific `admin.*` permission (authorization). The
resolution logic lives in
[`getUserAccessContext`](../src/lib/auth-status.ts) and
[`decideSecureAccess`](../src/lib/auth-status.ts).

### 2.2 The admin guard pipeline

Every `/api/administrator/*` handler begins with
[`requireAdminPermission(request, perm)`](../src/lib/admin/permissions.server.ts),
which runs **in this order** and fails closed at the first miss:

1. **Origin guard** (unsafe methods only) → `403 untrusted_origin`
2. **Session resolution** (cookie) → `401 unauthenticated`
3. **Status/membership decision** → `403 forbidden`
4. **Permission match** → `403 forbidden` **plus an audited `denied` row**

On success it returns `{ betterAuthUserId, access, requestId }`. Note the
origin guard runs *before* the database is touched, so an unauthenticated
cross-origin probe cannot even trigger a session lookup.

### 2.3 Sessions

- Configured in [`src/lib/auth.ts`](../src/lib/auth.ts): **8-hour rolling
  expiry, refreshed every 15 minutes of activity**
  (`session.expiresIn = 60*60*8`, `session.updateAge = 60*15`).
- There is **no "remember me"** and no refresh-token exchange. When the
  cookie expires the CLI must sign in again.
- Sign-out is **local per origin** — it clears the cookie on the calling
  host only.

### 2.4 Origin / CSRF guard

[`checkTrustedOrigin`](../src/lib/admin/origin-guard.server.ts) rejects any
`POST/PATCH/PUT/DELETE` whose `Origin` (or, failing that, `Referer`)
header does not normalize to an entry in the trusted-origin allow-list.
The allow-list ([`getTrustedOrigins`](../src/lib/trusted-origins.ts)) is the
union of `NEXT_PUBLIC_APP_URL`, `BETTER_AUTH_URL`, and the comma-separated
`ADMIN_TRUSTED_ORIGINS`. The same list feeds Better Auth's own
`trustedOrigins`, so the two layers cannot drift.

**Practical CLI consequence:** a non-browser client must explicitly set an
`Origin` header matching the deployment, e.g. `Origin: https://app.devresponse.com`,
on every mutating request. Requests with neither `Origin` nor `Referer`
are rejected (a real browser always sends one). The check is skipped under
`NODE_ENV=test`/`development`, so it bites only against staging/production.

### 2.5 Rate limiting

Two independent limiters apply:

- **Better Auth** rate-limits sensitive auth endpoints in production
  (e.g. `/sign-in/email` ≈ 3 requests / 10 s per IP). The test-only env
  flag `AUTH_RATE_LIMIT_DISABLED=1` disables it — **never set in prod**.
- **Admin mutations** use an in-memory per-actor token bucket
  ([`enforceRateLimit`](../src/lib/admin/rate-limit.server.ts)) with a
  tighter budget on the bulk endpoint. A throttled call returns `429`.

A CLI must back off on `429` and avoid tight loops (use the bulk endpoint
instead of N single calls — see [§5.4](#54-users-routes)).

---

## 3. Route surface overview

| Group | Base path | Auth | Purpose |
| --- | --- | --- | --- |
| Better Auth | `/api/auth/*` | varies (public sign-in → session) | sign-in/up/out, session, password reset, social callbacks, **Better Auth admin plugin** |
| Administrator | `/api/administrator/*` | session + `admin.*` permission | the supported admin management surface |
| Account | `/api/account/*` | session (self-scoped) | the caller's own profile/preferences |
| Preferences | `/api/preferences/locale` | session | persist preferred locale |
| SSO | `/api/sso/{launch,consume}` | session (launch) / token (consume) | cross-subdomain handoff |
| Navigation | `/api/navigation/*` | session + active access | menu data for the shell |

All routes are **not** localized (no `/[locale]` segment). All admin and
account routes declare `export const dynamic = "force-dynamic"` (never
cached). API routes return JSON status codes and **never redirect**
(except SSO, which is redirect-based by design).

---

## 4. Better Auth endpoints (`/api/auth/*`)

Mounted by the catch-all
[`src/app/api/auth/[...all]/route.ts`](../src/app/api/auth/[...all]/route.ts)
via `toNextJsHandler(auth)`. **The exact path/field set is owned by the
installed `better-auth` version (pinned `1.6.9`).** Treat the list below
as representative; regenerate the authoritative schema/route set with
`pnpm db:auth:generate`.

### 4.1 Core auth (what a CLI uses to log in)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/auth/sign-in/email` | `{ email, password, callbackURL? }` | **Primary CLI login.** On success sets the session cookie via `Set-Cookie`. |
| `POST` | `/api/auth/sign-up/email` | `{ email, password, name }` | Self-registration; new users land `pending_approval`. |
| `POST` | `/api/auth/sign-out` | — | Clears the session cookie (local origin only). |
| `GET` | `/api/auth/get-session` | — | Returns the current session/user, or null. Use to verify a captured cookie. |
| `POST` | `/api/auth/forget-password` | `{ email, redirectTo? }` | Triggers the outbox-first reset email. |
| `POST` | `/api/auth/reset-password` | `{ token, newPassword }` | Completes a reset. |
| `GET` | `/api/auth/sign-in/social?provider=…` | — | Begins OAuth; **interactive, browser-only** — not usable headlessly. |
| `GET` | `/api/auth/callback/{google\|microsoft\|github}` | — | OAuth redirect target; not called directly. |

> Social login is interactive by construction. A headless CLI must use
> **email/password** sign-in. The seeded local admin
> (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) is an email/password
> account suitable for automation in non-production environments.

### 4.2 Better Auth admin plugin (`/api/auth/admin/*`)

The `admin()` plugin exposes its own HTTP surface, **gated by the Better
Auth `role` field (`admin`)** — this is a *different* authority from the
application `admin.*` permission catalog. Representative endpoints:

`create-user`, `list-users`, `set-role`, `set-user-password`, `ban-user`,
`unban-user`, `list-user-sessions`, `revoke-user-session`,
`revoke-user-sessions`, `impersonate-user`, `stop-impersonating`,
`remove-user`.

> ⚠️ **Two admin surfaces exist.** The `/api/auth/admin/*` plugin routes
> are gated only by the Better Auth role, **bypassing** the application
> permission catalog, the origin guard, the per-actor rate limiter, and
> the audit pipeline. The **supported, audited admin surface is
> `/api/administrator/*`** ([§5](#5-administrator-api-apiadministrator)),
> which wraps the same `auth.api.*` calls behind
> `requireAdminPermission`. Build CLIs against `/api/administrator/*`.
> Treat the raw plugin routes as an internal dependency, and ensure the
> Better Auth `admin` role is granted sparingly.

---

## 5. Administrator API (`/api/administrator/*`)

The supported management surface. Uniform pipeline per handler:
`requireAdminPermission` → Zod `.strict()` body validation → Kysely
transaction → audit (`success`/`denied`/`error`) → JSON. Verbs and
required permissions below are taken from the route implementations in
`src/app/api/administrator/**`.

### 5.1 Conventions

- `GET` = query, `POST` = create/action, `PATCH` = partial update,
  `DELETE` = delete. Bulk endpoints take `{ ids: string[] | "*" }`.
- List endpoints share the [pagination contract](#101-list-query-contract).
- Errors use the [error envelope](#102-error-envelope).
- Every response carries an `x-request-id` correlation header echoed into
  the audit log.

### 5.2 Users

| Path | Verbs | Permission(s) | Notes |
| --- | --- | --- | --- |
| `/users` | GET | `admin.users.read` | Paginated `app_users`. Filters: `status`; `q` matches email/name. Sort: `created_at`,`primary_email`,`display_name`,`status`. |
| `/users` | POST | `admin.users.create` | Body `{ email, password, name?, role?, initialAppStatus?, preferredLocale? }`. Wraps `auth.api.createUser`. Defaults to `pending_approval`. |
| `/users/[id]` | GET / PATCH / DELETE | `admin.users.read` / `update` / `delete` | PATCH: `{ displayName?, preferredLocale? }`. **DELETE = soft delete** (indefinite ban + `status='deactivated'`); never hard-deletes. |
| `/users/[id]/restore` | POST | `admin.users.delete` | Inverse of soft delete. |
| `/users/[id]/status` | POST | `admin.users.manage` | `{ action: approve\|block\|suspend\|reactivate, reason? }`. |
| `/users/[id]/ban` | POST | `admin.users.ban` | Wraps `auth.api.banUser`. |
| `/users/[id]/unban` | POST | `admin.users.ban` | Wraps `auth.api.unbanUser`. |
| `/users/[id]/password` | POST | `admin.users.setPassword` | `{ mode:"set", password }` or `{ mode:"reset_email", redirectTo? }`. Password never logged/echoed. |
| `/users/[id]/role` | POST | `admin.users.setRole` | Better Auth role (`user`/`admin`), distinct from app roles. |
| `/users/[id]/sessions` | GET / DELETE | `admin.users.sessions` | List / revoke-all. |
| `/users/[id]/sessions/[sessionId]` | DELETE | `admin.users.sessions` | Revoke one. |
| `/users/[id]/impersonate` | POST / DELETE | `admin.users.impersonate` | Start / stop; double-confirm + audited. |
| `/users/[id]/app-roles` | GET / POST / DELETE | `admin.roles.assign` | Manage `app_user_roles`. |
| `/users/[id]/memberships` | GET / POST / PATCH / DELETE | `admin.orgs.manage` | Manage `app_organization_memberships`. |
| `/users/bulk` | POST | per-action (see below) | `{ action, ids: string[]\|"*", reason?, expiresInSeconds?, filters? }`. Cap **500 ids**; `"*"` requires `filters`. |

Bulk actions: `approve`,`block`,`suspend`,`reactivate`,`ban`,`unban`,
`soft_delete`,`restore`. Each maps to its own required permission
(`BULK_USER_ACTION_PERMISSIONS`). The response reports per-row outcomes
(`{ attempted, succeeded, failed, results[] }`) so partial failures
surface without aborting the batch.

### 5.3 Roles & permissions

| Path | Verbs | Permission(s) |
| --- | --- | --- |
| `/roles` | GET / POST | `admin.roles.read` / `admin.roles.create` |
| `/roles/[id]` | GET / PATCH / DELETE | `admin.roles.read` / `update` / `delete` (DELETE → `409 role_in_use` when assigned) |
| `/roles/[id]/permissions` | GET / POST / DELETE | `admin.roles.update` (body `{ ids: string[] }`) |
| `/roles/[id]/members` | GET | `admin.roles.read` |
| `/roles/[id]/duplicate` | POST | `admin.roles.create` |
| `/permissions` | GET | `admin.roles.read` |
| `/permissions` | POST / PATCH / DELETE | `admin.permissions.manage` (DELETE → `409 permission_in_use`) |
| `/permissions/[id]` | GET / PATCH / DELETE | `admin.permissions.manage` |

Role list filters: `organization` (UUID or `global`), `scope`
(`global`/`org`), `permission` (key); `q` matches `key`/`name`.

### 5.4 Organizations, memberships, apps, audit, email, export

| Path | Verbs | Permission(s) |
| --- | --- | --- |
| `/organizations` | GET / POST | `admin.orgs.read` / `create` |
| `/organizations/[id]` | GET / PATCH / DELETE | `admin.orgs.*` (DELETE blocked if non-empty or default) |
| `/organizations/[id]/members` | GET / POST / PATCH / DELETE | `admin.orgs.manage` |
| `/organizations/[id]/provider-bindings` | GET / POST / DELETE | `admin.orgs.manage` |
| `/memberships` | GET | `admin.orgs.read` (cross-org search) |
| `/enterprise-apps` | GET / POST | `admin.apps.read` / `manage` |
| `/enterprise-apps/[id]` | GET / PATCH / DELETE | `admin.apps.manage` |
| `/api-keys` | GET / POST | `admin.apikeys.read` / `manage` (governance list joined to owner email; POST issues a key on behalf of a user, scopes capped to the owner's authority) |
| `/api-keys/[id]` | GET / DELETE | `admin.apikeys.read` / `manage` (DELETE = revoke, soft-delete, idempotent) |
| `/api-keys/[id]/rotate` | POST | `admin.apikeys.manage` (atomic re-issue + revoke; new secret returned once) |
| `/audit` | GET | `admin.audit.read` (filter on `event_type`,`outcome`,`actor`,`target`, date range) |
| `/email/outbox` | GET | `admin.email.read` |
| `/email/templates` | GET | `admin.email.read` |
| `/email/templates/[id]` | GET / PUT | `admin.email.read` / `admin.email.manage` |
| `/email/test` | POST | `admin.email.manage` |
| `/export/[resource]` | GET | the resource's `read` permission (streams CSV, capped 100k rows, CSV-injection-escaped) |

---

## 6. Account self-service API

These routes are **strictly self-scoped**: they resolve the actor from the
session via [`requireAccountUser`](../src/lib/account/guard.server.ts) and
write **only the caller's own row** — no id is ever accepted from the
body, so they are free of IDOR by construction. They require only a valid
session (user-level), not an `admin.*` permission.

| Path | Verb | Body | Notes |
| --- | --- | --- | --- |
| `/api/account/profile` | PATCH | `{ name, displayName? }` | Updates Better Auth `name` (current session user) + app `display_name`. |
| `/api/account/preferences` | PUT | `{ preferredLocale, timeZone?, dateFormat, numberFormatLocale }` | Locale/formatting prefs; validated against allow-lists. |
| `/api/preferences/locale` | POST | `{ locale }` | Persists preferred locale (pending users allowed; blocked users `403`). |

Personal **API keys** are also self-service: a user manages their own
keys at **Account → API keys**
([`/app/account/api-keys`](../src/app/[locale]/(secure)/app/account/api-keys/page.tsx))
over the self-scoped `/api/v1/me/api-keys` endpoints (GET / POST /
`{id}` DELETE / `{id}/rotate`). See
[design-api-keys-and-tokens.md §9.1](design-api-keys-and-tokens.md#91-self-service-account-surface).
Org-wide governance of any user's keys lives in the Administrator
console — see [§5.4](#54-organizations-memberships-apps-audit-email-export)
and [admin-manager.md §8.12](admin-manager.md).

---

## 7. SSO handoff API (`/api/sso/*`)

Cross-subdomain SSO. **Redirect-based, not a JSON API** — included here
because a CLI might trigger a launch but cannot consume the result
headlessly (the session lands in a browser cookie).

| Path | Verb | Auth | Behavior |
| --- | --- | --- | --- |
| `/api/sso/launch?applicationId=…&locale=…` | GET | session | Mints a one-time, ≤60 s JWT and **302-redirects** to the target's `/consume`. Token never appears in JSON. Unauthenticated → redirect to sign-in. Sets `Referrer-Policy: no-referrer`. |
| `/api/sso/consume?token=…&locale=…` | GET | the token itself | Verifies signature + audience (`SSO_HANDOFF_AUDIENCE_PREFIX:SSO_HANDOFF_APPLICATION_ID`), **atomically burns the `jti`** (replay-safe), establishes a session via the server-only `createSsoSession` endpoint, then redirects to the dashboard with the session cookie. |

Security properties worth preserving in any tooling: the audience is
derived from configured env, **never** the `Host` header; the nonce is
consumed before any session is created; tokens are stripped from the
final URL.

---

## 8. Navigation API (`/api/navigation/*`)

Menu feeds for the shell. All require a session **and** an `allow`
access decision (active user + active membership); they return `401`
unauthenticated, `403` for pending/blocked, and **never** return SSO
tokens or redirect.

| Path | Verb | Returns |
| --- | --- | --- |
| `/api/navigation/applications?locale=…` | GET | App-switcher entries (SSO launch URLs only). |
| `/api/navigation/nested-apps?locale=…` | GET | Nested workspace menu. |
| `/api/navigation/shell-menu?locale=…` | GET | Shell chrome menu. |

---

## 9. Permission catalog

The 30-key catalog (`ADMIN_PERMISSION_CATALOG` in
[`src/lib/admin/permissions.ts`](../src/lib/admin/permissions.ts), seeded
into `app_permissions` and granted to the `superuser` / `admin.platform`
role). Permissions are **platform-wide** in v1: a holder manages **every**
organization, not only their own.

```
admin.users.read         admin.roles.read         admin.orgs.read
admin.users.create       admin.roles.create       admin.orgs.create
admin.users.update       admin.roles.update       admin.orgs.update
admin.users.delete       admin.roles.delete       admin.orgs.delete
admin.users.manage       admin.roles.assign       admin.orgs.manage
admin.users.ban          admin.permissions.manage admin.apps.read
admin.users.setRole      admin.audit.read         admin.apps.manage
admin.users.setPassword  admin.email.read         admin.apikeys.read
admin.users.sessions     admin.email.manage       admin.apikeys.manage
admin.users.impersonate                           admin.clients.read
                                                  admin.clients.manage
```

The last four (`admin.apikeys.*` / `admin.clients.*`) govern the
machine-credential admin routes under `/api/v1/admin/*`. All 30 keys are
defined in the single `0001-initial-schema.sql`. These catalog keys are
also the **scope** strings used by the `/api/v1` surface (plus four
`account.*` scopes — see `docs/design-api-keys-and-tokens.md`).

A caller's effective permissions are computed per request by joining
`app_user_roles → app_role_permissions → app_permissions` for the user's
first organization membership ([`getUserAccessContext`](../src/lib/auth-status.ts)).

---

## 10. Shared contracts

### 10.1 List query contract

```
GET /api/administrator/<resource>?
  page=1&pageSize=25&
  sort=field:asc&sort=other:desc&
  q=<global-search>&
  filter[status]=active
```

Response envelope:

```json
{ "items": [ ... ], "page": 1, "pageSize": 25, "total": 12345,
  "sort": [ { "field": "created_at", "direction": "desc" } ] }
```

Sort fields and filters are **allow-listed per endpoint**; unknown values
are silently dropped (you cannot pivot to unindexed columns). Default page
size 25, max 200.

### 10.2 Error envelope

```json
{ "error": "<machine_code>", "message": "<human/i18n hint>" }
```

Common codes/status: `unauthenticated` (401), `forbidden` /
`untrusted_origin` (403), `invalid_body` (400), `not_found` (404),
`email_taken` / `key_taken` / `role_in_use` / `permission_in_use` (409),
rate-limited (429), `auth_*_failed` (502). Always read `error` (stable),
not `message` (may be localized).

---

## 11. Building a CLI: end-to-end recipe

A correct headless client must (1) log in, (2) persist the session
cookie, (3) send it back plus an `Origin` header on mutations, and
(4) respect rate limits.

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://app.devresponse.com"     # must match a trusted origin
JAR="$(mktemp)"                          # cookie jar

# 1. Sign in (email/password) — captures the session cookie into $JAR.
curl -sS -c "$JAR" -X POST "$BASE/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@devresponse.local","password":"ChangeMe-LocalOnly-123!"}'

# 2. Verify the session.
curl -sS -b "$JAR" "$BASE/api/auth/get-session"

# 3. Read users (GET — no Origin header required).
curl -sS -b "$JAR" "$BASE/api/administrator/users?status=pending_approval&pageSize=50"

# 4. Approve a user (mutation — MUST send a trusted Origin header).
curl -sS -b "$JAR" -X POST \
  "$BASE/api/administrator/users/$USER_ID/status" \
  -H 'Content-Type: application/json' \
  -H "Origin: $BASE" \
  -d '{"action":"approve","reason":"verified by ops"}'
```

Implementation checklist:

- **Login once, reuse the cookie.** Re-login only on `401` or after the
  8-hour rolling expiry. Don't sign in per request — you'll hit the
  sign-in rate limit.
- **Send `Origin: $BASE` on every `POST/PATCH/PUT/DELETE`.** Without it,
  mutations get `403 untrusted_origin` in staging/production.
- **Set `Content-Type: application/json`** and send `.strict()`-valid
  bodies — unknown keys are rejected with `400 invalid_body`.
- **Prefer bulk over loops.** Use `/users/bulk` (cap 500, or `"*"` +
  `filters`) instead of N single calls to stay under the per-actor token
  bucket; back off on `429`.
- **Correlate failures by `x-request-id`** — echo it in your logs so ops
  can match it to the `app_audit_events` row.
- **Pin the base URL to a trusted origin.** The cookie is first-party to
  `BETTER_AUTH_URL`; calling a different host won't carry the session.
- **Account for the Better Auth admin role.** App `admin.*` permissions
  gate `/api/administrator/*`; the separate Better Auth `admin` role
  gates the raw `/api/auth/admin/*` plugin routes. A CLI driving the
  supported surface only needs the former.

---

## 12. Security implications of CLIs, API keys & secrets

### 12.1 A CLI is an authenticated browser without a human

Because auth is cookie-session based, a CLI holds **the same authority a
signed-in admin holds in a browser** — but without the human, the screen
prompts, or the same-origin protection a browser provides for free. The
session cookie is a **bearer credential**: anyone who reads it can act as
that admin until it expires. Treat a captured session cookie as
sensitive as a password.

- **Store the cookie jar with least privilege.** `chmod 600`, never in a
  world-readable path, never committed, never in shell history or CI
  logs. Prefer an OS keychain/secret store over a temp file.
- **Short-lived by design.** The 8-hour rolling session caps the blast
  radius of a leaked cookie. Do not attempt to extend it.
- **One identity per automation.** Give automation its own dedicated
  account with the **minimum** permissions it needs, so its audit trail
  is distinguishable and it can be disabled without affecting humans.

### 12.2 The origin guard is defense-in-depth, not the whole story

The `Origin`/`Referer` check blocks browser-based CSRF, but a CLI
deliberately spoofs `Origin` to a trusted value — so the origin guard
provides **no** protection against a compromised CLI. The real boundary
is the session cookie + the permission catalog. Protect the cookie and
scope the account.

### 12.3 Every privileged action is audited — keep it that way

Each mutation writes an `app_audit_events` row (actor, target, reason,
ip, user-agent, `request_id`), and **denied** attempts are audited too.
Do not build tooling that strips identifying headers or shares one
service account across many operators — it defeats attribution. Set a
descriptive `User-Agent` and pass meaningful `reason` fields; they land
in the immutable audit log.

### 12.4 Secrets that must never reach a CLI distribution

The following are **server-side** secrets (see
[`docs/setup-better-auth.md`](setup-better-auth.md) §7). None should ever
be embedded in a CLI binary, config shipped to operators, or a repo:

- `BETTER_AUTH_SECRET` — signs session cookies; rotating it invalidates
  all sessions. Possession allows forging sessions.
- `SSO_HANDOFF_JWT_SECRET` — mints SSO handoff tokens; **kept separate**
  from `BETTER_AUTH_SECRET` by design. Do not collapse them.
- `DATABASE_URL`, OAuth client secrets — server-only.

A CLI legitimately needs only **end-user credentials** (an email/password
it prompts for or reads from the operator's own secret store), never
these platform secrets.

### 12.5 The two-admin-surface hazard

`/api/auth/admin/*` (Better Auth plugin, gated by the Better Auth `role`)
sidesteps the origin guard, the per-actor rate limiter, the application
permission catalog, and parts of the audit pipeline that `/api/administrator/*`
enforces. Grant the Better Auth `admin` role sparingly, and point all
tooling at `/api/administrator/*`. If you must expose the raw plugin
routes, put them behind the same `requireAdminPermission` wrapper. The
legacy `/api/admin/users/*` console endpoints were **removed** for exactly
this reason — they bypassed the hardened pipeline.

### 12.6 Machine credentials (the `/api/v1` surface)

Replaying a human's session cookie is a pragmatic stopgap, not a durable
integration pattern. For production automation, use the **machine
credentials** that the `/api/v1` surface provides (see §1 and
[`docs/design-api-keys-and-tokens.md`](design-api-keys-and-tokens.md)) —
do not distribute cookies. That surface already embodies the principles
that matter:

1. **First-class API keys + JWT** resolved by `src/lib/api-auth/`, gated
   by `v1-guard.server.ts` — not a cookie.
2. **Same authority model.** A credential's scopes are intersected with
   its owner's permission catalog, so it is subject to the *same*
   permissions, the same status checks, per-credential rate limiting, and
   audit logging.
3. **Scope, rotate, revoke.** Keys are issued with a narrow scope set,
   stored only as a SHA-256 hash, and support rotation and immediate
   revocation; JWT `jti`s can be revoked via `app_revoked_tokens`.
4. **Bounded lifetime.** Keys can carry an expiry (`expiresInDays`), and
   JWT access tokens are short-lived (≤ 1 hour).

When the `/api/v1` feature flags are **off**, the session-cookie recipe
in [§11](#11-building-a-cli-end-to-end-recipe)
is the only supported path — and the cautions above are mandatory, not
optional.

---

### References

- Auth instance & plugins: [`src/lib/auth.ts`](../src/lib/auth.ts)
- Admin guard pipeline: [`src/lib/admin/permissions.server.ts`](../src/lib/admin/permissions.server.ts)
- Origin/CSRF guard: [`src/lib/admin/origin-guard.server.ts`](../src/lib/admin/origin-guard.server.ts)
- Trusted origins: [`src/lib/trusted-origins.ts`](../src/lib/trusted-origins.ts)
- Access resolution: [`src/lib/auth-status.ts`](../src/lib/auth-status.ts)
- Admin routes: [`src/app/api/administrator/`](../src/app/api/administrator/)
- SSO: [`src/app/api/sso/`](../src/app/api/sso/)
- Administrator plan (verbs/permissions): [`docs/admin-manager.md`](admin-manager.md)
- Better Auth setup & secrets: [`docs/setup-better-auth.md`](setup-better-auth.md)
