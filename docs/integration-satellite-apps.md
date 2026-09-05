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

- **Third-party, mixed-trust, or defense-in-depth fleet → A or B (the handoff).** Each satellite keeps its own session store, its own subdomain-scoped cookie, and its own `BETTER_AUTH_SECRET`; it holds **no signing material** (handoffs are EdDSA-signed by the primary and verified against the primary's public JWKS), and the only bridge is a single-use, audience-bound, ≤60-second token. A compromised satellite is contained: it can forge nothing for the primary or for sibling satellites.
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
    P->>P: verify session + registered app,<br/>INSERT nonce (jti), sign EdDSA JWT (kid, ≤60s)
    P-->>SG: 302 …/api/sso/consume?token=…
    SG->>P: GET /api/sso/jwks.json (public keys, cached)
    SG->>SG: verify sig (by kid) + typ + iss + aud + exp + age ≤60s (no session yet)
    SG-->>SC: 302 /{locale}/sso/confirm?token=…
    SC->>SP: same-origin POST (hidden token)
    SP->>SP: trusted-origin check → re-verify →<br/>burn nonce (one-time) → create session
    SP-->>U: 303 /{locale}/app/dashboard + session cookie
```

**The token** is an **EdDSA (Ed25519)** JWT signed with the primary's `SSO_HANDOFF_PRIVATE_KEY`; the satellite verifies it against the primary's public key set at **`GET <SSO_HANDOFF_ISSUER>/api/sso/jwks.json`** (jose `createRemoteJWKSet` — cached, refetched on an unknown `kid`, cooldown-limited) and **holds no secret** (review #5):

- Header: `alg: EdDSA`, `typ: JWT`, `kid` (the JWK thumbprint, or the primary's pinned `SSO_HANDOFF_KID`). Anything else — `HS256`, `none` — is rejected before the signature is even checked.
- Claims (**minimised**, review #60 — the token rides in a query string): `jti` (one-time-use id), `sub` (Better Auth user id), `email`, `targetApplicationId`, `locale`, plus `iss`/`aud`/`iat`/`exp`. **No display name** (the satellite derives one) and **no `organizationId`, `appUserId` or `roles[]`** — no consumer read them, and the old `roles[]` was incomplete (direct roles only, no group-conferred roles). A satellite resolves membership, roles and permissions from its **own** store; if it needs the user's organization or roles from the primary, it asks the machine API with its own credential rather than trusting a URL-borne claim.
- `iss` = `SSO_HANDOFF_ISSUER`; `aud` = `<SSO_HANDOFF_AUDIENCE_PREFIX>:<applicationId>` — so a token minted for one satellite is rejected by every other.
- **Age ceiling on the receiver** (review #61): the verifier enforces `maxTokenAge: 60s` (5s clock tolerance) in addition to `exp`, so the 60-second bound holds even against a signer that failed to clamp.
- **Application-id binding:** the consumer also requires `targetApplicationId` to equal its own `SSO_HANDOFF_APPLICATION_ID` and burns the nonce only where the row's `target_application_id` matches. `aud` alone is not trusted — `sso_audience` is an admin-typed column, so this holds even if two registered apps were to carry the same audience (the catalog refuses that with `409 audience_taken`).
- **No launch while impersonating:** an impersonated primary session gets `403 forbidden_while_impersonating` from `/api/sso/launch`; a satellite session would carry no impersonation marker and be attributed to the target.
- **Rate limits:** launch is throttled per principal, consume GET/POST per trusted client IP (30-burst, 1/s); denials are `429` with `Retry-After` and write no audit row.
- TTL: the signer **hard-clamps to ≤60 seconds** regardless of `SSO_HANDOFF_TTL_SECONDS`.
- Single use: the `jti` is burned on the consume POST; replays are rejected.

**Why the GET → confirm → POST dance:** the GET leg only *verifies* — no session is created from a top-level navigation, which blocks login-CSRF/session-fixation via a pasted link. The interstitial shows the account being signed in and submits a **same-origin POST**, which is where the nonce burns and the session mints (guarded by the satellite's trusted-origin check).

## 3. The two-sided configuration contract (A & B)

### 3.1 Primary side (the issuer)

1. **Register the satellite as an enterprise application** (Administrator → Enterprise apps, `admin.apps.manage`): its `id` (**exactly** the satellite's `SSO_HANDOFF_APPLICATION_ID`), `origin` (e.g. `https://apps.example.com`) and `sso_audience` = `<prefix>:<applicationId>` (e.g. `devresponse-app:standalone`; unique across the catalog — a duplicate is refused with `409 audience_taken`), status available ([Admin Manager §8.7](./admin-manager.md#87-enterprise-applications)).
2. **Cover the satellite's host in `SSO_ALLOWED_ORIGIN_SUFFIXES`** with a **registrable domain** (`devresponse.com`, `example.co.uk` — never a bare TLD or public suffix such as `co.uk` / `github.io`, which the primary refuses at boot). **In production this is required**: when unset the primary fails closed and registers no origin at all (`origin_not_allowed`). Only outside production is an unset value derived from `NEXT_PUBLIC_PRODUCTION_HOST` — see [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff).
3. **Hold the signing key** — `SSO_HANDOFF_PRIVATE_KEY`, an Ed25519 private JWK generated with the command in [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff) (distinct from `API_JWT_PRIVATE_KEY`). Its public half is served at `GET /api/sso/jwks.json`. **Nothing secret is shared with the satellite** — it only needs two public values: `SSO_HANDOFF_ISSUER` (the primary's origin URL) and `SSO_HANDOFF_AUDIENCE_PREFIX`.

### 3.2 Satellite side (the consumer)

| Variable | Value | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_PRODUCTION_HOST` | the satellite's own identity | inlined at build time |
| `BETTER_AUTH_SECRET` | **its own** (≥32 chars) | never shared with the primary |
| `BETTER_AUTH_URL` | the satellite's own origin | |
| `DATABASE_URL` / `DB_SCHEMA` | **its own** database (or own schema on a shared instance) | `DB_SCHEMA` defaults to `auth` |
| `ADMIN_TRUSTED_ORIGINS` | the satellite's own origin | feeds Better Auth `trustedOrigins` + the origin guard on the consume POST |
| `SSO_HANDOFF_ISSUER` | the **primary's** origin URL | the satellite fetches `${SSO_HANDOFF_ISSUER}/api/sso/jwks.json` to verify — must be reachable from the satellite |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | same as primary (e.g. `devresponse-app`) | |
| `SSO_HANDOFF_APPLICATION_ID` | **unique per satellite** (e.g. `standalone`, `handoff`) | must equal the registered enterprise-app `id` (and therefore the `sso_audience` suffix) — the consumer binds every token's `targetApplicationId` to it |
| `SSO_HANDOFF_PRIVATE_KEY` | **unset** | issuer-only; a satellite holds no signing key (its own `/api/sso/launch` answers 503, which is correct — it never launches) |

The three `SSO_HANDOFF_*` values above (`ISSUER`, `AUDIENCE_PREFIX`, `APPLICATION_ID`) are validated **at boot** on every DevResponseKit-derived app — including Option C, which never uses them at runtime (set placeholders there). `SSO_HANDOFF_PRIVATE_KEY` is optional everywhere and set only on the primary.

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

2. **Mint the primary's handoff signing key** (an Ed25519 private JWK — the primary is the only holder) and set the primary's `.env`:

   ```bash
   node -e "import('jose').then(async j=>{const {privateKey}=await j.generateKeyPair('EdDSA',{extractable:true});console.log(JSON.stringify(await j.exportJWK(privateKey)))})"
   ```

   ```bash
   NEXT_PUBLIC_APP_URL="http://devresponse.local:3000"
   BETTER_AUTH_URL="http://devresponse.local:3000"
   ADMIN_TRUSTED_ORIGINS="http://devresponse.local:3000"
   COOKIE_DOMAIN=".devresponse.local"            # parent-domain session cookie (Option C)
   SSO_HANDOFF_ISSUER="http://devresponse.local:3000"
   SSO_HANDOFF_PRIVATE_KEY='<the printed JWK JSON>'
   SSO_ALLOWED_ORIGIN_SUFFIXES="devresponse.local,localhost"
   ```

   > `SSO_HANDOFF_ISSUER` equals `BETTER_AUTH_URL`, so the primary is a **self-issuer** and verifies its own handoffs against its local key set — no HTTP self-fetch. The satellites below fetch `http://devresponse.local:3000/api/sso/jwks.json`.

   > With `COOKIE_DOMAIN` set, browse the primary at `http://devresponse.local:3000` — a browser refuses a `.devresponse.local` cookie set from a `localhost` page, so sign-in via `localhost:3000` will not stick.

3. **Satellite registration — already seeded (dev only).** The baseline seed (`pnpm db:seed`, part of `db:provision` and `db:reset:reload`) registers all three satellite apps at their §6.6 origins, so a fresh **local** database's application switcher lists Option A/B/C out of the box. Under `NODE_ENV=production` the seed **skips** these demo entries (they'd be dead links; opt in with `SEED_DEMO_APPS=1` if you really want them) — production apps are registered via **Administrator → Enterprise apps**. Only if you deleted the seeded rows (or need different origins) re-register by SQL — the console's enterprise-app validator requires `https://` origins by design, but the launch flow reads the stored row as-is, so local `http://` origins go in directly:

   ```sql
   insert into auth.app_enterprise_applications
     (id, label, origin, subdomain, sso_audience, status, sort_order)
   values
     ('standalone', 'App Standalone (Option A)', 'http://app1.devresponse.local:3001',
      'app1', 'devresponse-app:standalone', 'available', 10),
     ('handoff', 'App Handoff (Option B)', 'http://app2.devresponse.local:3002',
      'app2', 'devresponse-app:handoff', 'available', 20),
     ('shared', 'App Shared (Option C)', 'http://app3.devresponse.local:3003',
      'app3', 'devresponse-app:shared', 'available', 30);
   ```

   Option C's switcher entry rides the same launch link as A/B — the handoff into an already-shared session is redundant but lands correctly signed in.

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
   SSO_HANDOFF_ISSUER="http://devresponse.local:3000"   # the satellite verifies against <issuer>/api/sso/jwks.json
   SSO_HANDOFF_AUDIENCE_PREFIX="devresponse-app"
   SSO_HANDOFF_APPLICATION_ID="standalone"
   # NO SSO_HANDOFF_PRIVATE_KEY — a satellite holds no signing material
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
- **Handoff satellites under a `COOKIE_DOMAIN` primary need their own cookie prefix.** Once the primary issues a parent-domain session cookie (this rig; any fleet that includes Option C), that cookie reaches **every** subdomain under Better Auth's default cookie name — it shadows an A/B satellite's own host-only session cookie (same name; the older cookie sorts first), fails signature validation against the satellite's secret, and the handoff appears to never stick. Give each handoff satellite a distinct `advanced.cookiePrefix` (and pass the same prefix to the proxy's `getSessionCookie` check) — the reference forks use `drk-standalone` / `drk-handoff`.
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
| Consume GET rejects the token | `SSO_HANDOFF_ISSUER` / `AUDIENCE_PREFIX` mismatch between the two sides; the satellite cannot reach `${SSO_HANDOFF_ISSUER}/api/sso/jwks.json` (or it returns `{ "keys": [] }` — the primary has no `SSO_HANDOFF_PRIVATE_KEY`); the satellite's `SSO_HANDOFF_APPLICATION_ID` doesn't match the registered audience; or >60s elapsed since `iat` (clock skew >5s counts) |
| Launch returns `503 sso_not_configured` | The primary has no `SSO_HANDOFF_PRIVATE_KEY` (audit reason `signing_key_not_configured`) — generate one per §3.1 |
| Consume rejects the token with audit reason `target_application_mismatch` | The satellite's `SSO_HANDOFF_APPLICATION_ID` differs from the enterprise-app row's `id` on the primary (the audience may still match) — make them identical |
| Launch returns `403 forbidden_while_impersonating` | You are impersonating a user on the primary; stop impersonation first — handoffs are never minted from impersonated sessions |
| Launch or consume returns `429` | Per-principal (launch) / per-IP (consume) rate limit tripped; honour `Retry-After` |
| Consume POST 401s **every** time (fresh tokens) | Separate-DB deployment without the §4.5 nonce inversion — there is no nonce row to burn |
| "unknown user" on consume | Separate-DB deployment without the §4.5 user upsert |
| Consume POST 403s | The confirm form posted cross-origin, or `ADMIN_TRUSTED_ORIGINS` doesn't include the satellite's own origin |
| Continue on the confirm page does nothing — no POST ever reaches the satellite (local http dev) | The CSP `upgrade-insecure-requests` directive upgraded the form POST to `https://` against a plain-http dev server; guard it on production (see §6.6) |
| Confirm page appears on `localhost` instead of the satellite's subdomain (local dev) | The dev server wasn't bound to the hostname — start it with `next dev -H <subdomain>` (see §6.6) |
| Signed in on primary but C satellite sees no session | `COOKIE_DOMAIN` not set to the parent domain on **both** sides, different `BETTER_AUTH_SECRET`, or different `DB_SCHEMA` |
| Sign-in on the primary stops sticking (local dev) | `COOKIE_DOMAIN` is set but you're browsing via `localhost` — a browser refuses a parent-domain cookie from a `localhost` page; use `http://devresponse.local:3000` (see §6.6) |
| Handoff completes but the satellite immediately bounces to its own sign-in | The primary's parent-domain cookie (Option C fleet) is shadowing the satellite's session cookie under the default name — give each handoff satellite a distinct `advanced.cookiePrefix` (see §6.6) |
| Boot fails on a C satellite | Missing `SSO_HANDOFF_*` placeholders — `ISSUER`, `AUDIENCE_PREFIX` and `APPLICATION_ID` are validated at boot on every fork |
| Boot fails on the primary with `SSO_HANDOFF_PRIVATE_KEY` | The value is not a JSON Ed25519 private JWK (`kty: OKP`, `crv: Ed25519`, `d` present), or it equals `API_JWT_PRIVATE_KEY` |

More: [Troubleshooting](./troubleshooting.md) covers the kit-wide failure modes.

## 8. Security summary

- The handoff is **asymmetric** (review #5): only the primary holds `SSO_HANDOFF_PRIVATE_KEY`; satellites verify against its public JWKS and can mint nothing — for themselves or for siblings. Store the private key like `BETTER_AUTH_SECRET`, keep it distinct from `API_JWT_PRIVATE_KEY`, and rotate it on the primary alone via `SSO_HANDOFF_PREVIOUS_PRIVATE_KEY` (satellites follow automatically).
- The token carries only `sub`, `email`, `locale`, `targetApplicationId` and `jti` (review #60): it rides in a URL, so it never carries organization/role context — a satellite derives authority from its own store.
- A/B satellites are separate security domains; C satellites are the same security domain as the primary. Choose accordingly, and re-read [API Security §8](./api-security.md#8-third-party-and-satellite-web-apps) before giving any external team a C-style integration.
- **Mixed fleets (C alongside A/B) have one extra rule:** the moment the primary issues a parent-domain cookie for C, that cookie reaches every subdomain — each handoff satellite must run a distinct `advanced.cookiePrefix` so the foreign cookie can't shadow its own session (§6.6). The shadowing fails *closed* (the satellite sees no session), but it looks like a broken handoff.
- The consumer never trusts `aud` alone: every token is bound to the satellite's own `SSO_HANDOFF_APPLICATION_ID` (`targetApplicationId` claim + nonce row), the catalog refuses duplicate audiences, impersonated primary sessions cannot launch, and both endpoints are rate-limited before any audit write (§2).
- A satellite that needs the machine API is *also* an API client — issue it its own credential per [API Security §2](./api-security.md#2-which-credential-should-a-third-party-get); SSO artifacts are never API credentials.

---

_See also: [Design: Satellite Apps](./design-satellite-apps.md) · [API Security & Third-Party Applications](./api-security.md) · [API Reference §7 — SSO handoff](./api.md#7-sso-handoff-endpoints) · [Configuration → SSO handoff](./configuration.md#single-sign-on-handoff) · [Deployment](./deployment.md) · [Docker](./docker.md)._
