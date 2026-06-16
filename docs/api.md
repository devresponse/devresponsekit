# API Reference

_Audience: developers consuming or extending the HTTP API. The current route handlers under `src/app/api/**` are authoritative._

---

## 1. Surface overview

| Group | Base path | Auth | Audience |
| --- | --- | --- | --- |
| Better Auth | `/api/auth/[...all]` | Better Auth (cookies) | Browser auth flows & OAuth callbacks |
| Account self-service | `/api/account/*`, `/api/preferences/*` | Cookie session | The signed-in user |
| Navigation | `/api/navigation/*` | Cookie session | The web UI |
| SSO handoff | `/api/sso/launch`, `/api/sso/consume` | Cookie session / signed token | Cross-subdomain SSO |
| Docs assets | `/api/docs/asset/[...path]` | Cookie session + `shell.view` | In-app docs viewer |
| Administrator | `/api/administrator/*` | **Cookie session** + `admin.*` permission | The admin console |
| Machine API (v1) | `/api/v1/*` | **Bearer** (API key or JWT) or cookie | Integrations & the user's own self-service |
| Discovery | `/api/v1/openapi.json`, `/api/v1/jwks.json` | Public | Tooling |

All handlers are `dynamic = "force-dynamic"` (no caching of authorized data). Every mutating route runs a permission check, an origin/CSRF guard, a per-actor rate-limit, Zod validation, and an audit write.

> **Authoritative machine spec:** the `/api/v1` surface is described by an OpenAPI 3.1 document — served live at **`GET /api/v1/openapi.json`** and committed as **[`docs/openapi.json`](./openapi.json)** for offline use. Both are produced by the same builder (`src/lib/api-auth/openapi.ts`), and a test keeps them in sync. Treat the spec as the source of truth for the `/api/v1` surface; this page is the human-readable companion.

### Generating a client

Point any OpenAPI generator at the committed `docs/openapi.json` (no running server needed). Regenerate the file after changing the API with `pnpm openapi:export`. Each operation has a stable `operationId` (e.g. `listUsers`, `createUser`, `issueToken`) so generated method names are predictable.

```bash
# TypeScript types only
npx openapi-typescript docs/openapi.json -o src/generated/api.d.ts

# A full typed client (example: openapi-generator)
npx @openapitools/openapi-generator-cli generate \
  -i docs/openapi.json -g typescript-fetch -o ./clients/ts

# Or against a running server
npx openapi-typescript http://localhost:3000/api/v1/openapi.json -o api.d.ts
```

> Authenticate generated-client requests with `Authorization: Bearer <api-key-or-jwt>`; see [§2 Authentication](#2-authentication).

### Internal admin SDK

The cookie-session **`/api/administrator`** console API has its own committed OpenAPI document, [`docs/openapi-admin.json`](./openapi-admin.json) (built from `src/lib/api-auth/openapi-admin.ts`), and a **pre-generated, zero-dependency TypeScript client** committed under [`sdk/admin/`](../sdk/admin/) (openapi-generator `typescript-fetch`). Regenerate both with:

```bash
pnpm sdk:admin:generate    # re-export the admin spec + regenerate sdk/admin
pnpm sdk:admin:typecheck   # type-check the generated client
```

Unlike the bearer-token v1 client, the admin SDK authenticates with the **session cookie** and must send an `Origin` header on every mutation (the CSRF guard) — see [`sdk/admin/README.md`](../sdk/admin/README.md) for usage.

## 2. Authentication

### Cookie session (browser & admin console)
Better Auth sets a session cookie on sign-in. The admin console and account endpoints require it. Cross-site mutations are additionally protected by an **origin guard** (the request's `Origin`/`Referer` must be a trusted origin).

### Bearer credentials (machine API)
`/api/v1/**` accepts either credential in an `Authorization: Bearer …` header:

| Type | Looks like | Enabled by | At rest |
| --- | --- | --- | --- |
| **API key** | `drk_live_xxx…` / `drk_test_xxx…` | `API_KEYS_ENABLED=1` | SHA-256 hash only |
| **JWT access token** | `eyJ…` (EdDSA) | `API_JWT_ENABLED=1` + signing key | Stateless; verified via JWKS |

Get a JWT by exchanging long-lived credentials at the token endpoint:

```bash
curl -X POST https://app.example.com/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"api_key","api_key":"drk_live_xxxxxxxx","scope":"admin.users.read"}'
```

```json
{ "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900, "scope": "admin.users.read" }
```

Then call the API:

```bash
curl https://app.example.com/api/v1/users \
  -H "Authorization: Bearer eyJ…"
```

**Authority rule:** a credential's effective access is the **intersection of its scopes and its owner's permissions**. A credential can never be minted with more authority than its creator holds (`src/lib/api-auth/scopes.ts`). Both credential paths are **disabled by default**.

## 3. Tenant scoping (applies to admin & v1 admin routes)

- **Super Admin** (holds `superuser`): all organizations.
- **Org Admin** (holds `admin.*`, no `superuser`): their single organization only.
- An out-of-scope resource returns **404**, never 403, so existence is not leaked.

See [Architecture → Authorization](./architecture.md#authorization-the-three-tier-model).

## 4. Error model

### Administrator routes
JSON envelope with a stable machine code, an i18n message key, and the correlation id:

```json
{ "error": "forbidden", "message": "administrator.errors.forbidden", "requestId": "5f3c…" }
```

Common statuses: `400` invalid body, `401` unauthenticated, `403` forbidden, `404` not found / out of scope, `409` conflict (e.g. duplicate key), `429` rate-limited (with `Retry-After`).

### Machine API (`/api/v1`)
RFC 7807 `application/problem+json`:

```json
{ "type": "about:blank", "title": "Forbidden", "status": 403, "detail": "…", "requestId": "5f3c…" }
```

Every response (success or error) carries an `x-request-id` header that matches the audit log.

## 5. Permission catalog

The catalog has **35** `admin.*` keys plus the `superuser` marker and the user-level `shell.view` / `audit.view` markers (`src/lib/admin/permissions.ts`).

| Domain | Keys |
| --- | --- |
| **Users** | `admin.users.read`, `.create`, `.update`, `.delete`, `.manage`, `.ban`, `.sessions`, `.impersonate`, `.setRole`, `.setPassword` |
| **Roles** | `admin.roles.read`, `.create`, `.update`, `.delete`, `.assign` |
| **Groups** | `admin.groups.read`, `.create`, `.update`, `.delete`, `.assign` |
| **Organizations** | `admin.orgs.read`, `.create`, `.update`, `.delete`, `.manage` |
| **Permissions** | `admin.permissions.manage` |
| **Enterprise apps** | `admin.apps.read`, `.manage` |
| **API keys** | `admin.apikeys.read`, `.manage` |
| **OAuth clients** | `admin.clients.read`, `.manage` |
| **Audit** | `admin.audit.read` |
| **Email** | `admin.email.read`, `.manage` |

Machine API scopes use these same keys (plus `account.*` self-service scopes). A scope ending in `.*` (e.g. `admin.users.*`) matches every key under that prefix.

## 6. Administrator endpoints (selected)

All require a cookie session and the noted permission; mutations are rate-limited and audited. List endpoints share a uniform envelope: `{ items, page, pageSize, total }` with `page`, `pageSize`, `sort`, `q`, and `filter[…]` query parameters.

| Resource | Methods & paths | Permissions |
| --- | --- | --- |
| Users | `GET/POST /api/administrator/users`; `GET/PATCH/DELETE …/[id]`; `…/[id]/status`, `/password`, `/role`, `/sessions`, `/ban`, `/unban`, `/restore`, `/impersonate`, `/memberships`, `/app-roles`, `/groups`; `POST …/users/bulk` | `admin.users.*` (per action) |
| Roles | `GET/POST /api/administrator/roles`; `GET/PATCH/DELETE …/[id]`; `…/[id]/permissions`, `/members`, `/duplicate` | `admin.roles.*` |
| Permissions | `GET/POST /api/administrator/permissions`; `…/[id]` | `admin.roles.read`, `admin.permissions.manage` |
| Groups | `GET/POST /api/administrator/groups`; `GET/PATCH/DELETE …/[id]`; `…/[id]/roles`, `/members` | `admin.groups.*`, `admin.roles.assign` |
| Organizations | `GET/POST /api/administrator/organizations`; `GET/PATCH/DELETE …/[id]`; `…/[id]/members`, `/provider-bindings` | `admin.orgs.*` |
| API keys | `GET/POST /api/administrator/api-keys`; `GET/PATCH/DELETE …/[id]`; `…/[id]/rotate` | `admin.apikeys.*` |
| Email | `GET /api/administrator/email/outbox`; `…/templates`, `…/templates/[id]`; `POST …/email/test` | `admin.email.*` |
| Audit | `GET /api/administrator/audit` | `admin.audit.read` |
| Export | `GET /api/administrator/export/[resource]` | export permission |

### Example — create a user

```bash
curl -X POST https://app.example.com/api/administrator/users \
  -H "Content-Type: application/json" --cookie "<session>" \
  -d '{"email":"new.user@example.com","password":"<temp>","name":"New User"}'
```

```json
{ "ok": true, "id": "…", "better_auth_user_id": "…", "primary_email": "new.user@example.com", "status": "pending_approval" }
```

### Example — list with pagination & filter

```bash
curl "https://app.example.com/api/administrator/users?page=1&pageSize=25&q=acme&filter[status]=active" \
  --cookie "<session>"
```

```json
{ "items": [ { "id": "…", "primary_email": "…", "status": "active" } ], "page": 1, "pageSize": 25, "total": 42 }
```

## 7. Machine API (`/api/v1`)

| Endpoint | Methods | Auth (scope) | Purpose |
| --- | --- | --- | --- |
| `/api/v1/auth/token` | POST | API key or OAuth client credentials | Exchange long-lived credentials for a short-lived JWT |
| `/api/v1/me` | GET | `account.read` | Caller identity, permissions, effective scopes |
| `/api/v1/me/api-keys` | GET/POST | `account.read` / `account.apikeys.manage` | List / mint the caller's own keys (plaintext once) |
| `/api/v1/me/api-keys/[id]` | GET/PATCH/DELETE; `…/rotate` | `account.apikeys.manage` | Manage the caller's own keys |
| `/api/v1/users` | GET/POST | `admin.users.read` / `.create` | User administration |
| `/api/v1/users/[id]` | GET/PATCH/DELETE; `…/status` | `admin.users.*` | User administration |
| `/api/v1/admin/api-keys` | GET; `…/[id]` GET/DELETE | `admin.apikeys.*` | API-key governance |
| `/api/v1/admin/oauth-clients` | GET/POST; `…/[id]` GET/PATCH/DELETE; `…/rotate-secret` | `admin.clients.*` | OAuth client (client-credentials) management |
| `/api/v1/audit-events` | GET | `admin.audit.read` | Read the audit log |
| `/api/v1/jwks.json` | GET | public | Public keys for verifying issued JWTs |
| `/api/v1/openapi.json` | GET | public | OpenAPI 3.1 spec |

### Example — who am I

```bash
curl https://app.example.com/api/v1/me -H "Authorization: Bearer eyJ…"
```

```json
{
  "betterAuthUserId": "…", "appUserId": "…", "email": "svc@example.com",
  "status": "active", "organizationId": "…",
  "permissions": ["admin.users.read"], "grantedScopes": ["admin.users.read"], "effectiveScopes": ["admin.users.read"]
}
```

## 8. SSO handoff endpoints

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/sso/launch` | GET | Cookie session | Verify access to a registered app, mint a one-time handoff token, redirect to the destination |
| `/api/sso/consume` | GET | Signed token | Verify and burn the token, establish the destination session, strip the token from the URL |

Query parameters for `launch`: `applicationId` (required), `locale` (optional). The token is HS256, single-use, valid ≤60s, with an audience bound to the destination application. See [Architecture → SSO](./architecture.md#single-sign-on-handoff) and [Configuration](./configuration.md#single-sign-on-handoff).

## 9. Secret-handling notes

- API-key and OAuth-client secrets are returned **once** at creation/rotation and stored only as hashes. There is no endpoint to retrieve them again.
- Never log or echo a plaintext credential; the audit log records metadata only.

## 10. Gaps / TODO

- `TODO:` Some routes were summarized from structure rather than line-by-line (e.g. `/api/preferences/active-org`, `/api/navigation/shell-menu`, `/api/administrator/organizations/[id]/provider-bindings`, `/api/administrator/export/[resource]`). Confirm exact request/response shapes against the handlers or the generated `openapi.json`.
- `TODO:` Document the exact `account.*` scope list and the supported `export` resources/formats. (The `account.*` scopes are enumerated in `x-account-scopes` of [`docs/openapi.json`](./openapi.json).)
- Committed OpenAPI 3.1 specs ship for both surfaces — [`docs/openapi.json`](./openapi.json) (`/api/v1`) and [`docs/openapi-admin.json`](./openapi-admin.json) (`/api/administrator`) — for client generation (see [Generating a client](#generating-a-client) and [Internal admin SDK](#internal-admin-sdk)). `TODO:` optionally host a rendered Swagger/Redoc page for browsing.
- The cookie-session admin SDK is committed under [`sdk/admin/`](../sdk/admin/); the v1 client is generated on demand from `docs/openapi.json`.

---

_Next: [Configuration](./configuration.md) for the environment variables these endpoints depend on._
