---
title: "Design: API Keys & Access Tokens"
description: Canonical design for the machine-credential subsystem — API keys, OAuth2 client-credentials, and EdDSA JWT access tokens behind the versioned /api/v1 surface.
group: Reference
order: 81
visibility: internal
---

# Design: API Keys & Access Tokens

_Audience: maintainers of the machine-credential subsystem. This is the canonical design doc for the credentials that authenticate the versioned `/api/v1` surface — API keys, OAuth2 client-credentials clients, and EdDSA JWT access tokens. The source under `src/lib/api-auth/**` is authoritative; section numbers here match the `design-api-keys-and-tokens.md §N` citations in those files._

Companion docs: the human-readable endpoint list and integrator walkthrough is [API Reference & Clients](./api.md), the env vars are in [Configuration](./configuration.md#machine-api-credentials-both-paths-dark-by-default), and the secret-handling policy is in [SECURITY.md](../SECURITY.md#handling-of-secrets).

---

## 1. Overview & threat model

The subsystem lets a non-browser caller authenticate to `/api/v1/**` with an `Authorization: Bearer …` header instead of a session cookie. There are three credential kinds, all converging on one resolver and one authorization rule:

| Kind | Looks like | Stored as | Verified by |
| --- | --- | --- | --- |
| API key | `drk_live_…` / `drk_test_…` | SHA-256 hash (`app_api_keys.key_hash`, unique) | Hash lookup (O(1)) |
| OAuth2 client | `client_id` `drkc_…` + secret `drkcsec_…` | SHA-256 hash of the secret | Constant-time hash compare |
| JWT access token | `eyJ…` (EdDSA) | Nothing — stateless | JWKS signature + `iss`/`aud`/`exp` |

Design principles enforced in code:

1. **No plaintext at rest.** API-key and client secrets are surfaced exactly once at creation/rotation; only a SHA-256 hash is persisted (`src/lib/api-auth/api-key.ts`, `oauth-clients.server.ts`). JWTs hold no server-side secret at all.
2. **Least privilege by construction.** A credential's authority is the **intersection** of its granted scopes and its owner's live permissions, and it can never be minted to out-scope its creator (§7).
3. **Independent keys.** The JWT signing key and audience are deliberately separate from `SSO_HANDOFF_PRIVATE_KEY` (the Ed25519 key behind the 60-second subdomain handoff, published at `/api/sso/jwks.json`) — different key, different audience, different purpose; the env schema refuses one JWK serving both.
4. **Dark by default.** Both `API_KEYS_ENABLED` and `API_JWT_ENABLED` default OFF (§10); the tables exist regardless so enabling is a config flip, not a migration.

Threats explicitly handled: secret theft at rest (hash-only storage), timing side-channels on secret comparison (constant-time compare, P2-3), bearer self-escalation (caller-aware grantability, §7), a banned owner retaining machine access (`isBetterAuthUserBanned` chokepoint, AUTH-1), cross-tenant drift (credentials resolve against their bound org, not the active-org cookie, MACHINE-1), and credential stuffing against the token endpoint (per-credential + global rate-limit floor, P2-4).

---

## 2. OAuth2 client-credentials principals

_Source: `src/lib/api-auth/oauth-clients.server.ts`._

A **client** is a named, non-human principal — the OAuth2 `client_credentials` actor. It does not have permissions of its own: it borrows a dedicated **service user's** authority (`app_oauth_clients.app_user_id` references an `app_users` row), so the same status/membership gates that apply to any user apply to the client. Its granted `scopes` are intersected with that service user's permissions exactly like any other credential (§7).

- **Identifiers.** `client_id` is `drkc_<24 base62>`; the secret is `drkcsec_<40 base62>`. The secret is shown once and stored only as a SHA-256 hash (`hashSecret`), exactly like an API key (§5).
- **Creation.** `createOauthClient` generates the id + secret, hashes the secret, and inserts the row bound to the chosen service user and org. Returns `clientSecret` once.
- **Verification.** `verifyClientCredentials(clientId, clientSecret)` looks the row up by the unique `client_id`, rejects non-`active` rows, and compares the presented secret's hash against the stored hash with **`timingSafeHexEqual`** (constant-time over the 64-char hex digests, P2-3) — a plain `!==` would short-circuit and leak digest bytes through response timing.
- **Lifecycle.** `updateOauthClient` (name/scopes), `revokeOauthClient` (status → `revoked`, idempotent on `active`), and `rotateOauthClientSecret` (re-hash a fresh secret in place, returning the new plaintext) are governed by the admin `admin.clients.*` permissions via `/api/v1/admin/oauth-clients`.

Clients exchange their credentials for a JWT at the token endpoint (§6.1); they are not themselves presented on resource requests.

---

## 3. Caller resolution

_Source: `src/lib/api-auth/resolve-caller.server.ts`._

`resolveCaller(request)` is the single entry point that understands every credential kind and returns a normalized `ResolvedCaller` (or `null`). It only answers _"who is this?"_ — status/membership and permission∩scope decisions belong to the guard (§8). Resolution order, first match wins:

1. `Authorization: Bearer drk_…` → **API key** (detected by `looksLikeApiKey`, the `drk_` product prefix). Gated on `API_KEYS_ENABLED`; verified by hash lookup; usage stamped best-effort.
2. `Authorization: Bearer eyJ…` → **JWT** (anything bearer that is not an API key). Gated on `API_JWT_ENABLED`; verified via JWKS, then the `jti` revocation check.
3. No bearer → **session cookie** via the existing `getCurrentSession()`.

The resolved shape:

```ts
interface ResolvedCaller {
  kind: "session" | "api_key" | "jwt";
  betterAuthUserId: string;
  access: UserAccessContext; // same shape cookies produce — basis for every authz check
  grantedScopes: string[] | null; // null for cookies (full authority); array for bearer
  isBearer: boolean; // bearer → CSRF/origin guard is N/A
  credentialId: string | null; // api_key id / jwt jti, for audit + per-credential rate limit
}
```

Two invariants are enforced here at the chokepoint, for **both** bearer paths:

- **AUTH-1 (banned owner).** A Better Auth ban revokes browser sessions but does not touch `app_users.status` — which is all `getUserAccessContext` reads — so a key/token would otherwise keep authenticating. `isBetterAuthUserBanned` (`src/lib/api-auth/ban-status.server.ts`) is consulted before returning, and an `unban` automatically restores machine access with no extra bookkeeping.
- **MACHINE-1 (bound tenant).** The access context is resolved against the org the credential is bound to (the key's `organization_id` / the token's `org` claim), never the `active_org` cookie, so a credential always acts in its minted tenant.

---

## 4. Database schema

_Source: `src/db/migrations/0001-initial-schema.sql` and `src/db/schema/app-schema.ts`._

Three tables back the subsystem. They are created by the baseline migration and exist whether or not the feature flags are on.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `app_api_keys` | Machine API keys | `key_hash` (unique), `key_prefix`, `scopes text[]`, `status`, `expires_at`, `app_user_id`, `organization_id`, `last_used_at`/`last_used_ip`, revocation columns |
| `app_oauth_clients` | Client-credentials principals | `client_id` (unique), `client_secret_hash`, `app_user_id` (service user), `scopes text[]`, `status` |
| `app_revoked_tokens` | JWT `jti` denylist | `jti` (PK), `expires_at`, `revoked_at`, `reason` |

Notes:

- Both `app_api_keys.app_user_id` and `app_oauth_clients.app_user_id` are `on delete cascade` references to `app_users` — deleting the owner transitively disables the credential.
- Only the **hash** is stored; there is no column that could hold a plaintext secret.
- `app_revoked_tokens` is bounded: rows are purged once `expires_at` passes (§6.4).
- `scopes` is a Postgres `text[]`; the codec/matcher in `scopes.ts` operates on string arrays (§7).

---

## 5. API keys

_Source: `src/lib/api-auth/api-key.ts` (pure codec) and `src/lib/api-auth/api-keys.server.ts` (persistence)._

### 5.1 Format

```
drk_<env>_<random>
```

- `drk` — fixed **product prefix** (`API_KEY_PRODUCT_PREFIX`). It lets the resolver distinguish a key from a JWT by inspecting the bearer token's leading bytes (`looksLikeApiKey`).
- `<env>` — `live` | `test`, stamped from `API_KEY_ENV_TAG` (the `ApiKeyEnvTag`). Purely a human/operational label.
- `<random>` — 32 base62 chars, ~190 bits of CSPRNG entropy via `globalThis.crypto.getRandomValues` (Web Crypto, so the codec runs in both the Node and edge runtimes).

The non-secret **display prefix** is `drk_<env>_<first 8 random chars>` (e.g. `drk_live_AbCd1234`), stored in `key_prefix` and safe to show in UIs.

### 5.2 Hashing at rest

Only the **SHA-256** hex digest of the plaintext is persisted, in `app_api_keys.key_hash` (unique-indexed). Verification recomputes the hash and looks it up by that index — an O(1) read with no plaintext ever at rest. A fast hash with a unique index (not bcrypt/argon2) is the correct choice here: those KDFs exist to slow brute-forcing of low-entropy human passwords, which does not apply to a 190-bit secret. `hashSecret` is the same digest, reused for OAuth client secrets (§2).

### 5.3 Lifecycle

- **Create** — `createApiKey` generates, hashes, persists, and returns `plaintext` exactly once. The owner is `app_user_id`; the key is bound to `organization_id`; `created_by` records the actor.
- **TTL** — `expires_at` is optional; `API_KEY_DEFAULT_TTL_DAYS` supplies a UI default (unset = no default expiry, and the UI warns). `verifyApiKey` rejects an expired key.
- **Revoke** — `revokeApiKey` sets `status = 'revoked'` (+ `revoked_by`/`revoked_reason`); idempotent (guarded on `status = 'active'`), returns `false` for an unknown id.
- **Rotate** — `rotateApiKey` issues a fresh key with the same owner/scopes/expiry and revokes the old one **in a single transaction** (`revoked_reason = 'rotated'`), so rotation is atomic.
- **Verify** — `verifyApiKey(plaintext)` returns the resolved key + owner identity, or `null` when unknown / non-`active` / expired. The owner's account status is checked downstream by the resolver via `getUserAccessContext`; the banned-owner check is the resolver's job (§3).
- **Usage stamp** — `touchApiKeyUsage` writes `last_used_at`/`last_used_ip` fire-and-forget; it is never awaited on the hot path and never throws into it (telemetry must not break auth).

### 5.4 The `account.apikeys.manage` scope

A signed-in user manages **their own** keys through `/api/v1/me/api-keys*` without holding any `admin.*` permission. That self-service surface is gated by the `account.apikeys.manage` account scope (§7); `account.read` covers listing. Governance of _any_ user's keys is the separate admin surface (`/api/v1/admin/api-keys`, `admin.apikeys.*`).

---

## 6. JWT access tokens & JWKS

_Source: `src/lib/api-auth/jwt.server.ts`, `src/app/api/v1/auth/token/route.ts`, `src/app/api/v1/jwks.json/route.ts`._

JWTs let high-throughput clients verify by signature instead of a per-request DB lookup. They are **EdDSA / Ed25519** (asymmetric), so resource servers verify with the public JWKS while only the issuer holds the private key.

> **Documented design deviation.** The original design proposed Better Auth's `jwt()` plugin; we sign with `jose` directly instead — it is already a dependency (no new package, no plugin-version API risk), keeps the signing key in our own env/KMS reference rather than a Better-Auth-managed table, and is trivially unit-testable offline. The public contract (asymmetric EdDSA + a `/api/v1/jwks.json` document + `kid` rotation) is identical.

### 6.1 Token endpoint — `POST /api/v1/auth/token`

OAuth2-style. Exchanges a long-lived credential for a short-lived JWT. The endpoint is itself unauthenticated (the credential _is_ the auth), rate-limited per client/IP plus a global floor, and sets `Cache-Control: no-store`.

Grants:

- `client_credentials` — `client_id` + `client_secret` (§2).
- `api_key` — an `api_key` (a `drk_…` key), gated on `API_KEYS_ENABLED`.

Flow: resolve the credential → re-check that the principal is an **active member of the credential's bound org** (MACHINE-1) → reject + audit a **banned** principal (MAPI-2; `decideSecureAccess` never reads the Better Auth `banned` flag, so this is an explicit mint-time gate) → apply optional **down-scoping** → mint. An optional `scope` parameter narrows the token to a subset of the credential's scopes; a requested scope that exceeds the credential is rejected with `invalid_scope` (never a superset). Success emits a `token.issued` audit event; failures use `invalid_client` / `unsupported_grant_type` / `invalid_scope`.

### 6.2 Minting & claims

`mintAccessToken` signs with the private key from `API_JWT_PRIVATE_KEY`:

| Claim | Value |
| --- | --- |
| `alg` (header) | `EdDSA` |
| `kid` (header) | `API_JWT_KID`, else the JWK thumbprint |
| `iss` | `API_JWT_ISSUER`, defaulting to `BETTER_AUTH_URL` |
| `aud` | `API_JWT_AUDIENCE` (default `devresponse-api`) |
| `sub` | the principal's Better Auth user id |
| `scope` | space-delimited effective scopes |
| `org` | the bound organization id |
| `jti` | a UUID — used for revocation (§6.4) + audit |
| `exp` | now + `API_JWT_ACCESS_TTL_SECONDS` (default 900, hard-capped ≤ 3600) |

The signing key is an Ed25519 JWK JSON string (containing the private `d` member). `getKeyMaterial` parses it, imports the signing key, derives the public JWK (stripping `d`, stamping `alg`/`use`/`kid`), and caches the result.

### 6.3 JWKS publication — `GET /api/v1/jwks.json`

Publishes the public JSON Web Key Set used to verify issued tokens. Public, unauthenticated, and cacheable (`Cache-Control: public, max-age=300`) — verifiers hold no signing secret. When issuance is disabled (or no key is configured) it returns a well-formed **empty** key set (`{ "keys": [] }`, 200) rather than an error.

> The canonical `/.well-known/jwks.json` location can be added later via a rewrite; Next.js route folders cannot begin with a dot.

### 6.4 Key rotation & verify-only window

_Source: `getPublicJwks` / `verifyAccessToken` (P3-7) and `src/lib/env.ts`._

The published/verified key set is the **current** signing key plus an **optional previous** key:

- `API_JWT_PRIVATE_KEY` / `API_JWT_KID` — the current key. The only key used to **mint**.
- `API_JWT_PREVIOUS_PRIVATE_KEY` / `API_JWT_PREVIOUS_KID` — the prior key during a rotation overlap. Its **public half only** is published and accepted; it is **never** imported as a signing key.

`verifyAccessToken` builds a local JWK Set (current + previous) and `jose` selects the key by the token's `kid`, so a token minted with either key verifies during the overlap. To rotate with **zero downtime**: move the old `API_JWT_PRIVATE_KEY` to `API_JWT_PREVIOUS_PRIVATE_KEY`, set the new key as `API_JWT_PRIVATE_KEY`, then remove the previous entry once the window drains (≤ `API_JWT_ACCESS_TTL_SECONDS`, since every pre-rotation token has expired by then). When the deployment relies on the JWK thumbprint for `kid` (no pinned `API_JWT_KID`), the previous key's `kid` matches automatically and `API_JWT_PREVIOUS_KID` is unnecessary.

### 6.5 `jti` revocation

_Source: `src/lib/api-auth/revocation.server.ts`._

Access tokens are stateless, so killing one before its natural `exp` means recording its `jti` in `app_revoked_tokens`; the resolver rejects any token whose `jti` is present (`isJtiRevoked`). `revokeJti(jti, expiresAt, reason?)` is idempotent (`on conflict do nothing`) and **opportunistically prunes** expired rows on every write — it is the table's only writer, so this keeps the table bounded to live revocations without a scheduled job (D3); the scheduled `pnpm db:prune` covers deployments that never revoke. After a token's `exp`, the signature/exp check rejects it regardless, so the row is safe to drop.

> **Current wiring status.** The read side (`isJtiRevoked`) is enforced on every JWT resolution, but **no route or lifecycle event calls `revokeJti` yet** — revoking a key/client stops *minting*, and it does not denylist already-issued tokens. Today the operational way to kill an outstanding, unexpired JWT is to **ban its owner** (AUTH-1 cuts machine access immediately, §3); otherwise it dies at `exp` (≤15 min by default). Wire `revokeJti` into a revocation flow before advertising per-token revocation to integrators.

---

## 7. Scope model & the intersection rule

_Source: `src/lib/api-auth/scopes.ts`._

**Scopes ARE the existing permission vocabulary.** The catalog a credential may be granted (`API_SCOPE_CATALOG`) is every `admin.*` permission key (`ANY_ADMIN_PERMISSION` from `src/lib/admin/permissions.ts`) plus a small set of user-level `account.*` scopes. Expressing a credential's authority in the same terms `requireAdminPermission` already enforces means a credential can never invent authority the permission model doesn't understand. The module is intentionally pure (no IO, no `server-only`) so route handlers, the resolver, seed/tooling, and tests share one matcher.

`ACCOUNT_SCOPES` (self-service, **not** `app_permissions` rows; gate the strictly self-scoped `/api/account/*` + `/api/v1/me/*` routes that need only an active membership):

- `account.read` — `GET /api/v1/me`, `GET /api/v1/me/api-keys`
- `account.profile.write` — `PATCH /api/account/profile`
- `account.preferences.write` — `PUT /api/account/preferences`
- `account.apikeys.manage` — `POST /api/v1/me/api-keys`, `DELETE`/`rotate` on `/api/v1/me/api-keys/[id]`

Every self-service handler passes its scope literal to `requireAccountUser(request, scope)`; a bearer credential lacking it is refused with `403 insufficient_scope` before any write, while a cookie session (`grantedScopes === null`) passes unconditionally. A source scan in `tests/unit/admin-route-scope-invariant.test.ts` fails CI if a `/api/account/*` or `/api/v1/me/*` handler calls the guard without a scope.

### Matching

- **Exact** — a granted scope equal to the required permission matches.
- **Wildcard** — a granted scope ending in `.*` matches any required key sharing the prefix (e.g. `admin.users.*` ⊇ `admin.users.read`). The stored grant may use a wildcard; the matcher expands it at check time so authorization stays explicit and auditable.
- **`*`** — full-authority sugar (rarely issued).
- `scopesAuthorize(grantedScopes, required)` — `null` grant means "no scope restriction" (cookie sessions carry the principal's full authority); bearer credentials always pass an explicit (possibly empty) array.

### The intersection rule (least privilege by construction)

A credential's effective authority is **`scopes ∩ owner's live permissions`**. This is enforced at two moments:

1. **At use** — the guard requires `caller.access.permissions.includes(perm) && scopesAuthorize(caller.grantedScopes, perm)` (§8). Even a key carrying `admin.users.delete` does nothing once its owner loses that permission.
2. **At creation** — a credential can never be minted to out-scope its creator:
   - `ungrantableScopes(creatorPermissions, requested)` — `account.*` is always self-grantable (it only ever acts on the creator's own account); every other scope must be a permission the creator currently holds; unknown scopes are rejected. A wildcard is grantable only if the creator holds **every** catalog key under the prefix.
   - `ungrantableScopesForCaller(callerPermissions, callerGrantedScopes, requested)` closes the **bearer self-escalation** gap: a cookie caller (`callerGrantedScopes === null`) delegates with full user authority, but a **bearer** caller may delegate only scopes it already holds — so a narrowly-scoped key can never mint a broader one.

`normalizeScopes` dedupes and parses both array and OAuth space-delimited string inputs.

---

## 8. Guard & error model

### 8.1 problem+json, ETags, optimistic concurrency

_Source: `src/lib/api-auth/problem.ts` and `src/lib/api-auth/etag.ts`._

The `/api/v1` surface speaks RFC 7807 **`application/problem+json`** (the admin console uses its own `{ error, message, requestId }` envelope). `problemResponse(code, status, request, options)` maps an internal machine code to a problem document:

- `type` — a stable URN per code (`https://devresponse.com/problems/<code>`), so clients can switch on it.
- `title` — short human summary (from a fixed map).
- `status`, `code` (snake_case machine code), `detail` (never backend exception text), `requestId` (correlates with the `x-request-id` header and audit rows).
- 5xx responses are logged to stdout (OPS-OBS-2) and, when a `cause` is supplied, captured to Sentry (D4).

Optimistic concurrency uses **weak ETags** derived from a row's `updated_at`: `userEtag` builds `W/"<iso>"`; `ifMatchSatisfied` evaluates an inbound `If-Match` (absent = last-write-wins; `*` = any; else exact match), and a stale write is rejected with `412 Precondition Failed`.

### 8.2 The guard — `requireApiPermission`

_Source: `src/lib/api-auth/v1-guard.server.ts`._

Mirrors `requireAdminPermission` but speaks problem+json and exposes the resolved caller for audit + per-credential rate limiting. The authorization decision is identical to the cookie surface: same status/membership gate (`decideSecureAccess`), same **permission ∩ scope** rule. The CSRF/origin guard runs only for **ambient** (cookie) credentials — bearer credentials are non-ambient (`isBearer`), so it does not apply. A denied request emits an `api.access.denied` audit event and a `403` carrying `detail: "The credential lacks the required permission or scope."`. `requireAccountUser` (`src/lib/account/guard.server.ts`) is the parallel guard for the `account.*` self-service surface.

---

## 9. Secret handling

_Cross-reference: [SECURITY.md → Handling of secrets](../SECURITY.md#handling-of-secrets) and [API Reference §9](./api.md#8-secret-handling-notes)._

- API-key and OAuth-client secrets are returned **once** at creation/rotation and stored only as SHA-256 hashes. There is **no** endpoint to retrieve a secret again — losing it means rotating.
- Never log or echo a plaintext credential. Audit events record metadata only (credential id / `jti` / `client_id`, scopes, grant type) — never the secret.
- The JWT signing key (`API_JWT_PRIVATE_KEY`) is an env/KMS-referenced Ed25519 private JWK, independent from `SSO_HANDOFF_PRIVATE_KEY`. Only the public half ever leaves the server (JWKS).
- Secret comparison for OAuth clients is constant-time (`timingSafeHexEqual`, P2-3).

---

## 10. Enablement, rate limiting & security properties

### 10.1 Dark by default — how to enable

_Source: `src/lib/env.ts`; full reference in [Configuration](./configuration.md#machine-api-credentials-both-paths-dark-by-default)._

Both paths default **OFF**. With neither flag set, a bearer token on `/api/v1` resolves to `null` (401) and the token endpoint returns `unsupported_grant_type`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_KEYS_ENABLED` | off | Master switch for the API-key path |
| `API_KEY_ENV_TAG` | `live` | Stamped into the key prefix (`drk_<tag>_…`) |
| `API_KEY_DEFAULT_TTL_DAYS` | unset | UI default key lifetime (unset = no default expiry) |
| `API_JWT_ENABLED` | off | Master switch for JWT access tokens + JWKS |
| `API_JWT_PRIVATE_KEY` | unset | Ed25519 private JWK (JSON). **Required** when `API_JWT_ENABLED` |
| `API_JWT_KID` | thumbprint | Optional explicit key id |
| `API_JWT_PREVIOUS_PRIVATE_KEY` / `API_JWT_PREVIOUS_KID` | unset | Previous key for the rotation overlap (§6.4) |
| `API_JWT_ISSUER` | `BETTER_AUTH_URL` | JWT `iss` |
| `API_JWT_AUDIENCE` | `devresponse-api` | JWT `aud` |
| `API_JWT_ACCESS_TTL_SECONDS` | `900` | Token lifetime, capped ≤ 3600 |

`src/lib/env.ts` fails **at boot** (not at first mint) if `API_JWT_ENABLED` is set without `API_JWT_PRIVATE_KEY`.

### 10.2 Rate limiting

- **Per-credential mutations** — `enforceApiRateLimit` keys the bucket on the credential id (`api_key` id / `jti` / `client_id`) when bearer, else the principal, so one noisy key cannot exhaust the principal's whole budget. Returns a problem+json `429` with `Retry-After`.
- **Token endpoint** — three layers, none keyed on an unverified client-supplied value (P2-4, review #11). Before any crypto or DB work: a coarse **global floor** independent of the request, then a **per-trusted-IP** bucket (the IP is derived from a trusted proxy hop, `TRUSTED_PROXY_COUNT`, not the spoofable leftmost `X-Forwarded-For`). Only **after** the credential verifies does a **per-credential** bucket (keyed on the verified `client_id` / API-key id) apply, giving each credential a fair share behind a shared egress IP. Because the public `client_id` never reaches a limiter key before verification, a remote party who merely knows a victim's id cannot drain the victim's budget with wrong secrets, rotating ids cannot escape the per-IP bucket, and unknown ids never allocate limiter entries. Denials return a problem+json `429` with `Retry-After` and count toward the `devresponsekit_rate_limit_denials_total{scope="api.token"}` metric.

### 10.3 Security properties (summary)

- **Confidentiality at rest** — no plaintext secret is ever stored; JWTs hold no server secret.
- **Least privilege** — `scopes ∩ owner permissions`, enforced at both creation and use; no credential out-scopes its creator (§7).
- **Tenant isolation** — credentials act in their bound org, not the active-org cookie (MACHINE-1).
- **Revocation completeness** — keys/clients via `status`; a Better Auth ban immediately stops all of a user's machine credentials **including outstanding JWTs** (AUTH-1), and `unban` restores them. The `jti` denylist is enforced at resolution but has no writer wired yet (§6.5) — until it does, ban-the-owner is the per-token kill switch.
- **Side-channel resistance** — constant-time secret comparison (P2-3).
- **Auditability** — every issuance/denial writes an audit event with a `requestId` that matches the response `x-request-id` header.

---

_See also: [API Reference & Clients](./api.md) · [Configuration](./configuration.md) · [SECURITY.md](../SECURITY.md)._
