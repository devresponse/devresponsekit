# Administrator API SDK (internal)

A **generated** TypeScript client for the cookie-session `/api/administrator` console API.

> ⚠️ Generated code — do not edit by hand. Regenerate with `pnpm sdk:admin:generate`
> (which re-exports `docs/openapi-admin.json` from `src/lib/api-auth/openapi-admin.ts`,
> then runs openapi-generator `typescript-fetch`). Generated with
> [openapi-generator](https://openapi-generator.tech) `typescript-fetch` (pinned in
> `openapitools.json`). Zero runtime dependencies — it uses the global `fetch`.

## Authentication

This is the **admin console** API, not the public machine API (`/api/v1`). It authenticates
with the **Better Auth session cookie**, and every **mutation** (`POST`/`PATCH`/`PUT`/`DELETE`)
additionally requires an `Origin` (or `Referer`) header matching a trusted origin — the CSRF
guard. A non-browser caller must supply both.

```ts
// Import path is illustrative — adjust it to wherever `sdk/admin` sits
// relative to the importing file (this matches the examples in
// docs/api.md).
import { Configuration, UsersApi, OrganizationsApi } from "../sdk/admin";

const config = new Configuration({
  basePath: "https://app.example.com/api/administrator",
  // Send the session cookie. In the browser this is automatic with
  // credentials: "include"; on the server, forward the Cookie header instead.
  credentials: "include",
  headers: {
    // Required by the CSRF origin guard on every mutation.
    Origin: "https://app.example.com",
    // On the server, also: Cookie: "better-auth.session_token=…"
  },
});

const users = new UsersApi(config);

// List (typed query + response)
const page = await users.listUsers({ page: 1, pageSize: 25, filterStatus: ["active"] });

// Create
const created = await users.createUser({
  createUserRequest: { email: "new.user@example.com", password: "<temp>", name: "New User" },
});

// Another resource
const orgs = await new OrganizationsApi(config).listOrganizations({ q: "acme" });
```

## Errors

Failed requests reject with a `ResponseError`; the body is the admin error envelope
`{ error, message, requestId }` (`AdminError`). Every response also carries an
`x-request-id` header for correlation with the server audit log.

## What's covered

The `/api/administrator` surface (users, roles, permissions, groups, organizations,
memberships, enterprise apps, API keys, email, audit, CSV export) — one `…Api` class per
resource group, with typed models under `models/`.

`GET /api/administrator/metrics` is the one route **intentionally excluded** — it backs the
console home dashboard only (role-scoped, UI-shaped), so there is no `MetricsApi`. See
[`docs/api.md`](../../docs/api.md).

## Type-checking

The committed client compiles under `sdk/admin/tsconfig.json`
(`pnpm sdk:admin:typecheck`). It is excluded from the repository's own `tsc`/ESLint/Prettier
runs because it is generated.
