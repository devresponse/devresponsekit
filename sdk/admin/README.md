# Administrator API SDK (internal)

A **generated** TypeScript client for the `/api/administrator` console API, plus one
hand-written entry point (`client.ts`).

> ⚠️ Generated code — do not edit by hand (except the files listed in
> `.openapi-generator-ignore`: `client.ts`, this README, `tsconfig.json`). Regenerate with
> `pnpm sdk:admin:generate`, which re-exports `docs/openapi-admin.json` from
> `src/lib/api-auth/openapi-admin.ts`, verifies the SHA-256 of the pinned openapi-generator
> JAR (`scripts/verify-openapi-generator-jar.ts`), then runs openapi-generator
> `typescript-fetch` (version pinned in `openapitools.json`; the npm wrapper is an exact-pinned
> devDependency). Zero runtime dependencies — it uses the global `fetch`.

## Authentication

This is the **admin console** API, not the public machine API (`/api/v1`). Every operation that
goes through the server's `resolveCaller` — all of them except `stopImpersonation`, see below —
accepts either credential it understands:

- the **Better Auth session cookie** — `__Secure-better-auth.session_token` on any https
  origin (the bare `better-auth.session_token` only on a plain-http dev origin). The value is
  the **signed cookie value from a real browser session**; a session id or a row from the
  `session` table is rejected. Every **mutation** (`POST`/`PATCH`/`PUT`/`DELETE`) must then also
  carry an `Origin` (or `Referer`) header matching a trusted origin — the CSRF guard. A browser
  sets `Origin` itself (it is a forbidden header, scripts cannot set it); a server-side caller
  must add it.
- a **bearer** API key (`drk_…`) or JWT from `POST /api/v1/auth/token`, scope-bounded
  (effective authority = credential scopes ∩ owner permissions) and exempt from the origin
  guard.

`DELETE /users/{id}/impersonate` (`stopImpersonation`) is the one exception: it deliberately does
not run through the permission guard — stopping must work from the impersonated identity, which
holds no admin permission — so it always enforces the `Origin` check and always requires a session
cookie. A bearer credential gets `403 untrusted_origin` / `401 unauthenticated` there; use the
`cookie` mode below.

`createAdminClient` builds the right `Configuration` for each mode:

```ts
// Import paths are illustrative — adjust them to wherever `sdk/admin` sits
// relative to the importing file (this matches the examples in docs/api.md).
import { createAdminClient } from "../sdk/admin/client";
import { UsersApi, OrganizationsApi, MCPAgentsApi } from "../sdk/admin";

// Browser: the session cookie is sent automatically (credentials: "include").
const browser = createAdminClient({ origin: "https://app.example.com" });

// Server-side with a session: forwards the cookie + adds the Origin header.
const server = createAdminClient({
  origin: "https://app.example.com",
  // The signed value from a real sign-in (`<token>.<44-char base64 signature>`, which
  // always ends in an "=" pad), or a full "__Secure-better-auth.session_token=…; …" header.
  cookie: signedSessionCookieValue,
});

// Bearer (API key or JWT): Authorization header, no Origin needed.
const machine = createAdminClient({ origin: "https://app.example.com", bearerToken: apiKey });

const users = new UsersApi(browser);

// List (typed query + response)
const page = await users.listUsers({ page: 1, pageSize: 25, filterStatus: ["active"] });

// Create
const created = await users.createUser({
  createUserRequest: { email: "new.user@example.com", password: "<temp>", name: "New User" },
});

// Other resources
const orgs = await new OrganizationsApi(server).listOrganizations({ q: "acme" });
const pending = await new MCPAgentsApi(machine).listMcpAgents({ filterStatus: "pending" });
```

The generated `Configuration` knobs `apiKey`, `username` and `password` are **not used** by
any admin operation (the generator ignores the spec's cookie scheme); `accessToken` is what
`bearerToken` maps onto. The generated `BASE_PATH` is the deployment default —
`createAdminClient` always sets `basePath` explicitly from `origin`.

## Errors

Failed requests reject with a `ResponseError`; the body is the admin error envelope
`{ error, message, requestId }` (`AdminError`). A `429` body is `RateLimitedError`
(`retryAfter` seconds, mirrored in the `Retry-After` header); a `422` from a scope grant is
`UnprocessableError` (`ungrantableScopes`). Every response also carries an `x-request-id`
header for correlation with the server audit log.

## What's covered

The whole `/api/administrator` surface — users (including the `SessionItem` projection of a
user's sessions, revoked by `id`), roles, permissions, groups, organizations, memberships,
enterprise apps, API keys, email, MCP agents, audit, CSV export — one `…Api` class per
resource group, with typed models under `models/`. `tests/unit/api-route-spec-parity.test.ts`
fails CI for any admin route file that is not in the spec.

`GET /api/administrator/metrics` is the **only** route intentionally excluded — it backs the
console home dashboard only (role-scoped, UI-shaped), so there is no `MetricsApi`. See
[`docs/api.md`](../../docs/api.md).

One generator caveat: a schema that allows two JSON types (`BulkUserRequest.ids` is a uuid
list **or** the string `"*"`; `filters.status` a list **or** one string) is typed by the
generator as its first type — cast when sending the alternative form.

## Type-checking

The committed client compiles under `sdk/admin/tsconfig.json`
(`pnpm sdk:admin:typecheck`). It is excluded from the repository's own `tsc`/ESLint/Prettier
runs because it is generated. `client.ts` is covered by `client.test.ts` (kept here rather than
under `tests/` so the generated `runtime.ts` never enters the root `tsc` program; vitest picks it
up via `sdk/admin/*.test.ts`, and `pnpm sdk:admin:typecheck` type-checks it).
