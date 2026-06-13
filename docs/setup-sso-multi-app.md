# Multi-Application SSO Across Subdomains — Setup Guide

This guide explains how to put **two or more applications hosted on
different subdomains** behind a single sign-on (SSO) experience, using
the cross-subdomain handoff that is already implemented in
**devresponsekit**.

The running example throughout is the one in the task brief:

| Role                  | Host                   | What lives here                                                        |
| --------------------- | ---------------------- | --------------------------------------------------------------------- |
| **Identity hub**      | `login.mydomain.com`   | This devresponsekit deployment. Users sign in here (email/password + Google/GitHub/Microsoft). It issues SSO handoffs. |
| **Satellite app**     | `app.mydomain.com`     | A second application. It accepts a handoff and establishes its own session, then lands the user on its dashboard. |

You can add a third, fourth, … satellite the same way (§7).

> This document is about wiring **already-built primitives** together.
> The launch endpoint, the consume endpoint, the JWT signer/verifier,
> the one-time nonce table, and the server-only session plugin all exist
> in the repository today. Every file path below is real — follow the
> citations and read the source; it is the source of truth.

For the single-deployment auth fundamentals (schema, migrations,
provider registration mechanics, secrets), read
[setup-better-auth.md](setup-better-auth.md) first. This guide assumes
that one is understood.

---

## Table of Contents

1. [The mental model: why not just share a cookie?](#1-the-mental-model-why-not-just-share-a-cookie)
2. [Architecture of the handoff](#2-architecture-of-the-handoff)
3. [Prerequisites and topology decisions](#3-prerequisites-and-topology-decisions)
4. [Initial setup — environment variables](#4-initial-setup--environment-variables)
   - [4.1 The hub (`login.mydomain.com`)](#41-the-hub-loginmydomaincom)
   - [4.2 The satellite (`app.mydomain.com`)](#42-the-satellite-appmydomaincom)
   - [4.3 What must match, what must differ](#43-what-must-match-what-must-differ)
5. [Registering the satellite application](#5-registering-the-satellite-application)
6. [Connecting third-party providers (Google, GitHub, Microsoft) so they respect SSO](#6-connecting-third-party-providers-google-github-microsoft-so-they-respect-sso)
7. [Adding a third (or Nth) application](#7-adding-a-third-or-nth-application)
8. [Securing sessions that span subdomains](#8-securing-sessions-that-span-subdomains)
9. [End-to-end walkthrough and verification](#9-end-to-end-walkthrough-and-verification)
10. [Operational checklist](#10-operational-checklist)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. The mental model: why not just share a cookie?

The naïve approach to "SSO across `login.` and `app.`" is to set the
session cookie on the parent domain (`Domain=.mydomain.com`) so the
browser sends it to every subdomain. **This repository deliberately does
not do that**, and you should not either:

- A parent-domain cookie is sent to **every** current and future
  subdomain, including ones you do not control or have not hardened. One
  compromised or untrusted subdomain can read or fixate the session.
- It couples every app's session lifetime, rotation, and CSRF posture to
  a single cookie. You lose the ability to sign a user out of one app
  but not another, or to run different session policies per app.
- It breaks the moment one app moves to a different apex domain
  (`app.partner.com`), which real multi-tenant deployments eventually do.

Instead, **every subdomain owns its own first-party session cookie**.
Better Auth's cookies stay first-party to each app's own
`BETTER_AUTH_URL` (see the cookie note in
[setup-better-auth.md §8.1](setup-better-auth.md#81-vercel)). SSO is
achieved not by sharing a cookie but by a **short-lived, signed,
single-use handoff token** that lets the satellite mint its *own*
session for the same identity in one redirect — without making the user
type a password or re-run an OAuth dance.

This is the same pattern enterprise IdPs use (a brief signed assertion in
the URL, exchanged immediately for a local session), reduced to the
minimum needed for apps that share one backing database.

---

## 2. Architecture of the handoff

The full flow, from "user clicks an app tile on the hub" to "user is on
the satellite's dashboard, signed in":

```
            login.mydomain.com (HUB / issuer)                      app.mydomain.com (SATELLITE / consumer)
            ───────────────────────────────────                    ─────────────────────────────────────────
 1. User signs in (email/pw or Google/GitHub/MS)
    → Better Auth session cookie, first-party to login.

 2. GET /api/sso/launch?applicationId=app&locale=en
    ├─ requires a live hub session            ──────────┐
    ├─ loads access context (org, roles)                │  authorization gate:
    ├─ checks target app ∈ user's org                   │  membership + app access
    ├─ writes one-time nonce (jti) to DB                │
    ├─ signs JWT  (HS256, ≤60s, aud=app's audience)     │
    └─ 302 → https://app.mydomain.com/api/sso/consume?token=…
                Referrer-Policy: no-referrer
                                                          │
                                                          ▼
 3.                                              GET /api/sso/consume?token=…
                                                 ├─ verify signature / issuer / audience / exp
                                                 ├─ atomically BURN the nonce (jti)  ← replay defense
                                                 ├─ auth.api.createSsoSession({ userId: sub })
                                                 │     → new Better Auth session, first-party to app.
                                                 └─ 302 → /en/app/dashboard  (token stripped from URL)
                                                          Set-Cookie: <app's own session>

                        ┌──────────────── shared PostgreSQL ────────────────┐
                        │ user / account / session  (Better Auth)            │
                        │ app_users / app_organizations / app_user_roles     │
                        │ app_enterprise_applications  (the app registry)    │
                        │ app_sso_handoff_nonces       (one-time jti store)  │
                        └────────────────────────────────────────────────────┘
```

The implementing files:

| Step | File                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- |
| Launch route      | [`src/app/api/sso/launch/route.ts`](../src/app/api/sso/launch/route.ts)     |
| Authorization + token mint | [`src/lib/sso.server.ts`](../src/lib/sso.server.ts) (`createSsoHandoffRedirect`) |
| JWT sign/verify   | [`src/lib/jwt-handoff.server.ts`](../src/lib/jwt-handoff.server.ts)          |
| Consume route     | [`src/app/api/sso/consume/route.ts`](../src/app/api/sso/consume/route.ts)   |
| Server-only session plugin | [`src/lib/auth-sso-session.ts`](../src/lib/auth-sso-session.ts) (`createSsoSession`) |
| Nonce store       | `app_sso_handoff_nonces` in [`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql) |
| App registry      | `app_enterprise_applications` in [`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql) |

Five properties make this safe (all enforced in the code above):

1. **Short-lived.** The token's TTL is clamped to **≤ 60 seconds**
   (`SSO_HANDOFF_MAX_TTL_SECONDS` in
   [`jwt-handoff.server.ts`](../src/lib/jwt-handoff.server.ts)).
2. **Single-use.** A `jti` nonce is persisted *before* signing and
   **atomically burned** on consume
   (`consumeSsoHandoffNonce` — a conditional `UPDATE … WHERE consumed_at
   IS NULL`). A replayed token loses the race and is rejected, even
   under concurrent requests.
3. **Audience-bound.** The `aud` claim is the target app's
   `sso_audience`. The consumer recomputes its *expected* audience from
   its **own** `SSO_HANDOFF_APPLICATION_ID` env var — never from the
   `Host` header — so a token minted for `app` cannot be replayed
   against `analytics`.
4. **Never in JSON, never in history.** The token only ever rides in a
   302 `Location`; both routes set `Referrer-Policy: no-referrer` and
   `Cache-Control: no-store`, and the consumer's final redirect strips
   the token from the URL.
5. **Authorization happens at launch.** The hub refuses to mint a token
   unless the user has an active membership and access to the target app
   (`loadSsoAccessContext` in
   [`sso.server.ts`](../src/lib/sso.server.ts)). The satellite re-checks
   only user-level state (exists, not banned).

---

## 3. Prerequisites and topology decisions

The handoff design in this repo assumes **one shared database** behind
all participating subdomains. This is load-bearing, because:

- The nonce written by the hub
  (`app_sso_handoff_nonces`, via
  [`sso.server.ts`](../src/lib/sso.server.ts)) is **read and burned by
  the satellite** in [`consume/route.ts`](../src/app/api/sso/consume/route.ts).
  Both sides talk to the same `app_sso_handoff_nonces` table.
- The satellite mints a session for `sub` against the shared
  `user` / `session` tables via `createSsoSession`. The identity already
  exists in the shared DB; the handoff just proves *which* identity and
  *that it is authorized*, then issues a local session fast.

So the supported topology is **N deployments (subdomains), one Postgres
database**:

```
login.mydomain.com  ─┐
app.mydomain.com    ─┼──►  one pooled DATABASE_URL  ──►  PostgreSQL
analytics.mydomain… ─┘
```

Each subdomain is its own deployment (its own Vercel project / container
/ process) with its own `BETTER_AUTH_URL` and its own session cookies,
but they all point `DATABASE_URL` at the **same** pooled Postgres
endpoint.

> If your second app is a completely separate system with its **own**
> database and cannot share this one, this specific handoff (with its
> DB-backed nonce) does not apply unmodified — you would federate via a
> standard protocol (OIDC) instead. That is out of scope here; this
> guide documents the built-in shared-DB handoff.

Before you start you need:

- [ ] A shared, pooled Postgres reachable by every subdomain
      (see [setup-better-auth.md §2.3](setup-better-auth.md#23-connection-pooling)).
- [ ] Migrations applied **once** against that shared DB
      (`pnpm db:auth:migrate && pnpm db:app:migrate`).
- [ ] TLS on every subdomain (the session and handoff are HTTPS-only in
      production; cookies are `Secure`).
- [ ] Each subdomain deployable independently with its own env.

---

## 4. Initial setup — environment variables

All SSO env vars are documented inline in
[`.env.example`](../.env.example) (the `# Internal JWT handoff for
subdomain SSO` block). The handoff is parameterized entirely by
environment, so the *same codebase* behaves as the hub on one subdomain
and as a satellite on another.

### 4.1 The hub (`login.mydomain.com`)

```bash
# Identity of THIS deployment
NEXT_PUBLIC_APP_URL="https://login.mydomain.com"
BETTER_AUTH_URL="https://login.mydomain.com"
BETTER_AUTH_SECRET="<hub session secret — unique per deployment>"

# Shared database (same endpoint for every subdomain)
DATABASE_URL="postgresql://app_runtime:…@pooler:6432/devresponse_db?schema=public"

# Cross-subdomain SSO handoff (SHARED across all participating apps)
SSO_HANDOFF_ISSUER="https://login.mydomain.com"
SSO_HANDOFF_AUDIENCE_PREFIX="mydomain-app"
SSO_HANDOFF_JWT_SECRET="<one shared handoff secret for the whole fleet>"
SSO_HANDOFF_TTL_SECONDS=60

# This app's own identity in the audience namespace
SSO_HANDOFF_APPLICATION_ID="login"

# Trust the sibling subdomains for CSRF / origin checks
ADMIN_TRUSTED_ORIGINS="https://login.mydomain.com,https://app.mydomain.com"

# Third-party providers are registered HERE (see §6)
GOOGLE_CLIENT_ID="…"
GOOGLE_CLIENT_SECRET="…"
GITHUB_CLIENT_ID="…"
GITHUB_CLIENT_SECRET="…"
```

### 4.2 The satellite (`app.mydomain.com`)

```bash
# Identity of THIS deployment
NEXT_PUBLIC_APP_URL="https://app.mydomain.com"
BETTER_AUTH_URL="https://app.mydomain.com"
BETTER_AUTH_SECRET="<satellite session secret — DIFFERENT from the hub>"

# Same shared database as the hub
DATABASE_URL="postgresql://app_runtime:…@pooler:6432/devresponse_db?schema=public"

# Cross-subdomain SSO handoff — these THREE must be byte-identical to the hub
SSO_HANDOFF_ISSUER="https://login.mydomain.com"   # who signs tokens
SSO_HANDOFF_AUDIENCE_PREFIX="mydomain-app"
SSO_HANDOFF_JWT_SECRET="<same shared handoff secret as the hub>"
SSO_HANDOFF_TTL_SECONDS=60

# This app's OWN identity — DIFFERENT from the hub. This is what the
# consumer uses to compute its expected audience: `mydomain-app:app`.
SSO_HANDOFF_APPLICATION_ID="app"

ADMIN_TRUSTED_ORIGINS="https://login.mydomain.com,https://app.mydomain.com"

# The satellite usually does NOT need its own Google/GitHub creds — see §6.
```

> Note the asymmetry in `SSO_HANDOFF_ISSUER`: it is the **issuer's**
> origin (`login.mydomain.com`) on *both* deployments, because the
> verifier checks that the token was issued by the hub. The satellite is
> validating the hub's signature, not its own.

### 4.3 What must match, what must differ

| Variable                       | Hub                     | Satellite               | Rule |
| ------------------------------ | ----------------------- | ----------------------- | ---- |
| `SSO_HANDOFF_JWT_SECRET`       | `S`                     | `S`                     | **Must match** — symmetric HS256 signing key. |
| `SSO_HANDOFF_ISSUER`           | `https://login…`        | `https://login…`        | **Must match** — the verifier pins `iss`. |
| `SSO_HANDOFF_AUDIENCE_PREFIX`  | `mydomain-app`          | `mydomain-app`          | **Must match** — shared audience namespace. |
| `DATABASE_URL`                 | shared pooler           | shared pooler           | **Must match** — one nonce store, one identity store. |
| `SSO_HANDOFF_APPLICATION_ID`   | `login`                 | `app`                   | **Must differ** — each app's own audience suffix. |
| `BETTER_AUTH_URL`              | `https://login…`        | `https://app…`          | **Must differ** — each app's own origin/cookies. |
| `BETTER_AUTH_SECRET`           | unique                  | unique                  | **Should differ** — independent session signing per app. |

The audience a satellite expects is computed in
[`consume/route.ts`](../src/app/api/sso/consume/route.ts) as:

```ts
const expectedAudience = `${SSO_HANDOFF_AUDIENCE_PREFIX}:${SSO_HANDOFF_APPLICATION_ID}`;
// satellite "app"  →  "mydomain-app:app"
```

…and it **must equal** the `sso_audience` recorded for that app in the
registry (next section). Getting these two out of sync is the single
most common cause of `invalid_token` — see [§11](#11-troubleshooting).

Generate the shared handoff secret once and distribute it to every
deployment's secret store (it is **separate** from any
`BETTER_AUTH_SECRET`):

```bash
openssl rand -base64 48
```

---

## 5. Registering the satellite application

The hub will only mint a handoff for a target it knows about. Targets
live in the `app_enterprise_applications` registry table
([`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql)):

```sql
create table if not exists app_enterprise_applications (
  id              text primary key,        -- e.g. 'mydomain-app'
  organization_id uuid references app_organizations(id),  -- null = global/all-orgs
  label           text not null,           -- shown in the app switcher
  description     text,
  origin          text not null,           -- e.g. 'https://app.mydomain.com'
  subdomain       text not null,           -- e.g. 'app'
  sso_audience    text not null,           -- e.g. 'mydomain-app:app'  ← MUST equal the satellite's expectedAudience
  status          text not null default 'available',
  sort_order      integer not null default 100,
  created_at      timestamptz not null default now()
);
```

The columns that drive the handoff are read in
[`sso.server.ts`](../src/lib/sso.server.ts):

- **`origin`** — the launcher builds the redirect as
  `new URL("/api/sso/consume", targetApp.origin)`. This is where the
  user gets sent.
- **`sso_audience`** — becomes the JWT `aud`. The satellite rejects the
  token unless this equals its own
  `${SSO_HANDOFF_AUDIENCE_PREFIX}:${SSO_HANDOFF_APPLICATION_ID}`.
- **`status`** — only `'available'` apps can be launched.
- **`organization_id`** — if non-null, only members of that org may
  launch it (the launch authorization check in `loadSsoAccessContext`).
  Use `null` to make the app available to every organization.

The local seed registers three example apps the same way — see
[`src/db/seeds/seed-local.ts`](../src/db/seeds/seed-local.ts):

```ts
// id, label, origin, subdomain, sso_audience
["devresponse-portal",    "DevResponse Portal", "https://portal.devresponse.com",    "portal",    "devresponse-app:portal"],
["devresponse-analytics", "Analytics",          "https://analytics.devresponse.com", "analytics", "devresponse-app:analytics"],
["devresponse-docs",      "Documentation",      "https://docs.devresponse.com",      "docs",      "devresponse-app:docs"],
```

To register the `app.mydomain.com` satellite for our example, insert one
row into the **shared** database:

```sql
insert into app_enterprise_applications
  (id, organization_id, label, origin, subdomain, sso_audience, status, sort_order)
values
  ('mydomain-app', null, 'My App', 'https://app.mydomain.com', 'app', 'mydomain-app:app', 'available', 100)
on conflict (id) do nothing;
```

> The `id` you pass to `/api/sso/launch?applicationId=…` is this
> primary-key `id` (`mydomain-app`), **not** the
> `SSO_HANDOFF_APPLICATION_ID` (`app`). Keep the distinction straight:
> `id`/`applicationId` selects the registry row; `sso_audience`'s suffix
> must match the *satellite's* `SSO_HANDOFF_APPLICATION_ID`.

The launch is then triggered by linking the user to:

```
https://login.mydomain.com/api/sso/launch?applicationId=mydomain-app&locale=en
```

In this codebase that link is rendered by the app switcher for every
`available` enterprise application the signed-in user is authorized for;
you do not normally hand-write it.

---

## 6. Connecting third-party providers (Google, GitHub, Microsoft) so they respect SSO

The whole point of SSO is that **a user authenticates once and every app
trusts that**. With this architecture that falls out naturally:
**register external IdPs only on the hub.**

### 6.1 Centralize providers on the hub

Configure `GOOGLE_*`, `GITHUB_*`, `MICROSOFT_*` **only** on
`login.mydomain.com`. The provider registration mechanics (consent
screens, redirect URIs, scopes, multi-tenant Entra notes) are identical
to the single-app case and are documented in full in
[setup-better-auth.md §6](setup-better-auth.md#6-social-login-providers).
The only thing that changes for multi-app is **which origin** you
register as the callback:

| Provider  | Redirect URI to register (hub only)                          |
| --------- | ------------------------------------------------------------ |
| Google    | `https://login.mydomain.com/api/auth/callback/google`        |
| GitHub    | `https://login.mydomain.com/api/auth/callback/github`        |
| Microsoft | `https://login.mydomain.com/api/auth/callback/microsoft`     |

Because the OAuth callback only ever fires on `login.mydomain.com`, you
register **one** redirect URI per provider for the entire fleet — not
one per subdomain. (GitHub allows only a single callback URL per OAuth
App, so centralizing is what makes this tractable; see
[setup-better-auth.md §6.3](setup-better-auth.md#63-github).)

### 6.2 How a Google/GitHub login becomes an app session

1. User clicks **Sign in with Google** on `login.mydomain.com`.
2. Better Auth runs the OAuth dance; Google redirects to
   `login.mydomain.com/api/auth/callback/google`.
3. The `session.create.after` hook in
   [`src/lib/auth.ts`](../src/lib/auth.ts) provisions/links the
   `app_users` row (account linking is on, **verified-email-only** — see
   below). The user now has a hub session.
4. The user opens `app.mydomain.com` via the app switcher →
   `/api/sso/launch?applicationId=mydomain-app` → handoff → the
   satellite mints its own session.

The satellite **never talks to Google.** It trusts the hub's signed
handoff. That is the SSO guarantee: the identity proven by Google at the
hub propagates to every satellite without each satellite needing OAuth
credentials.

### 6.3 Account linking keeps one identity across providers

The handoff carries a single `sub` (the Better Auth `user.id`). For SSO
to mean "the same person" regardless of whether they used Google today
and GitHub tomorrow, those provider logins must resolve to **one**
identity. That is exactly what the account-linking policy in
[`src/lib/auth.ts`](../src/lib/auth.ts) enforces:

```ts
account: {
  accountLinking: {
    enabled: true,
    trustedProviders: ["google", "microsoft", "github"],
    allowDifferentEmails: false,   // only link on a matching VERIFIED email
  },
},
```

- Same verified email across Google and GitHub → one `user`, one set of
  `app_users` / roles → consistent SSO everywhere.
- An attacker cannot hijack an account by registering a provider with a
  spoofed **unverified** email — linking requires a verified match.

### 6.4 Should a satellite ever configure its own providers?

Generally **no** — that would defeat SSO (the user could end up with a
second, unlinked identity scoped to that subdomain). Keep external IdPs
on the hub and let satellites receive identity only through the handoff.
The exception is a satellite that must *also* be reachable directly
(deep links, bookmarked sign-in) for users who never touch the hub; in
that case give it the same provider creds **and** point those providers'
callbacks at the satellite too. Prefer the centralized model unless you
have that specific requirement.

---

## 7. Adding a third (or Nth) application

Adding `analytics.mydomain.com` is purely additive — the hub and the
existing satellite are untouched:

1. **Deploy** the new app on its subdomain with the env from
   [§4.2](#42-the-satellite-appmydomaincom), changing only:
   ```bash
   NEXT_PUBLIC_APP_URL="https://analytics.mydomain.com"
   BETTER_AUTH_URL="https://analytics.mydomain.com"
   BETTER_AUTH_SECRET="<unique>"
   SSO_HANDOFF_APPLICATION_ID="analytics"   # ← the only handoff var that changes
   ```
   Keep `SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_ISSUER`,
   `SSO_HANDOFF_AUDIENCE_PREFIX`, and `DATABASE_URL` identical to the
   rest of the fleet.
2. **Register** it in the shared registry:
   ```sql
   insert into app_enterprise_applications
     (id, organization_id, label, origin, subdomain, sso_audience, status, sort_order)
   values
     ('mydomain-analytics', null, 'Analytics', 'https://analytics.mydomain.com', 'analytics', 'mydomain-app:analytics', 'available', 110)
   on conflict (id) do nothing;
   ```
3. **Add the origin** to every deployment's `ADMIN_TRUSTED_ORIGINS`
   (hub + each satellite), then redeploy so the trusted-origin list in
   [`src/lib/trusted-origins.ts`](../src/lib/trusted-origins.ts) picks it
   up.

No new provider registration is needed — the new app inherits SSO from
the hub automatically.

To **retire** an app, set its registry `status` to anything other than
`'available'` (e.g. `'retired'`); the launch route will then refuse new
handoffs to it (`createSsoHandoffRedirect` filters on
`status = 'available'`).

---

## 8. Securing sessions that span subdomains

A consolidated view of the controls that keep a multi-subdomain session
safe, and what you must get right operationally.

**Built into the code (verify you don't weaken them):**

- **First-party cookies only.** Never set `Domain=.mydomain.com` on the
  Better Auth cookie. Each app's session stays scoped to its own host.
  Sessions are linked by *identity in the shared DB*, not by a shared
  cookie.
- **HTTPS everywhere.** Cookies are `Secure` + `httpOnly` and the
  handoff token only travels over TLS. Terminate TLS at every subdomain.
- **≤60s, single-use tokens.** TTL is clamped
  ([`jwt-handoff.server.ts`](../src/lib/jwt-handoff.server.ts)) and the
  nonce is burned atomically
  ([`sso.server.ts`](../src/lib/sso.server.ts)). Do not raise
  `SSO_HANDOFF_TTL_SECONDS` beyond what a redirect needs; it cannot
  exceed 60 regardless.
- **Audience pinned to the app's own id, not the Host header.** The
  comment in [`consume/route.ts`](../src/app/api/sso/consume/route.ts)
  spells out the threat: deriving audience from `Host` would let a DNS
  or proxy attacker bypass the check. Always set
  `SSO_HANDOFF_APPLICATION_ID` explicitly per deployment.
- **No token leakage.** `Referrer-Policy: no-referrer` +
  `Cache-Control: no-store` on both routes; the consumer strips the
  token from the final URL so it never lands in browser history or
  server logs.
- **Authorization at the source.** The hub refuses to mint a token for a
  user without an active membership / app access; the satellite rejects
  banned or unknown users in
  [`auth-sso-session.ts`](../src/lib/auth-sso-session.ts).

**Your operational responsibilities:**

- **Independent session secrets.** Give each deployment its own
  `BETTER_AUTH_SECRET`. Rotating one app's secret signs *that app's*
  users out without touching the others.
- **One shared handoff secret, tightly held.** `SSO_HANDOFF_JWT_SECRET`
  is the keys to the kingdom — anyone who has it can mint identity
  assertions for any app. Store it in a secret manager, mark it
  Sensitive, rotate fleet-wide on suspected compromise. It is
  deliberately **separate** from every `BETTER_AUTH_SECRET`
  (see [setup-better-auth.md §7](setup-better-auth.md#7-secrets-management--best-practices)).
- **Least-privilege DB role at runtime.** The shared `DATABASE_URL` used
  by apps should be a DML-only role; migrations run under a separate DDL
  role from CI.
- **Sign-out is per-app by design.** Because sessions are independent,
  signing out of `app.` does **not** sign the user out of `login.`. If
  you need global sign-out, drive it from the hub by invalidating the
  user's sessions in the shared `session` table (a "sign out everywhere"
  action), not by sharing cookies.
- **Audit everything.** Both routes already emit
  `sso.launch.*` / `sso.consume.*` audit events via
  [`src/lib/audit.server.ts`](../src/lib/audit.server.ts). Ship the
  `app_audit_events` table somewhere durable and alert on bursts of
  `nonce_replay_or_expired` or `invalid_token`.

---

## 9. End-to-end walkthrough and verification

A concrete first-run, assuming the env in §4 and the registry row in §5
are in place against one shared, migrated database.

**1. Confirm both apps boot and share the DB.**

```bash
# On each deployment, the build needs these or it fails fast:
#   BETTER_AUTH_SECRET, BETTER_AUTH_URL,
#   SSO_HANDOFF_JWT_SECRET, SSO_HANDOFF_AUDIENCE_PREFIX
pnpm build && pnpm start
```

**2. Sign in on the hub.** Visit
`https://login.mydomain.com/en/sign-in`, sign in with email/password or
Google/GitHub. Confirm a session cookie scoped to `login.mydomain.com`.

**3. Launch the satellite.** Hit:

```
https://login.mydomain.com/api/sso/launch?applicationId=mydomain-app&locale=en
```

Expected: a `302` to
`https://app.mydomain.com/api/sso/consume?token=…` with
`Referrer-Policy: no-referrer`. (No session on the hub → you are bounced
to `/en/sign-in` instead. Unknown/unavailable `applicationId` or no app
access → `403 sso_launch_failed`, audit-logged.)

**4. Land signed in.** The browser follows the redirect; the consumer
verifies + burns the token and `302`s to
`https://app.mydomain.com/en/app/dashboard` with a `Set-Cookie` for the
satellite's **own** session. You are now signed in on `app.` with the
token gone from the URL.

**5. Prove replay is rejected.** Copy the
`…/api/sso/consume?token=…` URL from step 3 and open it a second time.
Expected: `401 token_already_used` and an
`sso.consume.failure / nonce_replay_or_expired` audit row. Waiting >60s
before the first use yields the same rejection (expired).

**6. Prove audience binding.** Temporarily point the launch at an app
whose `sso_audience` does not match the satellite's
`SSO_HANDOFF_APPLICATION_ID`. Expected: `401 invalid_token` at consume —
the signature is valid but the `aud` check fails.

---

## 10. Operational checklist

Before promoting a multi-app SSO change:

- [ ] All participating subdomains point `DATABASE_URL` at the **same**
      pooled Postgres, and migrations have been applied **once** to it.
- [ ] `SSO_HANDOFF_JWT_SECRET`, `SSO_HANDOFF_ISSUER`, and
      `SSO_HANDOFF_AUDIENCE_PREFIX` are **identical** across every
      deployment.
- [ ] Every deployment has a **distinct** `SSO_HANDOFF_APPLICATION_ID`,
      and each one matches the `sso_audience` suffix of its
      `app_enterprise_applications` row.
- [ ] Each app has its **own** `BETTER_AUTH_URL` and its own
      `BETTER_AUTH_SECRET`.
- [ ] No deployment sets a parent-domain (`.mydomain.com`) cookie.
- [ ] `ADMIN_TRUSTED_ORIGINS` on every deployment lists **all**
      participating subdomains.
- [ ] Third-party providers are registered on the **hub** only, with the
      hub's callback URIs; account linking is verified-email-only.
- [ ] `SSO_HANDOFF_TTL_SECONDS` ≤ 60 (and not raised "to be safe").
- [ ] TLS is enforced on every subdomain.
- [ ] `app_audit_events` is sinking durably; alerts exist for replay /
      invalid-token bursts.

## 11. Troubleshooting

| Symptom                                                       | Likely cause                                                                                          | Fix                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Consume returns `401 invalid_token` immediately               | Audience mismatch: the registry `sso_audience` ≠ the satellite's `${AUDIENCE_PREFIX}:${APPLICATION_ID}`, **or** a different `SSO_HANDOFF_JWT_SECRET` / `SSO_HANDOFF_ISSUER` on the two sides | Make the three shared handoff vars byte-identical; make `sso_audience` equal the satellite's expected audience. |
| Consume returns `401 token_already_used`                      | Token replayed, or >60s elapsed before consume (nonce expired)                                        | Re-launch from the hub to mint a fresh token; don't bookmark consume URLs.                                       |
| Launch redirects to `/sign-in` instead of the satellite       | No live session on the hub                                                                             | Sign in on `login.mydomain.com` first; SSO launches require an authenticated hub session.                       |
| Launch returns `403 sso_launch_failed`                        | User lacks active membership, or the target app belongs to a different org, or `status != 'available'` | Check `app_users.status`, membership, the app's `organization_id`/`status`; see `loadSsoAccessContext`.         |
| Launch returns `400 missing_application_id`                   | `applicationId` query param omitted                                                                   | Pass `?applicationId=<registry id>` (the table PK, e.g. `mydomain-app`).                                         |
| Consume returns `500 audience_not_configured`                 | `SSO_HANDOFF_AUDIENCE_PREFIX` or `SSO_HANDOFF_APPLICATION_ID` not set on the satellite                 | Set both on the consuming deployment.                                                                            |
| Consume returns `401 session_establishment_failed`            | User is banned, was deleted, or the session store was unreachable                                     | Expected for banned/unknown users; otherwise check DB connectivity. The nonce is already burned — re-launch.    |
| Nonce burn never matches (every consume fails as replay)      | Hub and satellite are not on the **same** database                                                    | Point both `DATABASE_URL`s at the one shared pooled Postgres.                                                    |
| User ends up with two separate identities across apps         | A satellite ran its own OAuth with separate creds, or account linking is off / email unverified       | Centralize providers on the hub (§6); keep `allowDifferentEmails: false`.                                        |
| `redirect_uri_mismatch` from Google/GitHub                    | Provider callback registered for a satellite, or wrong origin                                         | Register the callback for the **hub** origin only: `https://login.mydomain.com/api/auth/callback/{provider}`.    |

---

**References**

- Launch route: [`src/app/api/sso/launch/route.ts`](../src/app/api/sso/launch/route.ts)
- Consume route: [`src/app/api/sso/consume/route.ts`](../src/app/api/sso/consume/route.ts)
- Handoff authorization + nonce: [`src/lib/sso.server.ts`](../src/lib/sso.server.ts)
- JWT sign/verify: [`src/lib/jwt-handoff.server.ts`](../src/lib/jwt-handoff.server.ts)
- Server-only session plugin: [`src/lib/auth-sso-session.ts`](../src/lib/auth-sso-session.ts)
- Trusted origins: [`src/lib/trusted-origins.ts`](../src/lib/trusted-origins.ts)
- Better Auth instance + account linking: [`src/lib/auth.ts`](../src/lib/auth.ts)
- App registry + nonce schema: [`src/db/migrations/0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql)
- Example app registrations: [`src/db/seeds/seed-local.ts`](../src/db/seeds/seed-local.ts)
- Env template: [`.env.example`](../.env.example)
- Single-app auth guide: [setup-better-auth.md](setup-better-auth.md)
</content>
</invoke>
