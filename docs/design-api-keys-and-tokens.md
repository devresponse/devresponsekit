# Design: API Keys, JWT Tokens & a RESTful API Surface

> **Status:** ✅ Implemented (backend). The design below has been built;
> see [Implementation status](#0-implementation-status) for what shipped,
> the small deviations from the original proposal, and what was
> intentionally deferred. It extends the findings in
> [`docs/api-and-cli-guide.md`](api-and-cli-guide.md), which established
> that the application previously authenticated **only** by Better Auth
> session cookie — there is no longer that limitation.

---

## 0. Implementation status

**Built (Phases 1–5 backend), `pnpm typecheck` + `pnpm lint` + `pnpm build`
+ unit tests all green:**

- **Phase 1 — resolver & schema.** The credential tables (`app_api_keys`,
  `app_oauth_clients`, `app_revoked_tokens` + the four
  `admin.{apikeys,clients}.*` permissions) — now folded into the single
  `0001-initial-schema.sql` — plus Kysely types, and the keystone
  [`resolveCaller`](../src/lib/api-auth/resolve-caller.server.ts).
  `requireAdminPermission` and `requireAccountUser` were refactored to use
  it, with the **bearer-aware conditional origin guard** (§10.3) and the
  **scope ∩ permission** rule (§7). Existing cookie routes are unchanged.
- **Phase 2 — API keys.** Codec + store + self-service management
  (`/api/v1/me/api-keys` GET/POST/`[id]` DELETE/`[id]/rotate`), per-key
  hashing, audit, and the bearer **self-escalation guard**
  (`ungrantableScopesForCaller`).
- **Phase 3 — JWT + JWKS.** `/api/v1/auth/token` (api_key +
  client_credentials grants), `/api/v1/jwks.json`, `jti` revocation.
- **Phase 4 — OAuth clients.** Store + admin management
  (`/api/v1/admin/oauth-clients` + `/rotate-secret`).
- **Phase 5 — REST surface.** problem+json, ETag/If-Match, per-credential
  rate limiting, `/api/v1/{me,users,users/[id],users/[id]/status,
  audit-events,admin/api-keys}`, and a generated `/api/v1/openapi.json`.
- **Phase 6 — management UI (API keys).** In-app pages so keys are
  managed without curl:
  - **Administrator** governance console at
    [`/app/administrator/api-keys`](../src/app/[locale]/(secure)/app/administrator/api-keys/page.tsx),
    cookie-session + permission-gated, backed by the
    `/api/administrator/api-keys` routes — list across all users/orgs
    (joined to owner email), issue **on behalf of** a user, rotate, and
    revoke. Lives under a new **APIs** nav group; see
    [admin-manager.md §8.12](admin-manager.md).
  - **Account** self-service page at
    [`/app/account/api-keys`](../src/app/[locale]/(secure)/app/account/api-keys/page.tsx),
    backed by `/api/v1/me/api-keys` — a user lists, creates (with a
    scope picker limited to what they may grant), rotates, and revokes
    **their own** keys.

  Both surfaces reveal the plaintext **exactly once** on create/rotate
  and never display the hash. OAuth-client management remains REST-only
  (no UI yet — see *Deferred*).

**Deviations from the original proposal (all deliberate):**

1. **JWT via `jose`, not the Better Auth `jwt()` plugin.** `jose` is
   already a dependency, keeps the signing key in our own env/KMS, and is
   unit-testable offline; the public contract (EdDSA + JWKS + `kid`) is
   identical. See the note in
   [`jwt.server.ts`](../src/lib/api-auth/jwt.server.ts).
2. **`:action` / `:rotate` verbs → `/status`, `/rotate`, `/rotate-secret`
   sub-resources.** Next.js route segments cannot contain `:`.
3. **JWKS at `/api/v1/jwks.json`** (Next.js folders cannot start with a
   dot); the canonical `/.well-known/jwks.json` can be added via a rewrite.

**Deferred (not yet built):**

- The in-app **OAuth-clients** management UI (§9.2). The **API-keys**
  management UI shipped for both the administrator and self-service
  surfaces (Phase 6 above); OAuth clients remain REST-only for now.
- **Full 1:1 REST parity** for every admin resource — the `/api/v1`
  adapter pattern + a representative resource set are in place; extending
  to the remaining resources is mechanical (each is a thin adapter over an
  existing shared module).
- **`Idempotency-Key`** replay store (ETag/If-Match optimistic concurrency
  *is* implemented).
- DB-backed integration/security/e2e tests for the new endpoints (pure
  logic is unit-tested: codec, scopes, JWT round-trip, problem+json,
  ETag, OpenAPI). They require a live Postgres + Better Auth schema.

To enable: set `API_KEYS_ENABLED` / `API_JWT_ENABLED` (+ `API_JWT_PRIVATE_KEY`)
per [`.env.example`](../.env.example), then `pnpm db:app:migrate`.
>
> **Goal:** add first-class, rotatable, scoped machine credentials (API
> keys and JWT access tokens) and standardize a versioned RESTful API
> surface, **without** weakening the existing cookie + permission-catalog
> + audit model. Every new credential flows through the *same*
> authorization, rate-limiting, and audit pipeline that
> `requireAdminPermission` enforces today.

---

## Table of contents

1. [Design principles](#1-design-principles)
2. [Credential taxonomy](#2-credential-taxonomy)
3. [The keystone: a unified caller resolver](#3-the-keystone-a-unified-caller-resolver)
4. [Data model](#4-data-model)
5. [API key lifecycle](#5-api-key-lifecycle)
6. [JWT access tokens & JWKS](#6-jwt-access-tokens--jwks)
7. [Scoping model: scopes ⊆ permissions](#7-scoping-model-scopes--permissions)
8. [The RESTful surface (`/api/v1`)](#8-the-restful-surface-apiv1)
9. [Management endpoints](#9-management-endpoints)
10. [Security design](#10-security-design)
11. [Environment & configuration](#11-environment--configuration)
12. [Build vs. buy: Better Auth plugins](#12-build-vs-buy-better-auth-plugins)
13. [Phased delivery plan](#13-phased-delivery-plan)
14. [Test plan](#14-test-plan)
15. [Open questions / future work](#15-open-questions--future-work)

---

## 1. Design principles

1. **One authorization model.** API keys and JWTs resolve to the *same*
   `UserAccessContext` ([`src/lib/auth-status.ts`](../src/lib/auth-status.ts))
   that cookies resolve to. `requireAdminPermission`
   ([`src/lib/admin/permissions.server.ts`](../src/lib/admin/permissions.server.ts))
   and `requireAccountUser` change **only** in how they obtain the
   principal — never in how they decide.
2. **Least privilege by construction.** A credential's effective
   permissions are the **intersection** of its grantor's permissions and
   the scopes stamped on the credential. A key can never out-scope the
   human who minted it.
3. **No new secrets at rest.** API keys are stored **hashed** (SHA-256);
   the plaintext is shown **once**. JWTs are **stateless** and verified
   by signature, with a small revocation list for early kill.
4. **Defense-in-depth preserved.** Rate limiting, audit logging, and
   request-id correlation apply to every credential type. The CSRF
   origin guard is correctly **relaxed for non-ambient credentials**
   (see [§10.3](#103-csrf-the-origin-guard-and-bearer-auth)).
5. **Standard REST.** A versioned `/api/v1` surface with consistent
   envelopes, pagination, problem+json errors, idempotency, optimistic
   concurrency, and a published OpenAPI 3.1 document.
6. **Backwards compatible.** Existing cookie-based browser flows and the
   current `/api/administrator/*` routes keep working unchanged; the new
   surface is additive.

---

## 2. Credential taxonomy

Three credential types, chosen per use case:

| Type | Format | Lifetime | Verification | Best for |
| --- | --- | --- | --- | --- |
| **API key** | opaque `drk_live_<base62>` | long-lived, rotatable | DB hash lookup (1 indexed read) | server-to-server scripts, CLIs, CI |
| **JWT access token** | signed JWT (EdDSA) | short (default 15 min) | stateless via JWKS + revocation check | high-throughput clients that exchange a key/secret once, then call many times |
| **OAuth2 client credentials** | `client_id` + `client_secret` → JWT | secret long-lived, token short | token endpoint | named machine identities (a service, not a person) |

API keys and JWTs are the primary deliverables; client-credentials is the
"machine identity" wrapper around the same JWT issuance (a client is just
a non-human principal that owns scopes). All three are presented as
`Authorization: Bearer <credential>`.

---

## 3. The keystone: a unified caller resolver

The single most important change. Today, authority enters the system in
exactly one place: `getCurrentSession()`
([`src/lib/auth-guard.ts`](../src/lib/auth-guard.ts)) reads the cookie.
We introduce `resolveCaller(request)` as the **one** entry point that
understands every credential type and returns a normalized principal.

```ts
// src/lib/api-auth/resolve-caller.server.ts  (new)
import "server-only";

export type CallerKind = "session" | "api_key" | "jwt";

export interface ResolvedCaller {
  kind: CallerKind;
  betterAuthUserId: string;          // the principal identity
  access: UserAccessContext;         // SAME shape cookies produce today
  /** Scopes carried by the credential; null for cookies (full user authority). */
  grantedScopes: string[] | null;
  /** True when the credential is non-ambient (bearer) → CSRF-exempt. */
  isBearer: boolean;
  credentialId: string | null;       // api_key id / jwt jti, for audit + rate limit
  requestId: string;
}

/**
 * Resolution order (first match wins):
 *   1. `Authorization: Bearer drk_…`  → API key path (hash lookup).
 *   2. `Authorization: Bearer eyJ…`   → JWT path (JWKS verify + jti revocation).
 *   3. Session cookie                 → existing getCurrentSession().
 * Returns null when no credential resolves.
 */
export async function resolveCaller(
  request: NextRequest,
): Promise<ResolvedCaller | null> { /* … */ }
```

`requireAdminPermission` is refactored to call `resolveCaller` instead of
`getCurrentSession`, then apply **one extra gate** unique to credentials:
the requested permission must be in **both** `access.permissions` **and**
(`grantedScopes ?? access.permissions`). Everything downstream — status
decision, audit, deny rows — is unchanged. The same refactor applies to
`requireAccountUser` ([`src/lib/account/guard.server.ts`](../src/lib/account/guard.server.ts)).

This keeps the blast radius tiny: **two guard functions change; zero
route handlers change.** Every existing `/api/administrator/*` endpoint
gains API-key/JWT support for free, gated by the same permission keys.

---

## 4. Data model

The credential `app_*` tables are part of the single consolidated
[`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql)
(the DDL below is reproduced from it; see
[`docs/setup-better-auth.md`](setup-better-auth.md) §2.2).

```sql
-- Machine API keys. Plaintext is NEVER stored; only a SHA-256 hash.
create table if not exists app_api_keys (
  id              uuid primary key default gen_random_uuid(),
  -- Owner: the app user whose authority the key borrows. Deleting/blocking
  -- the user transitively disables the key (resolver re-checks status).
  app_user_id     uuid not null references app_users(id) on delete cascade,
  organization_id uuid references app_organizations(id),
  name            text not null,                 -- human label, e.g. "CI deploy bot"
  key_prefix      text not null,                 -- shown in UI, e.g. "drk_live_AbCd1234" (8 random chars)
  key_hash        text not null unique,          -- sha256(plaintext)
  scopes          text[] not null default '{}',  -- subset of the permission catalog
  status          text not null default 'active',-- active | revoked
  expires_at      timestamptz,                   -- null = no expiry (discouraged)
  last_used_at    timestamptz,
  last_used_ip    inet,
  created_by      uuid references app_users(id),
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      uuid references app_users(id),
  revoked_reason  text
);
create index if not exists idx_app_api_keys_user   on app_api_keys(app_user_id);
create index if not exists idx_app_api_keys_status  on app_api_keys(status);

-- Named machine identities (OAuth2 client-credentials principals).
create table if not exists app_oauth_clients (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null unique,         -- public, format: drkc_<24 base62>
  client_secret_hash text not null,              -- sha256(secret); secret format: drkcsec_<40 base62>, shown once
  app_user_id      uuid not null references app_users(id) on delete cascade, -- service principal row
  organization_id  uuid references app_organizations(id),
  name             text not null,
  scopes           text[] not null default '{}',
  status           text not null default 'active',
  created_at       timestamptz not null default now(),
  created_by       uuid references app_users(id),
  revoked_at       timestamptz,                  -- set when status → revoked
  revoked_by       uuid references app_users(id)
);
-- (0001-initial-schema.sql also adds indexes
--  idx_app_oauth_clients_status and idx_app_api_keys_org.)

-- Revocation list for stateless JWTs killed before natural expiry.
-- Small + short-lived: rows are purged once `expires_at` passes.
create table if not exists app_revoked_tokens (
  jti         text primary key,
  expires_at  timestamptz not null,
  revoked_at  timestamptz not null default now(),
  reason      text
);
create index if not exists idx_app_revoked_tokens_exp on app_revoked_tokens(expires_at);
```

Notes:

- A key/client **borrows a principal** (`app_user_id`) rather than
  carrying standalone permissions, so the existing
  `getUserAccessContext` join produces the principal's permission set and
  the resolver intersects it with `scopes`. This guarantees principle #2
  with no parallel authorization table.
- For OAuth clients, the `app_user_id` points at a dedicated **service
  user** row (a real `app_users` row with `status='active'` and a
  service-only membership), so the same status/membership gates apply.

---

## 5. API key lifecycle

### 5.1 Issuance

Plaintext format: `drk_<env>_<32-char base62 random>` where `<env>` ∈
`live`/`test`. On create:

1. Generate 32 base62 chars of CSPRNG entropy (~190 bits) → base62.
2. `key_prefix` = the first 8 chars after the env tag (for display).
3. `key_hash` = `sha256(plaintext)` (keys are high-entropy, so a fast
   hash with a unique index is appropriate — bcrypt/argon2 are for
   low-entropy human passwords, not high-entropy random tokens).
4. Persist row; **return plaintext exactly once** in the create
   response. It is never recoverable afterward.

### 5.2 Presentation & verification

Client sends `Authorization: Bearer drk_live_…`. The resolver:

1. Detects the `drk_` prefix → API-key path.
2. `sha256` the presented value, look up by `key_hash` (unique index).
3. Reject if not found / `status != 'active'` / `expires_at` passed.
4. Load the owner's `UserAccessContext`; reject if the **owner** is not
   `active` with an active membership (a revoked human kills their keys).
5. Best-effort async update of `last_used_at` / `last_used_ip` (fire and
   forget; never block the request).

### 5.3 Rotation & revocation

- **Rotation** = issue a new key, then revoke the old one after a grace
  window. The management API supports `POST /…/keys/{id}/rotate` which
  returns a fresh plaintext and marks the old key `status='revoked'` with
  a configurable `graceSeconds` (default 0).
- **Revocation** = `DELETE /…/keys/{id}` → `status='revoked'`,
  `revoked_at/by/reason` set. Takes effect on the next request (no
  caching of key→principal beyond a single request).
- **Expiry** is enforced at verify time. The management UI warns when a
  key has `expires_at = null`.

### 5.4 Audit

Every issuance, rotation, and revocation is audited via the existing
[`auditEvent`](../src/lib/audit.server.ts) with event types
`api_key.created` / `.rotated` / `.revoked` (refused machine calls emit
`api.access.denied`; see §10.5). The key **plaintext and hash are never**
placed in `metadata` (the auditor's contract already forbids secrets).

---

## 6. JWT access tokens & JWKS

For high-throughput clients, a per-request DB hash lookup is avoidable.
A client exchanges a long-lived credential (API key or client secret)
**once** for a short-lived JWT, then makes many calls verified by
signature alone.

### 6.1 Issuance — the token endpoint

```
POST /api/v1/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
client_id=…&client_secret=…
scope=admin.users.read admin.audit.read       # optional down-scoping
```

(Also accepts `grant_type=api_key` with `api_key=drk_live_…` for clients
that prefer keys over client_id/secret.)

Response:

```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "admin.users.read admin.audit.read"
}
```

### 6.2 Claims

```jsonc
{
  "iss": "https://app.devresponse.com",
  "sub": "<better_auth_user_id>",        // the principal
  "aud": "devresponse-api",
  "jti": "<uuid>",                        // for revocation + audit
  "scope": "admin.users.read …",          // space-delimited, ⊆ principal perms
  "org": "<organization_id>",
  "iat": 1234567890,
  "exp": 1234568790
}
```

### 6.3 Signing & JWKS

- **Asymmetric (EdDSA / Ed25519)**, *not* the HS256 shared-secret scheme
  the SSO handoff uses. Rationale: a public API benefits from resource
  servers and downstream services verifying tokens **without** holding a
  signing secret.
- Publish the public key set at **`GET /api/v1/jwks.json`** (cacheable,
  no auth). (The canonical `/.well-known/jwks.json` is **not** served
  today — it could be added later via a rewrite.) Private key material
  lives only in the issuer (`API_JWT_PRIVATE_KEY` env, or a KMS).
- **Key rotation** via `kid` header: keep current + previous public keys
  in the JWKS during overlap so in-flight tokens stay valid.

> This is deliberately a **separate** keypair and audience from
> `SSO_HANDOFF_JWT_SECRET` — that secret keeps its single, narrow purpose
> (60-second subdomain handoff), per the "independent secrets" rule in
> [`docs/setup-better-auth.md`](setup-better-auth.md) §7.

### 6.4 Verification & revocation

The resolver's JWT path: verify signature against JWKS → check
`exp`/`aud`/`iss` → check `jti` is **not** in `app_revoked_tokens` (one
indexed lookup; the table is small and TTL-pruned) → load principal
context. Stateless verification keeps the hot path cheap; the revocation
check buys "kill it now" without per-request principal joins on the JWT
path being unavoidable — we still re-derive permissions from the
principal so a demoted user loses authority before token expiry.

---

## 7. Scoping model: scopes ⊆ permissions

The scope vocabulary **is** the [permission catalog](api-and-cli-guide.md#9-permission-catalog)
— the 30 `admin.*` keys — plus four user-level **account scopes** for the
account surface: `account.read`, `account.profile.write`,
`account.preferences.write`, and `account.apikeys.manage` (see
`src/lib/api-auth/scopes.ts`). This avoids inventing a parallel vocabulary
and means an OpenAPI spec can declare `security` requirements directly in
permission terms. A wildcard `admin.users.*` expands to every matching
catalog key.

Effective permission check at the guard:

```
allowed = requestedPermission ∈ access.permissions
          && requestedPermission ∈ (grantedScopes ?? access.permissions)
```

Consequences:

- A key scoped `["admin.users.read"]` owned by a full platform admin can
  *only* read users — never write, even though the human could.
- If the human is later demoted, the key's authority shrinks with them on
  the next request (permissions are re-derived per request; never cached
  on the key).
- A wildcard scope (`admin.users.*`) MAY be supported as sugar that
  expands at verification time, but the stored grant is always explicit
  keys for auditability.

---

## 8. The RESTful surface (`/api/v1`)

A versioned, resource-oriented surface that **wraps the same handlers**
the administrator routes already implement. Existing
`/api/administrator/*` paths remain (browser/cookie clients); `/api/v1/*`
is the machine-facing, bearer-first surface with standardized semantics.

### 8.1 Conventions

| Concern | Standard |
| --- | --- |
| Versioning | Path prefix `/api/v1`. Breaking changes → `/api/v2`. |
| Resource naming | Plural nouns: `/api/v1/users`, `/api/v1/roles`, `/api/v1/organizations`. |
| Verbs | `GET` list/read, `POST` create, `PATCH` partial update, `PUT` full replace, `DELETE` remove. Actions that aren't CRUD → `POST /…/{id}:action` (e.g. `:approve`, `:ban`). |
| Pagination | Reuse the existing [list-query contract](api-and-cli-guide.md#101-list-query-contract): `?page&pageSize&sort&q&filter[…]`; same `{ items, page, pageSize, total }` envelope. |
| Errors | **`application/problem+json`** (RFC 9457, the successor to 7807). The body as implemented is `{ type, title, status, code, detail?, requestId }` — note there is **no `instance`** member, and `detail` is optional (absent on bare 401/404s). A thin adapter (`src/lib/api-auth/problem.ts`) maps the existing `adminErrorResponse` codes into this shape. |
| Concurrency | `ETag` on GET + `If-Match` on PATCH/PUT/DELETE → `412 Precondition Failed`. (Closes the "no optimistic concurrency" gap noted in admin-manager §13.) |
| Idempotency | `Idempotency-Key` header on POST; replays within a TTL return the original result. |
| Content type | `application/json` only (plus form-encoded on the token endpoint per OAuth2). |
| Discovery | `GET /api/v1/openapi.json` (OpenAPI 3.1) + a Swagger/Redoc page. |

### 8.2 Representative mapping

| REST | Maps to existing handler | Scope |
| --- | --- | --- |
| `GET /api/v1/users` | `GET /api/administrator/users` | `admin.users.read` |
| `POST /api/v1/users` | `POST /api/administrator/users` | `admin.users.create` |
| `POST /api/v1/users/{id}/status` `{action}` | `POST /api/administrator/users/{id}/status` | `admin.users.manage` |
| `GET /api/v1/audit-events` | `GET /api/administrator/audit` | `admin.audit.read` |
| `GET /api/v1/me` | self context (account guard) | `account.read` |

> **As built vs. as designed.** The `:action` / `:bulkApprove` verb sugar
> in §8.1 is design intent. The implemented status transition is
> `POST /api/v1/users/{id}/status` with an `{ action: "approve" | "block"
> | "suspend" | "reactivate" }` body, and there is **no** `/api/v1/users`
> bulk endpoint. `PUT` is likewise listed as a convention but no `/api/v1`
> route implements it (OAuth-client edits use `PATCH`).

Implementation note: the `/api/v1` handlers are **thin adapters**
that translate REST conventions (problem+json, ETag, `:action` verbs)
and then delegate to the shared server modules
([`admin-status.server.ts`](../src/lib/admin-status.server.ts),
`list-query.server.ts`, the `auth-admin.server.ts` wrappers) — not a
second copy of the business logic.

---

## 9. Management endpoints

### 9.1 Self-service (account surface)

Lets any signed-in user manage **their own** machine credentials,
strictly self-scoped like the existing `/api/account/*` routes (no id
from the body; resolved from the session). A user may only mint keys with
scopes they currently hold.

| Path | Verb | Returns / body |
| --- | --- | --- |
| `/api/v1/me/api-keys` | GET | list caller's keys (prefix, name, scopes, last_used; **never** the secret). Requires scope `account.read`. |
| `/api/v1/me/api-keys` | POST | `{ name, scopes[], expiresInDays? }` (positive int, ≤ 3650) → **plaintext once**. Requires scope `account.apikeys.manage`. |
| `/api/v1/me/api-keys/{id}` | DELETE | revoke. Requires `account.apikeys.manage`. |
| `/api/v1/me/api-keys/{id}/rotate` | POST | new plaintext + revoke old. Requires `account.apikeys.manage`. |

> Note the field is **`expiresInDays`** (a positive integer), not
> `expiresAt` — the schema is strict and rejects unknown keys with `400`.
> An **unscoped** key authorizes *nothing*: even `GET /api/v1/me` and
> `GET /api/v1/me/api-keys` require `account.read`. The create/rotate/
> delete operations require `account.apikeys.manage`.

**UI.** The self-service page **Account → API keys**
([`/app/account/api-keys`](../src/app/[locale]/(secure)/app/account/api-keys/page.tsx))
wraps these endpoints: a user lists their keys, creates one (the scope
picker is limited to scopes they may grant — the server re-validates via
`ungrantableScopesForCaller`), rotates, and revokes, with the plaintext
revealed exactly once. The page is user-level (gated on `shell.view`
only) and self-scoped; a cookie session satisfies the
`account.apikeys.manage` requirement.

### 9.2 Administrator surface

Org-wide credential governance, gated by **new permission keys**:

```
admin.apikeys.read     # list any user's / org's keys
admin.apikeys.manage   # revoke, set policy, force-rotate
admin.clients.read     # list oauth clients
admin.clients.manage   # create/rotate/revoke oauth clients
```

| Path | Verb | Permission |
| --- | --- | --- |
| `/api/v1/admin/api-keys` | GET | `admin.apikeys.read` |
| `/api/v1/admin/api-keys/{id}` | DELETE | `admin.apikeys.manage` |
| `/api/v1/admin/oauth-clients` | GET / POST | `admin.clients.read` / `manage` |
| `/api/v1/admin/oauth-clients/{id}` | GET / PATCH / DELETE | `admin.clients.*` |
| `/api/v1/admin/oauth-clients/{id}/rotate-secret` | POST | `admin.clients.manage` |

These keys join the seeded catalog and the `admin.platform` / `superuser`
roles (seeded by
[`0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql)
and re-granted to `admin.platform` by
[`src/db/seeds/seed-local.ts`](../src/db/seeds/seed-local.ts)).

**Two admin surfaces share these permission keys:**

- the **machine** REST endpoints in the table above (`/api/v1/admin/*`,
  bearer or cookie), and
- the cookie-session **Administrator API-keys console** at
  [`/app/administrator/api-keys`](../src/app/[locale]/(secure)/app/administrator/api-keys/page.tsx),
  backed by its own route group:

  | Path | Verb | Permission |
  | --- | --- | --- |
  | `/api/administrator/api-keys` | GET | `admin.apikeys.read` (list joined to owner email; filter `status`/`app_user_id`/`organization_id`; `q`) |
  | `/api/administrator/api-keys` | POST | `admin.apikeys.manage` (issue **on behalf of** a user; scopes capped to the *owner's* authority) |
  | `/api/administrator/api-keys/{id}` | GET / DELETE | `admin.apikeys.read` / `manage` (DELETE = revoke, soft-delete, idempotent) |
  | `/api/administrator/api-keys/{id}/rotate` | POST | `admin.apikeys.manage` (atomic re-issue + revoke) |

  It sits under the **APIs** nav group and is documented in
  [admin-manager.md §8.12](admin-manager.md). **OAuth-client** management
  remains REST-only (no UI yet).

---

## 10. Security design

### 10.1 Storage

- API keys & client secrets: **SHA-256 hash only**, unique-indexed.
  Plaintext shown once. A leaked DB dump exposes no usable credential.
- JWT signing key: **private key never leaves the issuer**; only the
  public JWKS is exposed. Prefer a KMS/secret-manager reference over an
  env literal in production.

### 10.2 Least privilege & propagation of revocation

Permissions are re-derived from the principal **every request** (the
existing per-request `cache()` in `getUserAccessContext` is request-scoped
only). Banning/suspending the owner, or removing a role, immediately
shrinks every key and unexpired token they own — no stale-authority
window beyond a single in-flight request.

### 10.3 CSRF, the origin guard, and bearer auth

The current origin guard
([`origin-guard.server.ts`](../src/lib/admin/origin-guard.server.ts))
exists because **cookies are ambient** — a browser attaches them
automatically, enabling CSRF. **Bearer credentials are not ambient**: an
attacker's page cannot read or attach a victim's `Authorization` header.
Therefore:

> **Design rule:** the origin guard MUST be **skipped when
> `caller.isBearer === true`** and **enforced when the caller
> authenticated by cookie.** This is implemented inside the refactored
> `requireAdminPermission` (it already runs the origin check first — it
> becomes conditional on credential kind). Bearer clients consequently do
> **not** need to spoof an `Origin` header (removing the awkward
> requirement called out in the CLI guide §2.4), while cookie CSRF
> protection is unchanged.

### 10.4 Rate limiting

Extend [`enforceRateLimit`](../src/lib/admin/rate-limit.server.ts) to key
its bucket on `credentialId` (api_key id / jwt jti / client_id) in
addition to the actor, so one noisy key cannot exhaust the principal's
whole budget and per-key quotas become possible. The token endpoint gets
its own stricter bucket (token minting is cheap to abuse). Better Auth's
sign-in limiter is untouched.

### 10.5 Audit

The event types actually emitted are `api_key.created` / `.rotated` /
`.revoked`, `oauth_client.created` / `.updated` / `.revoked` /
`.secret_rotated`, `token.issued`, and `api.access.denied` (for refused
machine calls) — all through the existing `auditEvent`. (There is no
`token.revoked` or `api.auth_failed` event.) Authenticated machine calls
record `credentialId` in metadata so the audit explorer can answer "what
did key X do?". Denied
machine calls are audited exactly like denied cookie calls today.

### 10.6 Transport & hardening

- All token/credential endpoints are HTTPS-only; the token endpoint and
  JWKS set `Cache-Control` appropriately (`no-store` for token, cacheable
  for JWKS).
- Constant-time comparison on any secret equality not covered by the
  unique-index hash lookup.
- Default-deny: an unscoped key (`scopes = []`) can authenticate but
  authorizes **nothing** — not even `GET /api/v1/me`, which requires the
  `account.read` scope.
- Optional **IP allow-list** column per key (future) for high-value
  service keys.

---

## 11. Environment & configuration

New variables, validated in [`src/lib/env.ts`](../src/lib/env.ts)
(following the existing fail-at-boot pattern):

```bash
# JWT access tokens (asymmetric). Provide an Ed25519 private key as a
# JSON-encoded JWK; the public half is served at /api/v1/jwks.json.
API_JWT_ISSUER="https://app.devresponse.com"
API_JWT_AUDIENCE="devresponse-api"
API_JWT_PRIVATE_KEY=""              # Ed25519 private JWK/PEM (or KMS ref)
API_JWT_ACCESS_TTL_SECONDS=900      # 15 min default

# API key issuance
API_KEY_ENV_TAG="live"              # "live" | "test"; stamped into the prefix
API_KEY_DEFAULT_TTL_DAYS=""         # empty = no default expiry (UI warns)

# Feature flags (ship dark, enable per environment)
API_KEYS_ENABLED="false"
API_JWT_ENABLED="false"
```

`env.ts` `superRefine` additions: if `API_JWT_ENABLED` is true,
`API_JWT_PRIVATE_KEY` must be present; if a provider is half-configured,
fail at boot rather than first request — mirroring the existing email
provider checks.

---

## 12. Build vs. buy: Better Auth plugins

Better Auth (pinned `1.6.9`) ships `apiKey()`, `jwt()`, and `bearer()`
plugins. **Recommendation: a hybrid.**

- **Adopt Better Auth `jwt()`** for JWKS + signing (it already implements
  asymmetric keys, `kid` rotation, and the `.well-known/jwks.json`
  endpoint — reinventing this is error-prone). Mount it as a fourth
  plugin in [`src/lib/auth.ts`](../src/lib/auth.ts) alongside `admin()`,
  `ssoSession()`, `nextCookies()`.
- **Build app-managed API keys** (the `app_api_keys` table above) rather
  than the plugin's key store, because we need **scopes expressed in our
  permission catalog** and **ownership tied to `app_users`** so the
  status/membership gates and the existing audit pipeline apply
  unchanged. The plugin's generic key store would create a parallel
  authorization island — exactly what principle #1 forbids.
- **Wrap, don't expose.** As with the two-admin-surface hazard
  ([CLI guide §12.5](api-and-cli-guide.md#125-the-two-admin-surface-hazard)),
  any Better Auth plugin HTTP route that bypasses
  `requireAdminPermission` must **not** be publicly mounted; the `/api/v1`
  adapters are the only supported surface.

Document the exact installed plugin API against the package types before
implementing (the `auth.ts` comment already mandates this for option
names).

---

## 13. Phased delivery plan

Each phase is independently shippable behind its feature flag and must be
green on `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

**Phase 1 — Resolver & schema (no new surface).**
`resolveCaller`, the credential schema (now in `0001-initial-schema.sql`),
refactor `requireAdminPermission` / `requireAccountUser` to use it, conditional
origin guard for bearer. Cookie behavior byte-for-byte unchanged
(regression-gated by the existing security suite).

**Phase 2 — API keys + self-service management.**
Issuance/verify/rotate/revoke, `app_api_keys`, `/api/v1/me/api-keys`,
audit + per-key rate limiting. CLI guide's §11 recipe becomes "create a
key, send `Authorization: Bearer`" — no cookie jar, no `Origin` spoofing.

**Phase 3 — JWT access tokens + JWKS.**
Adopt Better Auth `jwt()`, token endpoint (`api_key` grant), JWKS,
`app_revoked_tokens`, `jti` revocation.

**Phase 4 — OAuth2 client credentials.**
`app_oauth_clients`, service-user provisioning, `client_credentials`
grant, admin management endpoints + permissions.

**Phase 5 — RESTful `/api/v1` adapters + OpenAPI.**
problem+json, ETag/If-Match, `:action` verbs, idempotency keys,
`openapi.json` + docs page. Administrator "Credentials" UI.

**Phase 6 — Hardening & polish.**
Per-key IP allow-list, key-expiry notifications (reuse the email outbox),
rotation runbooks, load test of the JWT hot path vs. the key hot path.

---

## 14. Test plan

| Layer | Coverage |
| --- | --- |
| **Unit** | key generation/format, `sha256` hash+lookup, scope-intersection logic, JWT claim builder, JWKS `kid` selection, problem+json adapter, ETag computation. |
| **Integration** | each grant type issues a usable credential; `/api/v1/users` works with key and with JWT; revoked key/jti rejected; expired credential rejected; demoted owner loses authority mid-token-life. |
| **Security** | hashed-at-rest (no plaintext in DB or logs); bearer bypasses origin guard **but** cookie still enforces it; key cannot exceed owner scopes; unscoped key authorizes nothing; rate-limit per credential; denied machine calls are audited; JWKS exposes only public keys; token endpoint constant-time secret check. |
| **Contract** | generated `openapi.json` validates (3.1) and matches handler behavior; pagination/error envelopes conform. |
| **E2E** | mint key in Account UI → call `/api/v1` from a script → see it in admin Credentials grid → revoke → call now 401; full client-credentials → token → call → revoke flow. |

Coverage gates follow the existing repo policy (`specs.md` §29 /
admin-manager §17).

---

## 15. Open questions / future work

- **Refresh tokens?** Intentionally omitted for v1 — machine clients
  re-mint from their long-lived key/secret, which is simpler and avoids a
  refresh-token store. Revisit only if a client genuinely cannot hold a
  long-lived secret.
- **Per-org credential scoping.** The admin tiers now org-scope
  (ADR-0001): a credential's authority is its scopes ∩ its owner's
  permissions, which already carry the owner's org boundary. A finer-
  grained per-org *credential* policy (beyond inheriting the owner's
  scope) remains a possible follow-up.
- **Webhooks / outbound signing.** Out of scope here, but the JWKS
  infrastructure from Phase 3 is the natural foundation for signing
  outbound webhook payloads later.
- **mTLS / DPoP** for the highest-assurance service clients — a possible
  successor to bearer once the basics ship.
- **Hard-delete / GDPR** interplay with `last_used_ip` retention on
  `app_api_keys`.

---

### References

- Current auth findings & CLI constraints: [`docs/api-and-cli-guide.md`](api-and-cli-guide.md)
- Guard pipeline to refactor: [`src/lib/admin/permissions.server.ts`](../src/lib/admin/permissions.server.ts), [`src/lib/auth-guard.ts`](../src/lib/auth-guard.ts)
- Access resolution to reuse: [`src/lib/auth-status.ts`](../src/lib/auth-status.ts)
- Origin guard to make conditional: [`src/lib/admin/origin-guard.server.ts`](../src/lib/admin/origin-guard.server.ts)
- Audit / errors / rate-limit to extend: [`src/lib/audit.server.ts`](../src/lib/audit.server.ts), [`src/lib/admin/errors.server.ts`](../src/lib/admin/errors.server.ts), [`src/lib/admin/rate-limit.server.ts`](../src/lib/admin/rate-limit.server.ts)
- Auth instance to add the `jwt()` plugin: [`src/lib/auth.ts`](../src/lib/auth.ts)
- Env pattern to follow: [`src/lib/env.ts`](../src/lib/env.ts)
- Schema conventions: [`src/db/migrations/0001-initial-schema.sql`](../src/db/migrations/0001-initial-schema.sql), [`docs/setup-better-auth.md`](setup-better-auth.md) §3
- Admin app to host the Credentials UI: [`docs/admin-manager.md`](admin-manager.md)
