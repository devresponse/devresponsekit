---
title: "API Reference & Clients"
description: The human-readable companion to the committed OpenAPI specs and generated clients.
group: General
order: 70
---

# API Reference & Clients

_Audience: developers consuming, extending, or integrating with the HTTP API — from a browser, a script, another service, or any language. This page is the human-readable companion to the committed OpenAPI specs; the route handlers under `src/app/api/**` and `src/lib/api-auth/**` are authoritative. Where this prose and the code disagree, the code wins — fix the doc._

Two related references carry the deeper detail this page links to rather than repeats:

- **[Design: API Keys & Access Tokens](./design-api-keys-and-tokens.md)** — the canonical threat model, issuance, rotation, and revocation design for the machine-credential subsystem (`src/lib/api-auth/**`).
- **[Administrator Console — Specification](./admin-manager.md)** — the canonical `/api/administrator` surface, including the **permission catalog** ([§6.1](./admin-manager.md#61-permission-catalog)). The catalog is **not** reproduced here.

---

## 1. Surface overview

| Group | Base path | Auth | Audience |
| --- | --- | --- | --- |
| Better Auth | `/api/auth/[...all]` | Better Auth (cookies) | Browser auth flows & OAuth callbacks |
| Account self-service | `/api/account/*`, `/api/preferences/*` | Cookie session (`/api/account/*` also accepts a bearer credential carrying the matching `account.*` scope) | The signed-in user |
| Invitations | `/api/invitations/accept` | Cookie session | Signed-in invitees accepting an organization invitation |
| Navigation | `/api/navigation/*` | Cookie session | The web UI |
| SSO handoff | `/api/sso/launch`, `/api/sso/consume` | Cookie session / signed token | Cross-subdomain SSO |
| Docs assets | `/api/docs/asset/[...path]` | Cookie session + `shell.view` | In-app docs viewer |
| Administrator | `/api/administrator/*` | **Cookie session** (+ `Origin` on mutations) **or Bearer** (API key / JWT, scope-bound) + `admin.*` permission | The admin console |
| Machine API (v1) | `/api/v1/*` | **Bearer** (API key or JWT) or cookie | Integrations & the user's own self-service |
| MCP agent gateway | `/api/mcp`, `/api/mcp/register` | **Bearer** (API key or JWT); registration public | AI agents (Model Context Protocol) — dark by default |
| Discovery | `/api/v1/openapi.json`, `/api/v1/jwks.json`, `/.well-known/oauth-*` | Public | Tooling · MCP / OAuth clients |

All handlers are `dynamic = "force-dynamic"` (no caching of authorized data). Every mutating route runs a permission check, an origin/CSRF guard, a per-actor rate-limit, Zod validation, and an audit write.

This page focuses on the two surfaces an external caller integrates with — the **machine API (`/api/v1`)** and the **admin console API (`/api/administrator`)** — plus the cross-cutting auth, envelope, and error model they share.

> **Authoritative machine spec:** both surfaces are described by OpenAPI 3.1 documents — the v1 spec is served live at **`GET /api/v1/openapi.json`** and both are committed for offline client generation: **[`docs/openapi.json`](./openapi.json)** (`/api/v1`) and **[`docs/openapi-admin.json`](./openapi-admin.json)** (`/api/administrator`). They are produced by the builders in `src/lib/api-auth/` (`openapi.ts`, `openapi-admin.ts`) — the same builders that power the live route and the committed SDK — and **drift-checked in CI** (`tests/unit/openapi-export.test.ts`), so a generated client never describes a different API than the running one. Treat the specs as the source of truth for exact request/response shapes; this page summarizes.

```mermaid
flowchart TB
    subgraph You["Your integration"]
        V["v1 client (generated)"]
        A["admin SDK (sdk/admin)"]
    end
    V -- "Authorization: Bearer drk_… / JWT" --> V1["/api/v1/*"]
    A -- "Cookie (+ Origin on mutations) or Bearer" --> ADM["/api/administrator/*"]
    V1 & ADM --> APP["DevResponse app"]
```

### List envelope & conventions

List endpoints across both surfaces share one envelope and one set of query parameters:

- **Envelope** — `{ items, page, pageSize, total }`, plus `sort` on the full list-query endpoints (users, audit). `pageSize` is clamped to 1–200.
- **Query** — `page` (1-indexed), `pageSize`, `sort` (repeatable `field.asc` / `field.desc`, applied in order), `q` (case-insensitive search), and repeatable `filter[…]` exact-match filters.
- **Tenant scoping** — an out-of-scope resource returns **404**, never 403, so existence is never leaked (see [Tenant scoping](#3-tenant-scoping)).
- **Wire format** — list/detail endpoints return raw **snake_case** DB rows; create endpoints return small **camelCase** summaries. Both are modeled in the spec, so a generated client matches the wire format exactly.

## 2. Authentication

There are two auth models. **Cookie session** is what the browser uses everywhere; **bearer credentials** are the machine path. Both `/api/v1` and `/api/administrator` accept either (one `resolveCaller` behind both guards); the account and navigation endpoints are cookie-only except where noted in §1.

### Cookie session (browser & admin console)

Better Auth sets a session cookie on sign-in: **`__Secure-better-auth.session_token`** on any https origin (Better Auth's `useSecureCookies` prefix — production always), and the bare `better-auth.session_token` only on a plain-http dev origin such as `http://localhost:3000`. Its value is the **signed cookie value** exactly as the browser holds it — a session `id` or a row from the `session` table is rejected — so a server-side caller obtains it from a real sign-in, never by minting one.

Cross-site mutations (`POST`/`PATCH`/`PUT`/`DELETE`) are additionally protected by an **origin guard**: the request's `Origin` (or `Referer`) must be a trusted origin. The guard covers every cookie-session mutation — `/api/administrator/*`, `/api/account/*`, `/api/preferences/*` (active-org and locale switches), and `/api/invitations/accept` — so a non-browser caller must send **both** the session cookie and a matching `Origin` header; a miss is `403 untrusted_origin`. (A browser sets `Origin` itself; it is a forbidden header name, so setting it from script is a no-op.)

### Bearer credentials (machine API — and the admin API)

`/api/v1/**` and `/api/administrator/**` accept either credential in an `Authorization: Bearer …` header. **Both paths are disabled by default** and enabled per environment (`API_KEYS_ENABLED`, `API_JWT_ENABLED` — see [Configuration](./configuration.md#machine-api-credentials-both-paths-dark-by-default)). A bearer caller is exempt from the origin guard (a cross-site page cannot attach one) and is bounded by its scopes — see the authority rule below; on the admin surface that means the credential needs a scope covering the operation's `admin.*` permission (e.g. `admin.users.read` or `admin.users.*`), else `403 forbidden`.

| Type | Looks like | Enabled by | At rest |
| --- | --- | --- | --- |
| **API key** | `drk_<env>_<rand>` (`drk_live_…` / `drk_test_…`) | `API_KEYS_ENABLED=1` | SHA-256 hash only |
| **JWT access token** | `eyJ…` (EdDSA) | `API_JWT_ENABLED=1` + signing key | Stateless; verified via JWKS |

An API key is `drk_<env>_<random>` (32 base62 chars, ~190 bits of entropy); only its SHA-256 hash is stored, and the plaintext is shown once. A JWT is a short-lived EdDSA token verified by signature against `GET /api/v1/jwks.json` — no server-side secret. Get one by exchanging a long-lived credential (an API key, or OAuth2 client-credentials) at the token endpoint:

```bash
curl -X POST https://app.example.com/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"api_key","api_key":"drk_live_xxxxxxxx","scope":"admin.users.read"}'
# → { "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 900, "scope": "admin.users.read" }
```

Then call the API:

```bash
curl https://app.example.com/api/v1/users -H "Authorization: Bearer eyJ…"
```

Two details of the token endpoint worth knowing:

- **`resource` (RFC 8707) selects the audience.** Omit it (or pass `resource=<origin>/api/v1`) for a v1 token — `aud` is `API_JWT_AUDIENCE`. Pass `resource=<origin>/api/mcp` for a token that drives the [MCP gateway](#11-mcp-agent-gateway-model-context-protocol); such a token is refused at `/api/v1` (`401 invalid_token`), and a v1 token is refused at `/api/mcp`. Any other value is `400 invalid_target`. The accepted values are listed as `resources_supported` in `/.well-known/oauth-authorization-server`.
- **`expires_in` is capped by the key.** For the `api_key` grant the lifetime is the smaller of `API_JWT_ACCESS_TTL_SECONDS` and the seconds left until the key's `expires_at`, so a token never outlives its key; a key with under a second left is refused (`401 invalid_client`).
- **Revoking or rotating the credential kills its tokens.** Every JWT names the key/client it came from (`cid`), and each request re-checks that row: after a revoke or rotation the next call with an outstanding token returns `401 credential_revoked` — do not retry it, mint a fresh one from the new credential.

**Authority rule (the one invariant to remember):** a credential's effective access is the **intersection of its scopes and its owner's live permissions** (`src/lib/api-auth/scopes.ts`, enforced by `requireApiPermission` in `v1-guard.server.ts`). A credential can never be minted with more authority than its creator holds, and `GET /api/v1/me` reports the resulting `effectiveScopes`.

Scopes **are** the permission vocabulary — every `admin.*` catalog key (see [`admin-manager.md` §6.1](./admin-manager.md#61-permission-catalog)) plus a small set of self-service `account.*` scopes (`account.read`, `account.profile.write`, `account.preferences.write`, `account.apikeys.manage`). A scope ending in `.*` (e.g. `admin.users.*`) matches every key under that prefix.

The self-service write scopes gate the account mutations for bearer callers: `PATCH /api/account/profile` requires `account.profile.write`, `PUT /api/account/preferences` requires `account.preferences.write`, and the `/api/v1/me/api-keys*` mutations require `account.apikeys.manage`. A read-only (`account.read`) or zero-scope credential gets `403 insufficient_scope` on every one of them; a cookie session carries the user's full authority and is unaffected.

> For the full threat model, secret storage, issuance, rotation, and revocation, see **[Design: API Keys & Access Tokens](./design-api-keys-and-tokens.md)**.

## 3. Tenant scoping

Applies to the admin console and the `admin.*` v1 routes:

- **Super Admin** (holds `superuser`): all organizations.
- **Org Admin** (holds `admin.*`, no `superuser`): their single organization only.
- An out-of-scope resource returns **404**, never 403, so existence is not leaked.

See [Architecture → Authorization](./architecture.md#authorization-the-three-tier-model).

## 4. Error model

### Machine API (`/api/v1`)

RFC 7807 `application/problem+json`:

```json
{ "type": "https://devresponse.com/problems/forbidden", "title": "Insufficient scope or permission", "status": 403, "code": "forbidden", "detail": "…", "requestId": "5f3c…" }
```

### Administrator routes

A JSON envelope with a stable machine code, an i18n message key, and the correlation id (`AdminError`):

```json
{ "error": "forbidden", "message": "errors.forbidden", "requestId": "5f3c…" }
```

Common statuses on both surfaces: `400` invalid body, `401` unauthenticated, `403` forbidden, `404` not found / out of scope, `409` conflict, `412` stale `If-Match` ETag (v1), `429` rate-limited (with `Retry-After`). Every response (success or error) carries an `x-request-id` header that matches the audit log.

## 5. Machine API (`/api/v1`)

| Endpoint | Methods | Auth (scope) | Purpose |
| --- | --- | --- | --- |
| `/api/v1/auth/token` | POST | API key or OAuth client credentials | Exchange long-lived credentials for a short-lived JWT |
| `/api/v1/me` | GET | `account.read` | Caller identity, permissions, effective scopes |
| `/api/v1/me/api-keys` | GET / POST | `account.read` / `account.apikeys.manage` | List / mint the caller's own keys (plaintext once) |
| `/api/v1/me/api-keys/[id]` | DELETE; `…/rotate` POST | `account.apikeys.manage` | Revoke / rotate one of the caller's own keys |
| `/api/v1/users` | GET / POST | `admin.users.read` / `.create` | User administration |
| `/api/v1/users/[id]` | GET; `…/status` POST | `admin.users.read` / `.manage` | Read a user (emits a weak ETag); apply a status transition — a non-superadmin principal gets **403** `forbidden` (audited `admin.user.action_denied`) for a target who outranks them, exactly as the console does ([Admin Manager §8.1](./admin-manager.md#81-users)) |
| `/api/v1/admin/api-keys` | GET; `…/[id]` DELETE | `admin.apikeys.read` / `.manage` | API-key governance (list / revoke any key) |
| `/api/v1/admin/oauth-clients` | GET / POST; `…/[id]` GET/PATCH/DELETE; `…/rotate-secret` POST | `admin.clients.read` / `.manage` | OAuth client (client-credentials) management |
| `/api/v1/audit-events` | GET | `admin.audit.read` | Read the audit log |
| `/api/v1/jwks.json` | GET | public | Public keys for verifying issued JWTs |
| `/api/v1/openapi.json` | GET | public | OpenAPI 3.1 spec |

The token endpoint accepts `grant_type` of `api_key` or `client_credentials`, with an optional `scope` to **down-scope** the token to a subset of the credential's scopes. Mutations are mutating-rate-limited per credential (the bucket keys on the credential id, so one noisy key can't exhaust the principal's whole budget).

### Example — who am I

```bash
curl https://app.example.com/api/v1/me -H "Authorization: Bearer eyJ…"
```

```json
{
  "betterAuthUserId": "…", "appUserId": "…", "email": "svc@example.com",
  "status": "active", "organizationId": "…", "preferredLocale": "en",
  "authentication": { "kind": "api_key", "credentialId": "…" },
  "permissions": ["admin.users.read"], "grantedScopes": ["admin.users.read"], "effectiveScopes": ["admin.users.read"]
}
```

### Generating & using a v1 client

The v1 surface is designed for generated SDKs — use it for **anything outside the browser** (integrations, cron jobs, other services, or letting a user manage their own resources). Every operation has a stable `operationId` (`listUsers`, `createUser`, `issueToken`, …) so generated method names are predictable.

```bash
# 1. Get the spec — committed, so no running server is needed:
#    docs/openapi.json   (…or fetch the live one)
curl https://app.example.com/api/v1/openapi.json -o openapi.json

# 2. Generate a client for your stack:
npx openapi-typescript docs/openapi.json -o api.d.ts                 # TS types only
npx @openapitools/openapi-generator-cli generate \                  # full typed client
  -i docs/openapi.json -g typescript-fetch -o ./clients/v1
npx @openapitools/openapi-generator-cli generate \                  # any other language
  -i docs/openapi.json -g python -o ./clients/python
```

```ts
// 3. Call it — authenticate with a bearer token (API key or JWT).
import { Configuration, UsersApi } from "./clients/v1";

const api = new UsersApi(
  new Configuration({
    basePath: "https://app.example.com/api/v1",
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  }),
);

const page = await api.listUsers({ page: 1, pageSize: 25, q: "acme" });
console.log(page.items, page.total);
```

## 6. Administrator API (`/api/administrator`) & the committed admin SDK

This is the console surface (users, roles, permissions, groups, organizations, memberships, sign-up policy, invitations, enterprise apps, API keys, email, MCP agents, audit, CSV export). It is **internal tooling that mirrors the admin console — not a public/integration API**; prefer the v1 surface for integrations. Every endpoint accepts a cookie session (+ `Origin` on mutations) or a scope-bound bearer credential — the one exception is `DELETE /users/[id]/impersonate`, which bypasses the permission guard by design and is therefore **cookie-session only** — and requires the noted permission; mutations are rate-limited (`429` with `Retry-After` / `retryAfter`) and audited.

The table below is **generated from the spec** by `pnpm docs:admin-table` (one row per tag; `tests/unit/docs-admin-api-table.test.ts` fails when it is stale) — edit `openapi-admin.ts`, not the table:

<!-- admin-api-table:start (generated by pnpm docs:admin-table) -->
| Resource | Methods & paths | Permissions |
| --- | --- | --- |
| Users | `GET/POST /users`; `GET/PATCH/DELETE /users/[id]`; `POST /users/[id]/status`; `POST /users/[id]/password`; `POST /users/[id]/role`; `POST /users/[id]/ban`; `POST /users/[id]/unban`; `POST /users/[id]/restore`; `POST/DELETE /users/[id]/impersonate`; `GET/DELETE /users/[id]/sessions`; `DELETE /users/[id]/sessions/[sessionId]`; `GET/POST/PATCH/DELETE /users/[id]/memberships`; `GET/POST/DELETE /users/[id]/app-roles`; `GET /users/[id]/roles`; `GET /users/[id]/audit`; `GET/POST/DELETE /users/[id]/groups`; `POST /users/bulk` | `admin.users.*` (per action) |
| Roles | `GET/POST /roles`; `GET/PATCH/DELETE /roles/[id]`; `POST /roles/[id]/duplicate`; `GET/POST/DELETE /roles/[id]/permissions`; `GET /roles/[id]/members` | `admin.roles.*` |
| Permissions | `GET/POST /permissions`; `PATCH/DELETE /permissions/[id]` | `admin.roles.read`, `admin.permissions.manage` |
| Groups | `GET/POST /groups`; `GET/PATCH/DELETE /groups/[id]`; `GET/POST/DELETE /groups/[id]/members`; `GET/POST/DELETE /groups/[id]/roles` | `admin.groups.*` (`.assign` for members and roles) |
| Organizations | `GET/POST /organizations`; `GET/PATCH/DELETE /organizations/[id]`; `GET/POST/PATCH/DELETE /organizations/[id]/members`; `GET/POST/DELETE /organizations/[id]/provider-bindings`; `GET/POST /organizations/[id]/invitations`; `DELETE /organizations/[id]/invitations/[invitationId]`; `POST /organizations/[id]/invitations/[invitationId]/resend`; `GET/PATCH/DELETE /organizations/[id]/auth-settings`; `GET/PATCH /auth-settings/defaults` | `admin.orgs.*` (`/auth-settings/defaults`: + **superadmin**) |
| Memberships | `GET /memberships` | `admin.orgs.read` |
| Enterprise apps | `GET/POST /enterprise-apps`; `GET/PATCH/DELETE /enterprise-apps/[id]` | `admin.apps.*` |
| API keys | `GET/POST /api-keys`; `GET/DELETE /api-keys/[id]`; `POST /api-keys/[id]/rotate` | `admin.apikeys.*` |
| Email | `GET /email/outbox`; `GET /email/outbox/[id]`; `GET /email/templates`; `GET/PUT /email/templates/[id]`; `POST /email/test` | `admin.email.*` |
| MCP agents | `GET /mcp-agents`; `PATCH/DELETE /mcp-agents/[id]`; `POST /mcp-agents/[id]/approve` | `admin.clients.read` / `admin.clients.manage` |
| Audit | `GET /audit` | `admin.audit.read` |
| Export | `GET /export/[resource]` | the exported resource's read permission |
<!-- admin-api-table:end -->

> The exact permission per action and request/response shapes live in [`docs/openapi-admin.json`](./openapi-admin.json) and [`admin-manager.md`](./admin-manager.md). `GET /api/administrator/metrics` exists but is **intentionally excluded** from the spec/SDK — it backs the console home dashboard only; it is the **only** exclusion (`tests/unit/api-route-spec-parity.test.ts` fails for any other admin route missing from the spec). A user's sessions are returned as a `SessionItem` projection (never the session token) and revoked by `id`.

### The committed admin SDK

Unlike the v1 client, the admin SDK is **already generated and committed** at [`sdk/admin/`](../sdk/admin/) (openapi-generator `typescript-fetch`, zero runtime dependencies — it uses the global `fetch`). Import it directly, and build the `Configuration` with the hand-written [`createAdminClient`](../sdk/admin/client.ts) — it sets `basePath` from your origin and the right credential shape for each mode (the generated `apiKey`/`username`/`password` knobs are unused by this API):

```ts
import { createAdminClient } from "../sdk/admin/client";
import { UsersApi, OrganizationsApi, MCPAgentsApi } from "../sdk/admin";

// Browser: the session cookie rides along (credentials: "include"); the
// browser sets Origin on mutations itself — it cannot be set from script.
const browser = createAdminClient({ origin: "https://app.example.com" });

// Server-side with a session: forwards the Cookie header and adds Origin.
// `cookie` is the SIGNED value of the __Secure-better-auth.session_token
// cookie from a real sign-in — `<token>.<44-char base64 signature>`, whose
// trailing "=" pad is why the SDK matches a leading "name=" rather than just
// looking for an "=" — or the full "name=value; …" header.
const server = createAdminClient({ origin: "https://app.example.com", cookie: signedCookieValue });

// Bearer: an API key or JWT — scope-bound, exempt from the Origin guard.
const machine = createAdminClient({ origin: "https://app.example.com", bearerToken: apiKey });

const users = new UsersApi(browser);
const page = await users.listUsers({ page: 1, pageSize: 25, filterStatus: ["active"] });
const created = await users.createUser({
  createUserRequest: { email: "new.user@example.com", password: "<temp>", name: "New User" },
});
const orgs = await new OrganizationsApi(server).listOrganizations({ q: "acme" });
const agents = await new MCPAgentsApi(machine).listMcpAgents({ filterStatus: "pending" });
```

Failed requests reject with a `ResponseError` carrying the `AdminError` envelope (`message` is an i18n key; a `429` body is `RateLimitedError`, a `422` scope grant is `UnprocessableError`). Regenerate after editing the admin API — a drift-guard test fails otherwise:

```bash
pnpm sdk:admin:typecheck   # type-check the committed client (sdk/admin/tsconfig.json)
pnpm sdk:admin:generate    # re-export docs/openapi-admin.json, verify the generator JAR, regenerate sdk/admin
pnpm docs:admin-table      # refresh the resource table above from the spec
```

> **Regenerating needs Java + network.** openapi-generator runs on a JVM: the JAR version is pinned in `openapitools.json`, its SHA-256 is verified by `scripts/verify-openapi-generator-jar.ts` before it runs (the cache lives in the gitignored `.cache/openapi-generator/`), and the npm wrapper is an exact-pinned devDependency run via `pnpm exec`. The **committed** client itself has no dependencies. See [`sdk/admin/README.md`](../sdk/admin/README.md).

### Which surface should I use?

| If you're… | Use |
| --- | --- |
| Integrating from another service / script / language | **v1 machine API** (bearer auth, generate from `docs/openapi.json`) |
| Letting a user manage *their own* resources programmatically | **v1 machine API** (`account.*` scopes, `/api/v1/me/*`) |
| Building internal tooling that mirrors the admin console | **Admin SDK** (`sdk/admin/`, cookie + Origin, or a scope-bound bearer) |
| Unsure | **v1** — it's the supported integration surface; the admin SDK is an internal convenience |

The two surfaces overlap (both can manage users, both take a bearer) but differ in **the browser path** (only the admin surface is cookie + Origin), **error format** (RFC 7807 vs `{ error, message, requestId }`) and **stability** (v1 is the supported contract).

## 7. SSO handoff endpoints

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/sso/launch` | GET | Cookie session (not impersonated) | Verify access to a registered app, mint a one-time handoff token, redirect to the destination |
| `/api/sso/consume` | GET | Signed token | Verify the token and redirect to the confirmation interstitial (no nonce burn, no session) |
| `/api/sso/consume` | POST | Signed token + trusted origin | Burn the token, establish the destination session, redirect to the dashboard |
| `/api/sso/jwks.json` | GET | Public | The issuer's public handoff keys (Ed25519 JWKS, `Cache-Control: public, max-age=300`). Always mounted; `{ "keys": [] }` when this deployment issues no handoffs |

Query parameters for `launch`: `applicationId` (required; must match the app-id shape `^[a-z0-9][a-z0-9._-]{0,127}$` — anything else is a `400 invalid_application_id` with no database work), `locale` (optional). The token is an **EdDSA (Ed25519)** JWT signed by the issuer's `SSO_HANDOFF_PRIVATE_KEY` and verified by the consumer against the issuer's `/api/sso/jwks.json` — single-use, valid ≤60s (enforced on both sides), with an audience bound to the destination application. Its claims are minimal — `sub`, `email`, `locale`, `targetApplicationId`, `jti` plus `iss`/`aud`/`iat`/`exp`; **no roles, organization or app-user ids** — because the token rides in a query string. A deployment without a signing key answers `503 sso_not_configured` on `launch`. See [Architecture → SSO](./architecture.md#single-sign-on-handoff) and [Configuration](./configuration.md#single-sign-on-handoff).

Contract details that matter to a caller:

- **Impersonated sessions cannot launch.** A session with `impersonatedBy` set gets `403 forbidden_while_impersonating` (audited against the impersonating admin). The satellite session a handoff would mint carries no impersonation marker, outlives the impersonation cap, and is attributed to the target — so it is never minted.
- **Application-id binding on consume.** Besides the `aud` check, both consume methods require the token's `targetApplicationId` claim to equal the consumer's own `SSO_HANDOFF_APPLICATION_ID`, and the nonce burn is predicated on that id too. A token minted for another registered app is rejected (`401 invalid_token`, audit reason `target_application_mismatch`) even if the two apps' audiences collide. The catalog refuses a duplicate `sso_audience` at registration (`409 audience_taken`).
- **Rate limits.** `launch` is throttled per principal (session user id, or trusted client IP while signed out); `consume` GET and POST are throttled per trusted client IP. Both use the standard 30-burst / 1 per second budget and answer `429 rate_limited` with a `Retry-After` header before any audit row is written.

## 8. Secret-handling notes

- API-key and OAuth-client secrets are returned **once** at creation/rotation and stored only as hashes. There is no endpoint to retrieve them again.
- Never log or echo a plaintext credential; the audit log records metadata only.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `401` from `/api/v1/*` | Missing/invalid bearer; or the path is disabled (`API_KEYS_ENABLED` / `API_JWT_ENABLED` are off by default). |
| `403` with an unexpected scope error | The credential's scope doesn't cover the endpoint, **or** exceeds the owner's permissions (it's capped to the creator). |
| `401`/`403` from `/api/administrator/*` | `401 unauthenticated`: no session cookie and no bearer (or a revoked/expired one). `403 untrusted_origin`: a cookie-session mutation without a trusted `Origin` header — add it (CSRF guard). `403 forbidden`: missing permission, or a bearer whose scopes don't cover it. |
| `404` for a resource you know exists | Tenant scoping — an org admin can't see other orgs; out-of-scope is 404 by design. |
| `412` from a v1 mutation | Stale `If-Match` ETag — re-`GET` the resource and retry with the fresh ETag. |
| `429` | Rate-limited; respect the `Retry-After` header. |
| Generated client types don't match responses | Regenerate from the current spec; list/detail endpoints return snake_case rows, create endpoints camelCase summaries (both modeled). |
| `pnpm sdk:admin:generate` fails | It needs **Java** and network access (openapi-generator). The committed client doesn't. |

## 10. Source of truth & keeping clients in sync

- The committed **OpenAPI 3.1 specs are authoritative** for exact request/response shapes — [`docs/openapi.json`](./openapi.json) (`/api/v1`) and [`docs/openapi-admin.json`](./openapi-admin.json) (`/api/administrator`). They are regenerated from the handlers and **drift-checked in CI**; the fix when a check fails is `pnpm openapi:export` (both specs) and, for the admin surface, `pnpm sdk:admin:generate`, then commit.
- The `account.*` scopes are also enumerated in `x-account-scopes` of [`docs/openapi.json`](./openapi.json); the supported `export` resources/formats are described by the `/api/administrator/export/[resource]` operation in [`docs/openapi-admin.json`](./openapi-admin.json).
- **Regenerate your downstream client** whenever the relevant spec changes — watch `docs/openapi.json` / `docs/openapi-admin.json`, or the `version` in the spec's `info`.

## 11. MCP agent gateway (Model Context Protocol)

_Dark by default (`MCP_ENABLED`), like the machine API it fronts. Flags: [Configuration → AI agent gateway (MCP)](./configuration.md#ai-agent-gateway-mcp). Full design: [Design: MCP Agent Gateway](./design-mcp-agent-gateway.md)._

`/api/mcp` exposes the v1 machine API to AI agents over the **Model Context Protocol** — a stateless **Streamable HTTP** JSON-RPC 2.0 endpoint. It is a translation layer, not a second API: every tool call funnels through the same `permission ∩ scope` guard as `/api/v1`, so the MCP surface can never exceed the machine API's authority.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/mcp` | POST | **Bearer** (API key, or a JWT minted with `resource=<origin>/api/mcp`) | JSON-RPC: `initialize`, `tools/list`, `tools/call`, `ping` |
| `/api/mcp` | GET | — | `405` — no server-initiated stream |
| `/api/mcp/register` | POST | Public (rate-limited) | RFC 7591 agent self-registration; gated by `MCP_REGISTRATION_ENABLED` |
| `/.well-known/oauth-protected-resource` | GET | Public | RFC 9728 protected-resource metadata |
| `/.well-known/oauth-authorization-server` | GET | Public | RFC 8414 authorization-server metadata |

- **Bearer-only.** A cookie session is rejected (it is not an audience-bound OAuth token). An unauthenticated call returns `401` with `WWW-Authenticate: Bearer …, resource_metadata="…/.well-known/oauth-protected-resource"`, so a compliant client auto-discovers the token endpoint (`/api/v1/auth/token`) and JWKS.
- **Audience-bound (RFC 8707).** A JWT must have been requested with `resource=<origin>/api/mcp` — the identifier advertised as `resource` in the protected-resource metadata. A token minted for `/api/v1` gets `401` with `error="invalid_token"` and an `error_description` naming the resource to request, unless the operator has `MCP_AUDIENCE_GRACE=1` on for a migration window. API keys are not audience-bound.
- **Tools are generated from the OpenAPI spec.** Each scoped `/api/v1` operation becomes one MCP tool (~18 today), carrying its required scope; a new scoped endpoint becomes a tool for free. `issueToken`, `getJwks`, and `getOpenApi` are excluded.
- **Self-registration is safe by construction.** A newly registered agent gets a machine service account + a **zero-scope** OAuth client. In `approval` mode (default) it cannot mint a token until an admin activates it; in `open` mode it is active but every tool `403`s until scopes are granted. Admins approve, scope, and revoke agents from **Administrator → Agents** ([Admin Manager §8.13](./admin-manager.md#813-mcp-agents)), and a scheduled reaper expires registrations left pending longer than `MCP_REGISTRATION_PENDING_TTL_DAYS`. A request may only name an `organization` the operator opened (the default org or `MCP_REGISTRATION_ALLOWED_ORGS`); the per-org quota counts self-registered agents only and is enforced atomically.

The MCP surface is **not** modeled in the OpenAPI specs (it is JSON-RPC, not REST) — the [design doc](./design-mcp-agent-gateway.md) is authoritative.

---

_See also: [Design: API Keys & Access Tokens](./design-api-keys-and-tokens.md) · [Administrator Console — Specification](./admin-manager.md) · [Configuration](./configuration.md) for the environment variables these endpoints depend on._
