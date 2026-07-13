---
title: "Satellite Apps — Integration Guide"
description: Standing up a subdomain app that delegates authentication to the platform — the three integration options as built in devresponseapps, both sides' configuration contracts, and the deployment scenarios.
group: General
order: 78
---

# Satellite Apps — Integration Guide

_Audience: engineers standing up a **satellite app** — an application on its own subdomain that reuses the DevResponseKit shell and **delegates authentication** to a primary DevResponseKit deployment. This is the practical, as-built companion to [Design: Satellite Apps](./design-satellite-apps.md) (the decision record); the security framing lives in [API Security §8](./api-security.md#8-third-party-and-satellite-web-apps)._

The reference implementation is the **`devresponseapps`** repository — a pnpm workspace with three sibling apps, one per integration option, each a full DevResponseKit fork with the administrator console and machine API removed:

| App | Option | Port (dev) | One-line contract |
| --- | --- | --- | --- |
| `app-standalone` | **A** — SSO handoff + own `app_users` | 3001 | Handoff consumer with a local profile row and a local `status` kill switch |
| `app-handoff` | **B** — SSO handoff, table-less | 3002 | Handoff consumer with no local profile; a valid session grants the shell baseline |
| `app-shared` | **C** — shared `auth` schema | 3003 | No handoff at all; validates the primary's own session via a shared cookie + DB |

Remarkably, the three options differ by **two source-level deltas plus configuration** (§4.4, §5.1) — the decision is about **trust boundaries**, not code volume.

> **Scope honesty.** The reference apps are **build-verified** (green `next build` in-workspace and extracted) but were wired without a database available, so the flows below are configured per the design doc, not exercised end-to-end there. §4.5 lists the two code changes a **separate-database** production deployment of A/B still needs.

---

## 1. Pick your option (the trust-boundary decision)

Decide by trust boundary first — the full rationale and comparison matrix is in [Design: Satellite Apps §3](./design-satellite-apps.md#3-auth-data-model--a--b--c-the-load-bearing-decision):

- **Third-party, mixed-trust, or defense-in-depth fleet → A or B (the handoff).** Each satellite keeps its own session store, its own subdomain-scoped cookie, and its own `BETTER_AUTH_SECRET`; the only bridge is a single-use, audience-bound, ≤60-second token. A compromised satellite is contained.
  - **A** when the satellite persists any per-user state (preferred locale, a local `status` kill switch) — the recommended default.
  - **B** for an ultra-thin viewer with zero per-user state, accepting that revocation rides the session TTL rather than a local status flag.
- **First-party, co-trusted, same-team fleet → C.** Least code, zero-redirect UX, one identity source, instant central revocation — bought by collapsing the whole subdomain fleet into **one security domain** (shared parent-domain cookie + shared `BETTER_AUTH_SECRET`). Never offer C to a third party.

## 2. How the SSO handoff works (Options A & B)

```mermaid
sequenceDiagram
    participant U as User (signed in on primary)
    participant P as Primary /api/sso/launch
    participant SG as Satellite GET /api/sso/consume
    participant SC as Satellite /sso/confirm
    participant SP as Satellite POST /api/sso/consume

    U->>P: GET ?applicationId=<id>
    P->>P: verify session + registered app,<br/>INSERT nonce (jti), sign HS256 JWT (≤60s)
    P-->>SG: 302 …/api/sso/consume?token=…
    SG->>SG: verify sig + iss + aud + exp (no session yet)
    SG-->>SC: 302 /{locale}/sso/confirm?token=…
    SC->>SP: same-origin POST (hidden token)
    SP->>SP: trusted-origin check → re-verify →<br/>burn nonce (one-time) → create session
    SP-->>U: 303 /{locale}/app/dashboard + session cookie
```

**The token** is an HS256 JWT signed with the shared `SSO_HANDOFF_JWT_SECRET`:

- Claims: `jti` (one-time-use id), `sub` (Better Auth user id), `email`, `organizationId`, `appUserId`, `targetApplicationId`, `locale`, `roles[]` — **no display name** (the satellite derives one).
- `iss` = `SSO_HANDOFF_ISSUER`; `aud` = `<SSO_HANDOFF_AUDIENCE_PREFIX>:<applicationId>` — so a token minted for one satellite is rejected by every other.
- TTL: the signer **hard-clamps to ≤60 seconds** regardless of `SSO_HANDOFF_TTL_SECONDS`.
- Single use: the `jti` is burned on the consume POST; replays are rejected.

**Why the GET → confirm → POST dance:** the GET leg only *verifies* — no session is created from a top-level navigation, which blocks login-CSRF/session-fixation via a pasted link. The interstitial shows the account being signed in and submits a **same-origin POST**, which is where the nonce burns and the session mints (guarded by the satellite's trusted-origin check).

## 3. The two-sided configuration contract (A & B)

### 3.1 Primary side (the issuer)

1. **Register the satellite as an enterprise application** (Administrator → Enterprise apps, `admin.apps.manage`): its `origin` (e.g. `https://apps.example.com`) and `sso_audience` = `<prefix>:<applicationId>` (e.g. `devresponse-app:standalone`), status available ([Admin Manager §8.7](./admin-manager.md#87-enterprise-applications)).
2. **Cover the subdomain in `SSO_ALLOWED_ORIGIN_SUFFIXES`** (or leave it derived from `NEXT_PUBLIC_PRODUCTION_HOST` when the satellite lives under the same root host) — see [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff).
3. **Share three values** with the satellite: `SSO_HANDOFF_ISSUER` (the primary's origin), `SSO_HANDOFF_AUDIENCE_PREFIX`, and `SSO_HANDOFF_JWT_SECRET` (≥32 chars; **must differ** from every `BETTER_AUTH_SECRET`).

### 3.2 Satellite side (the consumer)

| Variable | Value | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_PRODUCTION_HOST` | the satellite's own identity | inlined at build time |
| `BETTER_AUTH_SECRET` | **its own** (≥32 chars) | never shared with the primary |
| `BETTER_AUTH_URL` | the satellite's own origin | |
| `DATABASE_URL` / `DB_SCHEMA` | **its own** database (or own schema on a shared instance) | `DB_SCHEMA` defaults to `auth` |
| `ADMIN_TRUSTED_ORIGINS` | the satellite's own origin | feeds Better Auth `trustedOrigins` + the origin guard on the consume POST |
| `SSO_HANDOFF_ISSUER` | the **primary's** origin | |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | same as primary (e.g. `devresponse-app`) | |
| `SSO_HANDOFF_APPLICATION_ID` | **unique per satellite** (e.g. `standalone`, `handoff`) | must match the registered `sso_audience` suffix |
| `SSO_HANDOFF_JWT_SECRET` | **same as primary** (HS256 is symmetric) | |

All four `SSO_HANDOFF_*` values are validated **at boot** on every DevResponseKit-derived app — including Option C, which never uses them at runtime (set placeholders there).

## 4. Options A & B in detail

### 4.1 What the reference forks keep and remove

Removed relative to the kit: the administrator console (`(secure)/app/administrator`, `/api/administrator`), the machine API (`/api/v1`, `/api/mcp`, `/.well-known`), and the kit-wide test suite. Kept: the entire shell (sidebar, 8 locales, theme, dashboard, workspace, docs viewer), **Account self-service**, the full auth pages, and all of `src/lib/**` (admin/machine libraries remain as unreferenced dead code so each fork stays a clean, buildable diff of the original). The full kit migration set ships unchanged in each fork.

> The [design doc §4](./design-satellite-apps.md#4-what-a-satellite-keeps--strips--rewrites) prescribes a much deeper strip (no account area, thin migrations, relocated helpers). The reference forks deliberately chose the shallow diff instead — easier to rebase on kit updates, at the cost of dead code. Both are valid; know which one you're doing.

### 4.2 Option A — the local profile

`app-standalone` runs the kit's stock access-context resolution: the session's user is looked up in the satellite's own `app_users`; membership, roles, and permissions resolve locally. A user with no row lands as `pending_approval` with no permissions — so under stock code, **handoff users must exist locally** (see §4.5). The local `status` column is the satellite's own kill switch, independent of the primary.

### 4.3 Option B — table-less identity

`app-handoff` changes exactly one branch: when the session's user has **no** local `app_users` row, `getUserAccessContext` returns `status: "active"`, an active membership, and `permissions: ["shell.view"]` — the shell baseline — instead of A's `pending_approval` + no permissions. Identity rides the session; there is no local profile and **no local kill switch** (revocation happens on the primary and propagates on session expiry).

### 4.4 The A↔B delta, concretely

One file, one branch — `src/lib/auth-status.ts`, the no-local-row fallback:

```text
status:            "pending_approval"  →  "active"
membershipStatus:  null                →  "active"
permissions:       []                  →  [SHELL_BASELINE_PERMISSION]   // "shell.view"
```

Everything else — the SSO routes, the confirm page, the token codec, the proxy, the guard — is byte-identical between the two apps.

### 4.5 Production caveat — separate databases need two code changes

The kit's handoff was built for **same-database** issuer/consumer pairs, and the reference forks ship that code unchanged:

1. **Nonce model.** The nonce row is INSERTed at launch into the *issuer's* `app_sso_handoff_nonces`, and the consume POST **burns that pre-existing row**. Across two databases there is no row to burn → every handoff 401s. Fix: replace the burn with **insert-if-absent** replay protection — a local `sso_consumed_nonces` table (UNIQUE `jti`); INSERT on consume; unique-violation = replay.
2. **User provisioning.** Session creation throws `"unknown user"` when the token's `sub` has no local Better Auth `user` row, and the stock consume POST does **not** provision. Fix: upsert the Better Auth `user` (id = `sub`, email from claims, `emailVerified: true`) — plus the thin `app_users` row under Option A — *before* creating the session.

Both changes are specified precisely in [Design: Satellite Apps §2.1](./design-satellite-apps.md#21-three-code-facts-verified-in-source-that-shape-the-rewrite) and acknowledged in the reference apps' READMEs. If instead your satellite **shares the primary's database instance and schema-per-app is not in play for auth tables** (i.e. it can see the primary's nonce and user rows), the stock code works as-is — but at that point evaluate whether Option C is the honest description of your topology.

### 4.6 The signed-out path

As shipped, an unauthenticated hit on a satellite's `(secure)` route redirects to the satellite's **local sign-in page** (the forks keep the kit's full auth UI). For a pure satellite that must never own sign-in, implement the [design doc §7](./design-satellite-apps.md#7-the-not-logged-in-path) bounce instead: redirect to `${SSO_HANDOFF_ISSUER}/api/sso/launch?applicationId=${SSO_HANDOFF_APPLICATION_ID}&returnTo=<original path>` and remove the local sign-in/sign-up pages.

## 5. Option C in detail — shared `auth` schema

### 5.1 The single code delta

`app-shared` differs from the stock kit by **one block** in `src/lib/auth.ts`:

```ts
advanced: {
  crossSubDomainCookies: {
    enabled: true,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  },
},
```

Combined with pointing `DATABASE_URL` + `DB_SCHEMA` + `BETTER_AUTH_SECRET` at the **primary's**, `auth.api.getSession()` validates the primary-issued session cookie directly. No handoff, no nonce, no confirm page, no provisioning — the user is simply already signed in.

### 5.2 Option C configuration

| Variable | Value |
| --- | --- |
| `DATABASE_URL` / `DB_SCHEMA` | the **primary's** database and schema (`auth`) |
| `BETTER_AUTH_SECRET` | the **primary's** secret |
| `BETTER_AUTH_URL` | the satellite's own origin |
| `COOKIE_DOMAIN` | the shared parent domain (e.g. `.example.com`) — set on the **primary too** (the kit supports the same env var — [Configuration](./configuration.md#authentication-better-auth)), so the session cookie spans the fleet |
| `ADMIN_TRUSTED_ORIGINS` | the satellite **plus the primary** (and siblings) |
| `SSO_HANDOFF_*` | placeholders (required at boot, unused at runtime) |

**Do not run migrations from an Option C satellite** — it reuses the primary's schema; the primary owns it.

### 5.3 Option C operational notes

- **Trust boundary:** one cookie + one secret across the fleet means an XSS or subdomain takeover on *any* app impersonates the user on *all* of them. First-party, co-trusted apps only ([API Security §8](./api-security.md#8-third-party-and-satellite-web-apps)).
- **Coupling:** the satellite tracks the primary's `auth` schema shape and Better Auth version — pin and upgrade them together.
- **DB grants:** rolling-session refresh **writes** to `session`, so a strictly read-only role on the primary's schema breaks refresh; scope the grant deliberately (read-mostly + `session` write).
- **Revocation:** instant and central — revoke the session/user on the primary and every satellite sees it on the next request.
- Because the reference fork keeps the kit's stock access-context code, a C satellite reads the primary's `app_users`/RBAC too — users carry the same permissions they have on the primary.

## 6. Deployment scenarios

### 6.1 Vercel — one project per app from a monorepo (recommended)

Import the workspace repo once per app: **Root Directory** = `app-standalone` (repeat for the others), framework preset Next.js, build/install commands on defaults — Vercel detects the pnpm workspace, installs from the shared root lockfile, and builds the selected folder. Set the env per §3.2/§5.2 in each project. Each app gets its own domain: `standalone.example.com`, `handoff.example.com`, …

### 6.2 Vercel — extract one app to a standalone repo

Each app folder is self-contained (own `package.json` + `.npmrc`): copy it out, `pnpm install` to generate its own lockfile (commit it), fresh `git init`, import with Root Directory = `.`. The build config auto-detects the topology (`turbopack.root` resolves to the workspace root when `../pnpm-workspace.yaml` exists, else to the app itself), so no config change is needed in either mode.

### 6.3 Docker / self-host

Every app keeps the kit's multi-stage `Dockerfile` (`output: "standalone"`, non-root) and compose setup — the whole [Docker guide](./docker.md) applies per app. Remember the boot-required env (including all four `SSO_HANDOFF_*`) and run migrations as a separate init step **per app database** — never from an Option C satellite.

### 6.4 Databases — three topologies

| Topology | Fits | Notes |
| --- | --- | --- |
| **Separate database per satellite** | A, B | Hard isolation; the default assumption for third-party satellites. Requires the §4.5 code changes. |
| **One Postgres instance, one schema per app** (`DB_SCHEMA`) | A, B | Cost/ops consolidation only — sharing the *instance* does not share auth; each app still has its own `user`/`session`, still bridged by the handoff. |
| **Shared `auth` schema** | C | The satellite reads the primary's `auth.session`/`auth.user`; app-specific tables belong in the satellite's own schema. |

### 6.5 Cron & email

Each app ships the kit's `vercel.json` with the daily `outbox-drain` cron — set `CRON_SECRET` (the route fails closed without it) or **remove the `crons` block** on satellites that never send email.

### 6.6 Local development — all four apps on one machine (the suggested setup)

The **suggested local topology** mirrors a live subdomain deployment: the primary on a local root domain and every satellite on a true subdomain of it, all over plain http:

| App | URL | Cookie host |
| --- | --- | --- |
| Primary | `http://devresponse.local:3000` | `.devresponse.local` (parent-domain, via `COOKIE_DOMAIN`) |
| A (`app-standalone`) | `http://app1.devresponse.local:3001` | `app1.devresponse.local` (own cookie — isolated) |
| B (`app-handoff`) | `http://app2.devresponse.local:3002` | `app2.devresponse.local` (own cookie — isolated) |
| C (`app-shared`) | `http://app3.devresponse.local:3003` | `.devresponse.local` — **the primary's parent-domain cookie**, exactly like a production Option C fleet |

This exercises the *real* mechanics of a live fleet — per-subdomain cookie isolation for A/B, and the parent-domain shared session for C — instead of localhost approximations.

**Step-by-step** (assumes the `devresponseapps` checkout sits next to the kit's):

0. **Map the subdomains to `127.0.0.1`** — run the provided hosts-file script from an elevated PowerShell (it self-elevates with a UAC prompt, is idempotent, and `-Remove` undoes it):

   ```powershell
   ./scripts/setup-local-subdomains.ps1
   ```

   It adds `devresponse.local` + `app1`/`app2`/`app3.devresponse.local` as a managed block and verifies resolution. *No admin rights?* Use the `*.localtest.me` fallback — public DNS already resolves it to `127.0.0.1` — substituting those hostnames throughout (and running C on `localhost:3003` instead, where it shares the primary's host-only cookie across ports without `COOKIE_DOMAIN`).

1. **Provision + seed the primary** — and load the dev fixture so you have users to sign in with ([Developer Onboarding §3](./developer-onboarding.md#3-run-locally) lists the credentials):

   ```bash
   pnpm db:up && pnpm db:provision && pnpm db:seed:dev
   ```

2. **Mint the shared handoff secret** and set the primary's `.env`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

   ```bash
   NEXT_PUBLIC_APP_URL="http://devresponse.local:3000"
   BETTER_AUTH_URL="http://devresponse.local:3000"
   ADMIN_TRUSTED_ORIGINS="http://devresponse.local:3000"
   COOKIE_DOMAIN=".devresponse.local"            # parent-domain session cookie (Option C)
   SSO_HANDOFF_ISSUER="http://devresponse.local:3000"
   SSO_HANDOFF_JWT_SECRET="<the generated value>"
   SSO_ALLOWED_ORIGIN_SUFFIXES="devresponse.local,localhost"
   ```

   > With `COOKIE_DOMAIN` set, browse the primary at `http://devresponse.local:3000` — a browser refuses a `.devresponse.local` cookie set from a `localhost` page, so sign-in via `localhost:3000` will not stick.

3. **Register the satellites by SQL** (the console's enterprise-app validator requires `https://` origins by design; the launch flow reads the stored row as-is, so local `http://` origins go in directly):

   ```sql
   insert into auth.app_enterprise_applications
     (id, label, origin, subdomain, sso_audience, status, sort_order)
   values
     ('standalone', 'App Standalone (A)', 'http://app1.devresponse.local:3001',
      'app1', 'devresponse-app:standalone', 'available', 10),
     ('handoff', 'App Handoff (B)', 'http://app2.devresponse.local:3002',
      'app2', 'devresponse-app:handoff', 'available', 20);
   ```

4. **Write each satellite's `.env.local`.** A shown; B is identical with `handoff` / `app2` / `:3002`; C follows [§5.2](#52-option-c-configuration) instead (the **primary's** `BETTER_AUTH_SECRET`, its own `http://app3.devresponse.local:3003` URLs, `COOKIE_DOMAIN=".devresponse.local"` matching the primary, `SSO_HANDOFF_*` placeholders):

   ```bash
   NEXT_PUBLIC_APP_NAME="DevResponse — Standalone (A)"
   NEXT_PUBLIC_APP_URL="http://app1.devresponse.local:3001"
   NEXT_PUBLIC_PRODUCTION_HOST="app1.devresponse.local"
   BETTER_AUTH_SECRET="<its own 32+ char secret>"
   BETTER_AUTH_URL="http://app1.devresponse.local:3001"
   ADMIN_TRUSTED_ORIGINS="http://app1.devresponse.local:3001"
   DATABASE_URL="postgresql://devresponse:devresponse@localhost:5444/devresponse_db"  # the PRIMARY's DB — same-DB topology
   DB_SCHEMA="auth"
   SSO_HANDOFF_ISSUER="http://devresponse.local:3000"
   SSO_HANDOFF_AUDIENCE_PREFIX="devresponse-app"
   SSO_HANDOFF_APPLICATION_ID="standalone"
   SSO_HANDOFF_JWT_SECRET="<the shared secret from step 2>"
   ```

5. **Run the fleet** — every app bound to its hostname:

   ```bash
   pnpm dev -H devresponse.local                                        # primary :3000
   pnpm --dir ../devresponseapps/app-standalone dev -H app1.devresponse.local
   pnpm --dir ../devresponseapps/app-handoff    dev -H app2.devresponse.local
   pnpm --dir ../devresponseapps/app-shared     dev -H app3.devresponse.local
   ```

6. **Smoke-test** per [§7](#7-smoke-test--troubleshooting): sign in at `http://devresponse.local:3000`, hit `/api/sso/launch?applicationId=standalone` (then `handoff`), and simply open `http://app3.devresponse.local:3003/en/app/dashboard` for C — already signed in, zero redirects. Or run the whole thing headlessly:

   ```bash
   node scripts/verify-local-sso.mjs   # drives Chromium through every flow; exits non-zero on failure
   ```

Why these steps look the way they do:

- **Every app runs `next dev -H <its-hostname>`.** Route handlers build absolute URLs from the request URL (the consume → confirm redirect), and the dev server normalizes unknown hosts to `localhost` unless it is bound to the hostname. The hostnames also need to be in `allowedDevOrigins` in each `next.config.mjs` (the kit and the forks ship `*.devresponse.local` + `*.localtest.me`).
- **The CSP `upgrade-insecure-requests` directive is production-only.** `localhost` is exempt (a trustworthy origin), but on an `http://*.devresponse.local` host the browser would silently upgrade every subresource *and the confirm form's POST* to `https://` — the handoff then dies with no request ever reaching the satellite. The kit and the forks guard it on `NODE_ENV === "production"`.
- A/B point at the **primary's database** locally (the same-DB topology, §4.5) so the shipped consume code works unchanged; their distinct `BETTER_AUTH_SECRET`s and per-host cookies keep the sessions separate.
- `.local` names ride the **hosts file** (Windows resolves it ahead of DNS/mDNS); if a VPN or DNS agent interferes, the `*.localtest.me` fallback needs no hosts entries at all.

### 6.7 Migration & first-boot order (A/B)

1. Provision the satellite database; run `pnpm db:app:migrate` (and the Better Auth bootstrap, per [Deployment §2](./deployment.md#2-one-time-database-bootstrap)).
2. Register the enterprise-app row + origin suffix on the primary (§3.1).
3. Deploy the satellite with the §3.2 env.
4. Smoke-test the handoff (§7) **before** announcing the app.

## 7. Smoke test & troubleshooting

**Smoke test:** sign in on the primary → visit `https://<primary>/api/sso/launch?applicationId=<your-app-id>` → you should land on the satellite's confirm page → continue → arrive signed in at `/{locale}/app/dashboard`. Then reload the satellite (session persists) and replay the consumed token URL (must be rejected).

| Symptom | Likely cause |
| --- | --- |
| Launch returns 404 / "unknown application" | No enterprise-app row for `applicationId`, or the row's status isn't available |
| Launch rejects the destination | Satellite origin not covered by `SSO_ALLOWED_ORIGIN_SUFFIXES` |
| Consume GET rejects the token | `SSO_HANDOFF_JWT_SECRET` / `ISSUER` / `AUDIENCE_PREFIX` mismatch between the two sides; or the satellite's `SSO_HANDOFF_APPLICATION_ID` doesn't match the registered audience; or >60s elapsed |
| Consume POST 401s **every** time (fresh tokens) | Separate-DB deployment without the §4.5 nonce inversion — there is no nonce row to burn |
| "unknown user" on consume | Separate-DB deployment without the §4.5 user upsert |
| Consume POST 403s | The confirm form posted cross-origin, or `ADMIN_TRUSTED_ORIGINS` doesn't include the satellite's own origin |
| Continue on the confirm page does nothing — no POST ever reaches the satellite (local http dev) | The CSP `upgrade-insecure-requests` directive upgraded the form POST to `https://` against a plain-http dev server; guard it on production (see §6.6) |
| Confirm page appears on `localhost` instead of the satellite's subdomain (local dev) | The dev server wasn't bound to the hostname — start it with `next dev -H <subdomain>` (see §6.6) |
| Signed in on primary but C satellite sees no session | `COOKIE_DOMAIN` not set to the parent domain on **both** sides, different `BETTER_AUTH_SECRET`, or different `DB_SCHEMA` |
| Sign-in on the primary stops sticking (local dev) | `COOKIE_DOMAIN` is set but you're browsing via `localhost` — a browser refuses a parent-domain cookie from a `localhost` page; use `http://devresponse.local:3000` (see §6.6) |
| Boot fails on a C satellite | Missing `SSO_HANDOFF_*` placeholders — all four are validated at boot on every fork |

More: [Troubleshooting](./troubleshooting.md) covers the kit-wide failure modes.

## 8. Security summary

- The handoff secret is HS256-symmetric: anyone holding `SSO_HANDOFF_JWT_SECRET` can mint sign-in tokens for **every** registered satellite. Store it like `BETTER_AUTH_SECRET`, keep it distinct from it, rotate it across both sides together.
- A/B satellites are separate security domains; C satellites are the same security domain as the primary. Choose accordingly, and re-read [API Security §8](./api-security.md#8-third-party-and-satellite-web-apps) before giving any external team a C-style integration.
- A satellite that needs the machine API is *also* an API client — issue it its own credential per [API Security §2](./api-security.md#2-which-credential-should-a-third-party-get); SSO artifacts are never API credentials.

---

_See also: [Design: Satellite Apps](./design-satellite-apps.md) · [API Security & Third-Party Applications](./api-security.md) · [API Reference §7 — SSO handoff](./api.md#7-sso-handoff-endpoints) · [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff) · [Deployment](./deployment.md) · [Docker](./docker.md)._
