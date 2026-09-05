---
title: Configuration
description: Every environment variable, the config files, and how local differs from production.
group: General
order: 50
---

# Configuration

_Audience: developers and DevOps. Every environment variable, the config files, and how local differs from production. The authoritative template is [`.env.example`](../.env.example)._

---

## 1. How configuration is loaded

- Environment variables are read from the process environment. Locally, copy `.env.example` to `.env`. `dotenv` is available for scripts; Next.js inlines `NEXT_PUBLIC_*` at build time.
- Server-side variables are validated in `src/lib/env.ts` — several features **fail fast at boot** if misconfigured (e.g. `API_JWT_ENABLED` without a signing key, or an email provider without its credentials).
- `NEXT_PUBLIC_*` values are **embedded in the client bundle** at build time — never put secrets in them.

## 2. Environment variables

### Application

| Variable | Required | Default (example) | Controls |
| --- | --- | --- | --- |
| `NODE_ENV` | No (defaults to development) | `development` | Standard Node environment; `production` for deploys. |
| `NEXT_PUBLIC_APP_NAME` | no | `DevResponse Enterprise` | Display name in the UI. |
| `NEXT_PUBLIC_APP_URL` | yes | `http://localhost:3000` | Public origin; trusted origin, inlined at build. |
| `NEXT_PUBLIC_PRODUCTION_HOST` | no | `app.devresponse.com` | Production host; also seeds the SSO origin-suffix default. |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | no | `en` | **Informational only — NOT read at runtime.** The canonical default lives in `src/config/i18n-config.ts`; editing this does not change behavior. |
| `NEXT_PUBLIC_SUPPORTED_LOCALES` | no | `en,fr,es,uk,pt,zh,hi,ja` | **Informational only — NOT read at runtime.** The canonical locale list lives in `src/config/i18n-config.ts`; editing this does not change behavior. |

### Authentication (Better Auth)

| Variable | Required | Controls |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | **yes** | Signing secret for sessions. Use ≥32 random bytes. Rotating it invalidates all sessions. |
| `BETTER_AUTH_URL` | **yes** | Origin where `/api/auth/*` is reachable. Must match the browser origin. Also the base origin baked into links in outbound emails — verification, password reset, and invitation accept links. |
| `ADMIN_TRUSTED_ORIGINS` | no | Extra comma-separated trusted origins for Better Auth and the admin origin guard (the app's own origin is always trusted). |
| `COOKIE_DOMAIN` | no | Parent domain for the session cookie (e.g. `.devresponse.com`). **Unset = host-only cookie (per-app isolation — the safe default).** Set only for co-trusted shared-`auth`-schema satellites (Option C), on the primary **and** every satellite alike — see [Satellite Apps §5](./integration-satellite-apps.md#5-option-c-in-detail--shared-auth-schema). |

### Database (PostgreSQL)

| Variable | Required | Controls |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Primary connection string. Use a **direct/unpooled** endpoint by default; a **pooled** endpoint additionally needs `DB_SEARCH_PATH_VIA_OPTIONS=0` + an `ALTER ROLE` (see the pooler note below). Do **not** add `?schema=…` — it is ignored by `pg`/Kysely; the schema is set via `DB_SCHEMA` (below). |
| `DATABASE_TEST_URL` | for tests | Isolated test database connection. |
| `DB_SCHEMA` | no | Schema **all** tables (app + Better Auth) are deployed into. Default `auth`. Applied at the connection level as `search_path=<DB_SCHEMA>,public`; extensions (`pgcrypto`, `pg_trgm`) stay shared in `public`. Set a different value per deployment to **isolate applications by schema**. Must be a plain SQL identifier. |
| `PGPOOL_MAX` | no | Max pool connections (default 10). |
| `PG_CONNECT_TIMEOUT_MS` | no | Connection acquisition timeout (default 5000). |
| `PG_STATEMENT_TIMEOUT_MS` | no | Per-statement server-side ceiling (default 30000). |
| `PG_IDLE_IN_TX_TIMEOUT_MS` | no | Idle-in-transaction server-side ceiling (default 30000). |
| `DB_SEARCH_PATH_VIA_OPTIONS` | no | Whether to set `search_path` via the libpq `options` startup parameter (default **on**). Set to `0` only on a **transaction-pooling** endpoint, which rejects startup parameters — see the pooler note below. |

> **Schema & connection poolers:** by default the connection sets `search_path` via the libpq `options` **startup parameter**. A **transaction-pooling** endpoint (Neon's pooled host, PgBouncer transaction mode, some Supabase tiers) **rejects startup parameters** — every connection fails with `08P01 unsupported startup parameter in options: search_path`. To run against one: **(1)** set the schema as a server-side role default the pooler honors — `ALTER ROLE <app_role> SET search_path = auth, public;` — and **(2)** set `DB_SEARCH_PATH_VIA_OPTIONS=0` so the app stops sending the rejected parameter. Migrations/seeds/reset always use the **direct** (non-pooled) endpoint (they need the parameter, plus DDL + advisory locks the pooler can't do).

### Social login (all optional — a provider activates only when both id and secret are set)

Google, Microsoft (Entra ID), and GitHub sign-in. Each provider is independent: it activates only when **both** its id and secret are present. Unlike SSO these are **not** boot-validated — a missing pair just leaves that provider inactive. The sign-in and sign-up pages render a button only for each **configured** provider; when none are set the social section (and its "or" divider) is omitted entirely.

| Variable | Controls |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth. |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft Entra ID OAuth (multi-tenant work/school accounts). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth. |

> **Redirect / callback URL — register this in every provider's console.** The path is fixed by Better Auth; the origin is your **`BETTER_AUTH_URL`**:
>
> ```
> <BETTER_AUTH_URL>/api/auth/callback/<provider>
> ```
>
> `<provider>` is literally `google`, `microsoft`, or `github` — e.g. `http://localhost:3000/api/auth/callback/google` (local) or `https://app.example.com/api/auth/callback/google` (production). Register one callback per origin you run; add the local **and** production URLs. Values are read at boot — **restart** after changing them.

#### Google — [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials

1. Create or select a project, then configure the **OAuth consent screen**: user type _External_ for public sign-up, an app name and support email. The default `email` / `profile` / `openid` scopes are all this app needs. While the screen is in _Testing_ only listed test users can sign in — **Publish** it for general availability.
2. **Create credentials → OAuth client ID → Web application**.
3. Under **Authorized redirect URIs**, add `<BETTER_AUTH_URL>/api/auth/callback/google`.
4. Copy **Client ID** → `GOOGLE_CLIENT_ID` and **Client secret** → `GOOGLE_CLIENT_SECRET`.

#### Microsoft (Entra ID) — [Microsoft Entra admin center](https://entra.microsoft.com/) → App registrations

Wired as **multi-tenant** (`tenantId: "organizations"`): any Entra work/school account can sign in; personal Microsoft accounts are excluded.

1. **New registration.** Under **Supported account types** choose _Accounts in any organizational directory (multitenant)_.
2. Add a **Redirect URI** of platform **Web** = `<BETTER_AUTH_URL>/api/auth/callback/microsoft` (during registration or later under **Authentication**).
3. From the app's **Overview**, copy **Application (client) ID** → `MICROSOFT_CLIENT_ID`.
4. **Certificates & secrets → New client secret** → copy the secret's **Value** (not its _Secret ID_) → `MICROSOFT_CLIENT_SECRET`. Client secrets **expire** — record the expiry and set a rotation reminder.

#### GitHub — [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers)

1. **New OAuth App** (personal, or an organization's OAuth Apps for an org-owned one).
2. **Homepage URL** = your `BETTER_AUTH_URL`; **Authorization callback URL** = `<BETTER_AUTH_URL>/api/auth/callback/github`.
3. Copy **Client ID** → `GITHUB_CLIENT_ID`.
4. **Generate a new client secret** → copy it immediately → `GITHUB_CLIENT_SECRET`. A GitHub OAuth App allows only **one** callback URL — use a separate app per environment.

> **After sign-in.** A social sign-up still runs through the organization's signup policy — approval mode, allowed methods, and email-domain routing — exactly like an email sign-up. See [`auth-signup-policy.md`](auth-signup-policy.md).

> **Account linking requires a VERIFIED provider email.** When a social sign-in matches an existing local account by email, the accounts are linked only if the provider asserts the address is **verified** (`trustedProviders` is deliberately empty — no provider is exempt from this check, which blocks nOAuth-style takeover via attacker-controlled Entra tenants). Google and GitHub report verification for normal accounts, so linking just works. Entra ID often **omits** the `email_verified` claim, in which case a Microsoft sign-in cannot link into an existing email/password account and is rejected; the user can keep signing in with their password, and a tenant that needs Microsoft linking should emit a verified-email optional claim (e.g. `email_verified` / `verified_primary_email`).

### Single Sign-On handoff

> **Required at boot for every deployment.** Despite the "SSO" name, `src/lib/env.ts` validates `SSO_HANDOFF_ISSUER`, `SSO_HANDOFF_AUDIENCE_PREFIX`, `SSO_HANDOFF_APPLICATION_ID`, and `SSO_HANDOFF_JWT_SECRET` **unconditionally** (`.min(1)` / `.min(32)`). The app **fails fast at boot** if any is missing — even on a deployment that never uses SSO. Set all four everywhere (placeholder values are fine when SSO is unused).

| Variable | Required | Controls |
| --- | --- | --- |
| `SSO_HANDOFF_ISSUER` | **yes (at boot)** | `iss` claim of handoff tokens. |
| `SSO_HANDOFF_AUDIENCE_PREFIX` | **yes (at boot)** | Audience is built as `<prefix>:<applicationId>`. |
| `SSO_HANDOFF_APPLICATION_ID` | **yes (at boot)** | This deployment's application id — it MUST equal the `id` of the enterprise-application row registered on the issuer. The consumer requires the token's `targetApplicationId` claim to equal it (in addition to the `<prefix>:<id>` audience check) and burns the nonce only for that id, so a token minted for another registered app is never accepted here; the value is never derived from the Host header. |
| `SSO_HANDOFF_JWT_SECRET` | **yes (at boot)** | HS256 signing secret (≥32 chars). **Must differ** from `BETTER_AUTH_SECRET`. |
| `SSO_HANDOFF_TTL_SECONDS` | no | Token lifetime (default 60). Values above 300 are rejected at boot, and the signer **clamps the effective TTL to ≤60s** (`SSO_HANDOFF_MAX_TTL_SECONDS`), so a handoff token never outlives its nonce row. |
| `SSO_ALLOWED_ORIGIN_SUFFIXES` | **yes in production** (to register apps) | Comma-separated allow-list of host suffixes a registered enterprise-app origin may use (`devresponse.com,partner.example`). **Every entry must be a registrable domain** — at least one label beyond its public suffix, checked at boot against the Public Suffix List (ICANN + private sections, via `tldts`): a bare TLD (`com`) or a public-suffix entry (`co.uk`, `github.io`) **fails boot**, because it would let an org admin register a token-harvesting origin anyone can obtain under it. **Unset in production ⇒ fails closed**: no origin can be registered (`origin_not_allowed`) and a warning is logged at boot — there is no host-derived fallback there. Outside production (dev/test) an unset value is derived from `NEXT_PUBLIC_PRODUCTION_HOST` as its registrable domain (`app.example.co.uk` → `example.co.uk`), and the literal `localhost` is tolerated for the local satellite rig. |

### Reverse proxy / limits

| Variable | Default | Controls |
| --- | --- | --- |
| `TRUSTED_PROXY_COUNT` | 1 | Number of trusted proxies/CDNs; the client IP for rate-limit keys is taken this many hops from the right of `X-Forwarded-For` (falling back to `X-Real-IP` when there is no chain). Governs **both** the app's own limiters **and** Better Auth's built-in sign-in / password-reset limiter and `session.ipAddress` — see below. |
| `ADMIN_EXPORT_MAX_ROWS` | 100000 | Hard row cap for a single CSV export; the file is marked truncated past the cap. |

**One client-IP derivation.** `src/proxy.ts` computes the trusted client IP with
the `TRUSTED_PROXY_COUNT` rule above and **always overwrites** the private request
header `x-drk-client-ip` (set when a trustworthy IP exists, removed otherwise) for
page renders and for the Better Auth catch-all (`/api/auth/*`, matched
explicitly). Better Auth is configured to read **only** that header
(`advanced.ipAddress.ipAddressHeaders` in `src/lib/auth.ts`), so its limiter keys
on the same hop the app trusts: a client cannot inject the header to land in
another user's bucket, and a multi-hop chain (CDN + load balancer) no longer
collapses every request into Better Auth's shared `no-trusted-ip` bucket
(review #35). Do **not** allow the header through from the public edge — the
proxy discards whatever arrives — and do not add `x-forwarded-for` back to
`ipAddressHeaders`: Better Auth trusts a single-value header verbatim, which lets a
client rotate buckets where the edge sets no chain. When no IP can be trusted,
requests share one bounded bucket (`anon` in the app, `no-trusted-ip` in Better
Auth) — fail closed, never fail open.

### Email

| Variable | Controls |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` \| `mailgun` \| unset. **Unset = outbox-only** (recorded, never sent) — the default for dev/CI. |
| `EMAIL_FROM` | From address/name. |
| `RESEND_API_KEY` | Resend API key (when provider = resend). |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_BASE_URL` | Mailgun config (use `https://api.eu.mailgun.net` for EU). |
| `CRON_SECRET` | Shared secret the scheduler presents (as `Authorization: Bearer …`) to `GET /api/internal/outbox-drain`, which retries `pending` outbox rows on a serverless host (no long-running `pnpm outbox:drain` process). The route **fails closed** when unset (an empty value counts as unset). Validated by the env schema: when set it must be **at least 32 chars** or the server refuses to boot — a short guessable value can never silently enable the endpoint. Vercel Cron attaches it automatically when the env var is set; see `vercel.json` + [deployment.md](./deployment.md#7-ci). |
| `OUTBOX_DRAIN_LIMIT` | Max outbox rows processed per `pnpm outbox:drain` run (default 100). The serverless `/api/internal/outbox-drain` route uses the library default of 50 instead. |

### Machine API credentials (both paths DARK by default)

The machine API (`/api/v1`) is the bearer-authenticated surface for scripts, services, and integrations — as opposed to the cookie-session admin console. It offers **two independent credential paths**, and **both are off by default**. They are separate switches, not an either/or choice: enable whichever you need (or both). Until you do, `/api/v1` answers `401` to every credential — that dark-by-default posture is intentional.

#### The two paths at a glance

| | **API keys** | **JWT access tokens** |
| --- | --- | --- |
| Enable with | `API_KEYS_ENABLED=1` | `API_JWT_ENABLED=1` **and** a signing key |
| Server-side setup | none beyond the switch | generate an Ed25519 signing key (below) |
| The bearer looks like | `drk_live_…` (opaque) | `eyJ…` (a signed EdDSA JWT) |
| Where the credential comes from | minted per-user **at runtime** (console / API) | **exchanged for** at `POST /api/v1/auth/token` |
| Lifetime | long-lived (until revoked or its optional expiry) | short (default **900 s**, capped ≤ 1 h) |
| How the server checks it | SHA-256 **hash lookup in the DB**, every request | **signature check** against the public JWKS — no DB hit |
| Revoked by | deleting the key | `jti` denylist (until the token expires) |
| Best for | the simplest setup: CLIs, cron, low-to-moderate volume | high-throughput services, third-party verifiers, or handing a short-lived down-scoped token to another process |

Both paths resolve to the **same authority model**: a credential's effective access is the **intersection of its scopes and its owner's live permissions** — it can never exceed the authority of whoever created it. Enabling a path does not grant anyone new powers; it only opens a way to authenticate as an existing principal.

#### Path 1 — API keys (the simple path)

1. Set **`API_KEYS_ENABLED=1`**. That is the entire server-side setup — there is **no key material to generate**.
2. **Mint a key.** This is the "key" for this path — a per-user credential created at runtime, *not* an environment variable:
   - **Admin console** → your API keys → **create**, or
   - `POST /api/v1/me/api-keys` (name + optional scopes/expiry).

   The `drk_…` plaintext is shown **once** — only its SHA-256 hash is stored — so capture it immediately. Losing it means minting a new one.
3. Use it directly as the bearer: `Authorization: Bearer drk_live_…`.

`API_KEY_ENV_TAG` stamps the prefix (`drk_live_…` vs `drk_test_…`) so you can tell environments apart at a glance; `API_KEY_DEFAULT_TTL_DAYS` sets the console's default expiry (unset = never expire, and the UI warns you).

#### Path 2 — JWT access tokens (the stateless path)

1. Set **`API_JWT_ENABLED=1`** *and* provide **`API_JWT_PRIVATE_KEY`**. The app **fails to boot** if the switch is on without a key (validated in `src/lib/env.ts`), so you cannot half-enable it.
2. **What the "signing key" is.** JWTs here are **EdDSA / Ed25519** — an *asymmetric* keypair, which is the crux of the difference from API keys:
   - the **private** half (`API_JWT_PRIVATE_KEY`, an Ed25519 JWK JSON string) stays on the server and **signs** tokens;
   - the **public** half is derived from it automatically and published at **`GET /api/v1/jwks.json`**, so any client or resource server verifies a token by its **signature alone** — no call back to this app. That statelessness is the entire reason to use JWTs.

   (This keypair is deliberately separate from `SSO_HANDOFF_JWT_SECRET`, which is a symmetric HS256 secret for the subdomain handoff — a different mechanism with its own secret.)
3. **Generate the signing key** — an Ed25519 private JWK, using `jose` (already a dependency):

   ```bash
   node -e "import('jose').then(async j => { const {privateKey}=await j.generateKeyPair('EdDSA',{extractable:true}); console.log(JSON.stringify(await j.exportJWK(privateKey))) })"
   ```

   Paste the printed JSON as `API_JWT_PRIVATE_KEY`. Treat it like any private key: never commit it, keep it in a secret store, and rely on the fact that only its public half ever leaves the server (via JWKS).
4. **Getting a token.** Clients never hold the signing key. They exchange an existing credential at `POST /api/v1/auth/token`, which returns a short-lived JWT:
   - `grant_type=api_key` validates a `drk_…` key — so this grant **also requires `API_KEYS_ENABLED=1`**;
   - `grant_type=client_credentials` validates a registered OAuth client (`client_id` / `client_secret`).

   A `scope` parameter can **down-scope** the token to a subset of the credential's scopes. Use the returned `access_token` as the bearer exactly like a `drk_…` key.

`API_JWT_ISSUER` / `API_JWT_AUDIENCE` set the `iss` / `aud` claims; `API_JWT_KID` pins the key id (otherwise it is the JWK thumbprint, which changes automatically with the key); `API_JWT_ACCESS_TTL_SECONDS` sets the lifetime (≤ 3600). To **rotate with zero downtime**, move the current key to `API_JWT_PREVIOUS_PRIVATE_KEY` and set a new `API_JWT_PRIVATE_KEY`: both public halves stay in JWKS during the overlap, so tokens minted before the swap keep verifying until they expire — then drop the previous key.

#### Which path should I enable?

- **A CLI, a cron job, or a single backend at low-to-moderate volume** → **API keys only**. It is the simplest path, there is nothing to generate: set `API_KEYS_ENABLED=1` and mint a key.
- **A high-throughput service, a third-party resource server that should verify tokens locally, or a need to hand a short-lived, down-scoped token to another process** → **also enable JWTs**. Signature verification via JWKS avoids a per-request DB lookup and lets verifiers you don't control validate tokens offline.
- **Both** is a common, valid combination: the long-lived API key is the *root* credential a human manages, and callers exchange it for short-lived JWTs at `POST /api/v1/auth/token`. Remember the `api_key` grant needs **both** switches on.
- **Neither** (the default) keeps `/api/v1` fully dark — the right choice until you actually have a machine consumer.

**Verify after enabling:** `GET /api/v1/jwks.json` should return your public key rather than `{"keys":[]}` (the tell-tale sign the JWT path is off or missing its key), and `curl /api/v1/me -H "Authorization: Bearer <key>"` should return `200` with your identity and effective scopes. A `401` with a valid-looking key almost always means the relevant switch isn't set on that deployment.

#### Full variable reference

| Variable | Controls |
| --- | --- |
| `API_KEYS_ENABLED` | Enable API-key auth (`1`/`true`). |
| `API_KEY_ENV_TAG` | `live` \| `test` — stamped into `drk_<tag>_…`. |
| `API_KEY_DEFAULT_TTL_DAYS` | Default key expiry (empty = never expire; UI warns). |
| `API_JWT_ENABLED` | Enable JWT access tokens (`1`/`true`). |
| `API_JWT_ISSUER` | `iss` claim (defaults to `BETTER_AUTH_URL`). |
| `API_JWT_AUDIENCE` | Expected `aud` (e.g. `devresponse-api`). |
| `API_JWT_PRIVATE_KEY` | Ed25519 private JWK as a JSON string. **Required** when JWT enabled. |
| `API_JWT_KID` | Key id (defaults to the JWK thumbprint). |
| `API_JWT_PREVIOUS_PRIVATE_KEY` | Verify-only previous signing key (the prior `API_JWT_PRIVATE_KEY`) kept during a rotation overlap — its public half stays in JWKS so tokens minted before the rotation keep verifying until they expire. Never used to mint; remove once that window drains. |
| `API_JWT_PREVIOUS_KID` | The previous key's `kid` — only needed when the deployment pins a fixed `API_JWT_KID` (otherwise the thumbprint matches automatically). |
| `API_JWT_ACCESS_TTL_SECONDS` | Token lifetime (default 900, ≤3600). |

For the request/response shapes and the scope catalog see [api.md](./api.md); for the full credential design (minting, `jti` revocation, key rotation) see [design-api-keys-and-tokens.md](./design-api-keys-and-tokens.md).

### AI agent gateway (MCP)

| Variable | Controls |
| --- | --- |
| `MCP_ENABLED` | Enable the `/api/mcp` Model Context Protocol endpoint (`1`/`true`). **Dark by default.** It authenticates with the same bearer credential as the machine API, so it also needs `API_KEYS_ENABLED` / `API_JWT_ENABLED`. See [design-mcp-agent-gateway.md](./design-mcp-agent-gateway.md). |
| `MCP_REGISTRATION_ENABLED` | Enable `POST /api/mcp/register` — RFC 7591 agent self-registration (`1`/`true`). **Dark by default.** |
| `MCP_REGISTRATION_MODE` | `approval` (default — new agents park pending admin activation) or `open` (active but scopeless). |
| `MCP_REGISTRATION_DEFAULT_ORG` | Target org slug/id used when a registration request omits `organization`. |
| `MCP_REGISTRATION_MAX_PER_ORG` | Max active OAuth clients per org before registration is refused (`0` = unlimited; default `50`). |

### Seeding

| Variable | Controls |
| --- | --- |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Local seed admin credentials. |
| `SEED_ADMIN_ADOPT_EXISTING` | Set `1` to let `db:seed` confer the admin grants on a **pre-existing** Better Auth account matching `SEED_ADMIN_EMAIL` that the seed did not create and cannot recognise as its own (not yet email-verified, or not already `superuser`). Off by default: such an account makes the seed **refuse** with exit code 1 and nothing written. Even when set, the account's password, `emailVerified` flag and status are left as found. See [Deployment §2](./deployment.md#2-one-time-database-bootstrap). |
| `SEED_DEFAULT_ORGANIZATION_SLUG` | Default org slug (e.g. `default`). |
| `DEV_SEED_PASSWORD` | Shared password for the multi-org dev fixture. |
| `DEV_SEED_ALLOW_PROD` | Set `1` to allow the dev fixture under `NODE_ENV=production` (otherwise it refuses). Does **not** lift the host guard below. |
| `DEV_SEED_ALLOW_REMOTE` | Set `1` to let `db:seed:dev` target a `DATABASE_URL` whose host is **not local** (`localhost` / `127.0.0.1` / `::1` / `0.0.0.0` / none). Off by default: a hosted URL makes the fixture refuse before opening a connection, regardless of `NODE_ENV`. Equivalent to `pnpm db:seed:dev --force`. See [Deployment §2](./deployment.md#2-one-time-database-bootstrap). |

### Observability (opt-in)

| Variable | Controls |
| --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | **Presence enables** client monitoring and the build-time plugin. |
| `SENTRY_DSN` | Server DSN (defaults to the public DSN). |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `SENTRY_ENVIRONMENT` | Environment tag (defaults to `NODE_ENV`). |
| `NEXT_PUBLIC_SENTRY_RELEASE` | Release tag (e.g. git SHA). |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_TRACES_SAMPLE_RATE` | Tracing sample rates. |
| `NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE`, `…_ERROR_SAMPLE_RATE` | Session-replay sampling. |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | **Build/CI only** — source-map upload. Never expose `SENTRY_AUTH_TOKEN` to the client. |
| `METRICS_TOKEN` | **Presence enables** the Prometheus scrape endpoint `GET /api/metrics`. The route **fails closed** when unset (401, nothing exposed; an empty value counts as unset). Validated by the env schema: when set it must be **at least 32 chars** or the server refuses to boot. Scrapers present it as `Authorization: Bearer …`; compared in constant time. See [observability.md](./observability.md#5-metrics). |
| `LOG_LEVEL` | Structured-logger level: `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`. Defaults to `info` (and to `silent` under `NODE_ENV=test`). |

### Docs viewer & test escape hatch

| Variable | Controls |
| --- | --- |
| `DOCS_SOURCE`, `DOCS_ROOT`, `DOCS_ALLOW_MDX_EXECUTION`, `DOCS_INTERNAL_VISIBLE` | In-app docs viewer (all optional; defaults serve the repo `docs/` read-only). |
| `HELP_ROOT` | Content root for the in-app help viewer (`/app/help`), the docs viewer's identical sibling. Optional; defaults to the repo `help/` folder. Shares `DOCS_SOURCE` / `DOCS_INTERNAL_VISIBLE`. |
| `AUTH_RATE_LIMIT_DISABLED` | **Test only** — disables Better Auth's built-in sign-in rate limiter. Never set in production. |

### Operations & data retention

| Variable | Default | Controls |
| --- | --- | --- |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | Graceful-shutdown drain budget (ms). On `SIGTERM`/`SIGINT` the pg pool is drained within this window so in-flight queries finish cleanly; a stuck query can never hang shutdown past it. |
| `AUDIT_RETENTION_DAYS` | 365 | Retention window for `app_audit_events`, applied by `pnpm db:prune`. A compliance record, so the window is long. Set to `0` to disable that table's time-based prune. |
| `OUTBOX_RETENTION_DAYS` | 90 | Retention window for terminal `app_outbox` rows (`sent`/`failed`/`logged`), applied by `pnpm db:prune`. `pending` rows (in-flight retries) are never pruned. Set to `0` to disable. |

## 3. Config files

| File | Purpose |
| --- | --- |
| `next.config.mjs` | Static security headers (X-Frame-Options, HSTS, Reporting-Endpoints, …), next-intl plugin, opt-in Sentry plugin. The enforcing nonce-based CSP is minted per request in `src/proxy.ts`. |
| `vitest.config.ts` | Test config + coverage thresholds (the ratchet). |
| `playwright.config.ts` | E2E/accessibility browser test config. |
| `tsconfig.json` | TypeScript (strict; path aliases). |
| `eslint.config.mjs` | Linting (`eslint-config-next` + `typescript-eslint`). |
| `.prettierrc.json` / `.prettierignore` | Formatting (with Tailwind plugin). |
| `components.json` | shadcn/ui generator config. |
| `postcss.config.mjs` | Tailwind/PostCSS. |
| `docker-compose.yml` | Local PostgreSQL service. |
| `docker/postgres/init/*.sql` | Postgres extensions on first boot (`pgcrypto`, `pg_trgm`, `vector`), installed into `public`. |
| `.npmrc`, `.gitattributes`, `.gitignore` | Tooling/VCS settings. |

## 4. Local vs production

| Concern | Local | Production |
| --- | --- | --- |
| Database | Docker `pgvector/pgvector:pg17` on port 5444 | Managed PostgreSQL 17 with `pg_trgm`; direct endpoint (or pooled — see the pooler note above) |
| DB schema | `auth` (default `DB_SCHEMA`) | `auth`, or a per-app value via `DB_SCHEMA`; extensions in `public` |
| `NODE_ENV` | `development` | `production` |
| Secrets | Placeholder values in `.env` | Real, rotated secrets from a secrets manager |
| Email | Provider unset → outbox-only | Real provider (Resend/Mailgun) |
| Machine API | Usually off | Enabled per need with real signing key |
| Observability | Off (no DSN) | Sentry DSN set; source-map upload in CI |
| HTTPS/HSTS | HTTP (HSTS inert) | TLS terminated upstream; HSTS active |
| Migrations | `pnpm db:*` ad hoc | Run as a gated step **before** serving traffic |

## 5. Minimal `.env` template

```dotenv
# --- Required everywhere ---
NODE_ENV=development
NEXT_PUBLIC_APP_URL=http://localhost:3000
BETTER_AUTH_SECRET=<32+ random bytes>
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=postgresql://devresponse:devresponse@localhost:5444/devresponse_db
DB_SCHEMA=auth

# --- Required if using SSO handoff ---
SSO_HANDOFF_ISSUER=http://localhost:3000
SSO_HANDOFF_AUDIENCE_PREFIX=devresponse-app
SSO_HANDOFF_JWT_SECRET=<different 32+ random bytes>
SSO_HANDOFF_APPLICATION_ID=portal

# --- Local seed admin ---
SEED_ADMIN_EMAIL=admin@devresponse.local
SEED_ADMIN_PASSWORD=ChangeMe-LocalOnly-123!
SEED_DEFAULT_ORGANIZATION_SLUG=default

# --- Optional features (see .env.example for the full set) ---
# EMAIL_PROVIDER=resend
# API_KEYS_ENABLED=1
# API_JWT_ENABLED=1
# NEXT_PUBLIC_SENTRY_DSN=
```

> Use [`.env.example`](../.env.example) as the complete, commented reference — it documents every variable above plus the optional ones.

## 6. Secrets checklist

- [ ] `BETTER_AUTH_SECRET` — unique, ≥32 bytes, rotated on a schedule.
- [ ] `SSO_HANDOFF_JWT_SECRET` — **different** from `BETTER_AUTH_SECRET`.
- [ ] `API_JWT_PRIVATE_KEY` — Ed25519 JWK, only if JWT enabled.
- [ ] OAuth client secrets — per provider, only if social login enabled.
- [ ] `RESEND_API_KEY` / `MAILGUN_API_KEY` — only if email enabled.
- [ ] `SENTRY_AUTH_TOKEN` — build/CI only, never client-exposed.
- [ ] `METRICS_TOKEN` — only if scraping `/api/metrics`; long random secret (≥32 chars, enforced at boot), scraper-side only.
- [ ] `CRON_SECRET` — only if a scheduler calls `/api/internal/outbox-drain`; ≥32 chars, enforced at boot.
- [ ] `DATABASE_URL` — direct endpoint by default; a pooled endpoint also needs `DB_SEARCH_PATH_VIA_OPTIONS=0` + an `ALTER ROLE` (see the pooler note above).

---

## Variables read directly (not boot-validated)

Most variables above are validated at boot by `src/lib/env.ts` — a missing or malformed **required** one fails the process immediately. A few operational knobs are instead read straight from `process.env` at the point of use, so a bad value fails (or falls back) only when that feature runs, not at boot:

| Variable | Used by | If unset |
| --- | --- | --- |
| `CRON_SECRET` | `/api/internal/outbox-drain` | endpoint fails closed (401); when set, must be ≥32 chars (boot-time check) |
| `METRICS_TOKEN` | `/api/metrics` | endpoint fails closed (401); when set, must be ≥32 chars (boot-time check) |
| `LOG_LEVEL` | the Pino logger | defaults to `info` (`silent` under test) |
| `AUDIT_RETENTION_DAYS` / `OUTBOX_RETENTION_DAYS` | `pnpm db:prune` | default 365 / 90; `0` disables |
| `SHUTDOWN_TIMEOUT_MS` | graceful-shutdown drain | defaults to 10000 ms |
| `DB_MIGRATE_LOCALES` | `pnpm db:app:migrate` | localized email-template migrations applied unless `0`/`false`/`no`/`off` (the English base `locales/0000-email-templates-en.sql` is always applied) |
| `SENTRY_*` / `NEXT_PUBLIC_SENTRY_*` | Sentry build + runtime | Sentry stays off unless a DSN is present (see [Observability](./observability.md)) |

---

_Next: [Deployment](./deployment.md) for build, release, and from-scratch stand-up._
