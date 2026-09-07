/**
 * OpenAPI 3.1 document for the `/api/v1` surface (design §8.1).
 *
 * Pure builder so it can be unit-tested, served from a route
 * (`/api/v1/openapi.json`), and exported to a committed static file
 * (`pnpm openapi:export` → `docs/openapi.json`) for API-client generation.
 *
 * Scopes are sourced from the live {@link API_SCOPE_CATALOG} so the security
 * schemes never drift from the permission model. Response/request schemas
 * mirror the actual handlers: note the API intentionally returns raw
 * snake_case DB rows from list/detail endpoints and small camelCase summaries
 * from create endpoints — both are modelled faithfully so a generated client
 * matches the wire format.
 */
import { ACCOUNT_SCOPES, API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";

type Obj = Record<string, unknown>;

const ref = (name: string): Obj => ({ $ref: `#/components/schemas/${name}` });
const errRef = (name: string): Obj => ({ $ref: `#/components/responses/${name}` });
const paramRef = (name: string): Obj => ({ $ref: `#/components/parameters/${name}` });

const json = (schema: Obj): Obj => ({ content: { "application/json": { schema } } });
const problemContent = (): Obj => ({
  content: { "application/problem+json": { schema: ref("Problem") } },
});

/** A paginated list envelope wrapping `itemRef`. `sort` is present on the
 * full list-query endpoints (users, audit) and absent on the simpler admin
 * credential lists. */
function pageList(itemName: string, opts: { sort: boolean }): Obj {
  const properties: Obj = {
    items: { type: "array", items: ref(itemName) },
    page: { type: "integer", minimum: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 200 },
    total: { type: "integer", minimum: 0 },
  };
  if (opts.sort) properties.sort = { type: "array", items: ref("SortSpec") };
  return { type: "object", properties, required: ["items", "page", "pageSize", "total"] };
}

const dateTime = (nullable = false): Obj =>
  nullable
    ? { type: ["string", "null"], format: "date-time" }
    : { type: "string", format: "date-time" };
const uuid = (): Obj => ({ type: "string", format: "uuid" });
const nullableString = (): Obj => ({ type: ["string", "null"] });
const stringArray = (): Obj => ({ type: "array", items: { type: "string" } });

const USER_STATUS = ["active", "pending_approval", "blocked", "suspended", "deactivated"];
const CREDENTIAL_STATUS = ["active", "revoked"];

export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  const scopeMap = Object.fromEntries(API_SCOPE_CATALOG.map((s) => [s, s]));

  return {
    openapi: "3.1.0",
    info: {
      title: "DevResponse API",
      version: "1.0.0",
      description:
        "Machine-facing REST surface (`/api/v1`). Authenticate with an API key (`drk_…`) or a JWT " +
        "access token as `Authorization: Bearer …`. Scopes are the application permission keys; a " +
        "credential can never exceed its owner's authority. Errors use RFC 7807 " +
        "`application/problem+json`. Every response carries an `x-request-id` correlation header.",
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    tags: [
      { name: "Auth", description: "Obtain access tokens." },
      { name: "Account", description: "The authenticated caller's own identity and API keys." },
      { name: "Users", description: "User administration." },
      { name: "API keys", description: "API-key governance (admin)." },
      { name: "OAuth clients", description: "OAuth2 client-credentials governance (admin)." },
      { name: "Audit", description: "Read the audit log." },
      { name: "Well-known", description: "Public discovery documents." },
    ],
    security: [{ bearerAuth: [] }, { oauth2ClientCredentials: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "An API key (`drk_…`) or a JWT access token.",
        },
        oauth2ClientCredentials: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: `${baseUrl}/api/v1/auth/token`,
              scopes: scopeMap,
            },
          },
        },
      },
      parameters: {
        Page: {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
          description: "1-indexed page number.",
        },
        PageSize: {
          name: "pageSize",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 200, default: 25 },
          description: "Rows per page (clamped to 1–200).",
        },
        Sort: {
          name: "sort",
          in: "query",
          required: false,
          explode: true,
          style: "form",
          schema: { type: "array", items: { type: "string" } },
          description: "Sort directives as `field.asc` / `field.desc`, applied in order.",
        },
        Q: {
          name: "q",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Case-insensitive full-text search.",
        },
      },
      responses: {
        BadRequest: { description: "Invalid request", ...problemContent() },
        Unauthorized: { description: "Missing or invalid credential", ...problemContent() },
        Forbidden: { description: "Insufficient scope or permission", ...problemContent() },
        NotFound: {
          description: "Resource not found (or outside caller's scope)",
          ...problemContent(),
        },
        Conflict: { description: "Conflict", ...problemContent() },
        PreconditionFailed: { description: "Stale `If-Match` ETag", ...problemContent() },
        RateLimited: {
          description: "Too many requests",
          headers: { "Retry-After": { schema: { type: "string" } } },
          ...problemContent(),
        },
      },
      schemas: {
        Problem: {
          type: "object",
          description: "RFC 7807 problem object.",
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            code: { type: "string" },
            detail: { type: "string" },
            requestId: { type: "string" },
          },
          required: ["type", "title", "status", "code"],
        },
        SortSpec: {
          type: "object",
          properties: {
            field: { type: "string" },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["field", "direction"],
        },
        Me: {
          type: "object",
          properties: {
            betterAuthUserId: { type: "string" },
            appUserId: uuid(),
            email: { type: "string", format: "email" },
            status: { type: "string", enum: USER_STATUS },
            organizationId: { type: ["string", "null"], format: "uuid" },
            preferredLocale: { type: "string" },
            authentication: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["session", "api_key", "jwt"] },
                credentialId: nullableString(),
              },
              required: ["kind", "credentialId"],
            },
            permissions: stringArray(),
            grantedScopes: { oneOf: [stringArray(), { type: "null" }] },
            effectiveScopes: stringArray(),
          },
          required: [
            "betterAuthUserId",
            "appUserId",
            "email",
            "status",
            "permissions",
            "effectiveScopes",
          ],
        },
        TokenResponse: {
          type: "object",
          properties: {
            access_token: { type: "string" },
            token_type: { type: "string", const: "Bearer" },
            expires_in: {
              type: "integer",
              description:
                "Token lifetime in seconds: the configured access-token TTL, capped at the API key's own `expires_at` for the `api_key` grant so a token never outlives its key.",
            },
            scope: { type: "string", description: "Space-delimited granted scopes." },
          },
          required: ["access_token", "token_type", "expires_in", "scope"],
        },
        TokenRequest: {
          type: "object",
          properties: {
            grant_type: { type: "string", enum: ["client_credentials", "api_key"] },
            client_id: { type: "string" },
            client_secret: { type: "string" },
            api_key: { type: "string" },
            scope: { type: "string", description: "Optional space-delimited down-scoping." },
            resource: {
              type: "string",
              format: "uri",
              description:
                "Optional RFC 8707 resource indicator selecting the token's audience: `<origin>/api/v1` (the default when omitted) or `<origin>/api/mcp` (required for the MCP gateway). Any other value is rejected with `invalid_target`. The accepted values are advertised as `resources_supported` in the authorization-server metadata.",
            },
          },
          required: ["grant_type"],
        },
        UserListItem: {
          type: "object",
          description: "A user row (snake_case, as stored).",
          properties: {
            id: uuid(),
            better_auth_user_id: { type: "string" },
            primary_email: { type: "string", format: "email" },
            display_name: nullableString(),
            status: { type: "string", enum: USER_STATUS },
            preferred_locale: { type: "string" },
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "primary_email", "status", "created_at", "updated_at"],
        },
        UserDetail: {
          type: "object",
          description: "A single user, including `status_reason`.",
          properties: {
            id: uuid(),
            better_auth_user_id: { type: "string" },
            primary_email: { type: "string", format: "email" },
            display_name: nullableString(),
            status: { type: "string", enum: USER_STATUS },
            status_reason: nullableString(),
            preferred_locale: { type: "string" },
            created_at: dateTime(),
            updated_at: dateTime(),
          },
          required: ["id", "primary_email", "status"],
        },
        UserDetailEnvelope: {
          type: "object",
          properties: { user: ref("UserDetail") },
          required: ["user"],
        },
        CreateUserRequest: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8, maxLength: 128 },
            name: { type: "string", minLength: 1, maxLength: 200 },
            role: { type: "string", enum: ["admin", "user"] },
            initialAppStatus: { type: "string", enum: ["active", "pending_approval"] },
            preferredLocale: { type: "string", minLength: 2, maxLength: 10 },
          },
          required: ["email", "password"],
        },
        UserCreated: {
          type: "object",
          properties: {
            id: uuid(),
            betterAuthUserId: { type: "string" },
            email: { type: "string", format: "email" },
            status: { type: "string", enum: USER_STATUS },
          },
          required: ["id", "betterAuthUserId", "email", "status"],
        },
        UserStatusRequest: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["approve", "block", "suspend", "reactivate"] },
            reason: { type: "string", minLength: 1, maxLength: 500 },
          },
          required: ["action"],
        },
        OkStatus: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, status: { type: "string" } },
          required: ["ok", "status"],
        },
        Revoked: {
          type: "object",
          description: "Idempotent revoke result.",
          properties: {
            ok: { type: "boolean", const: true },
            id: uuid(),
            revoked: {
              type: "boolean",
              description: "true if newly revoked, false if already was.",
            },
          },
          required: ["ok", "id", "revoked"],
        },
        OkId: {
          type: "object",
          properties: { ok: { type: "boolean", const: true }, id: uuid() },
          required: ["ok", "id"],
        },
        ApiKeySummary: {
          type: "object",
          description: "API-key metadata (never includes the secret).",
          properties: {
            id: uuid(),
            app_user_id: uuid(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            name: { type: "string" },
            key_prefix: { type: "string" },
            scopes: stringArray(),
            status: { type: "string", enum: CREDENTIAL_STATUS },
            expires_at: dateTime(true),
            last_used_at: dateTime(true),
            created_at: dateTime(),
            revoked_at: dateTime(true),
          },
          required: ["id", "name", "key_prefix", "scopes", "status"],
        },
        ApiKeyList: {
          type: "object",
          properties: { items: { type: "array", items: ref("ApiKeySummary") } },
          required: ["items"],
        },
        CreateApiKeyRequest: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            scopes: { type: "array", items: { type: "string" }, maxItems: 64 },
            expiresInDays: { type: "integer", minimum: 1, maximum: 3650 },
          },
          required: ["name"],
        },
        ApiKeyCreated: {
          type: "object",
          description:
            "Returned once on create/rotate — `key` is the plaintext secret, shown only here.",
          properties: {
            id: uuid(),
            name: { type: "string" },
            prefix: { type: "string" },
            scopes: stringArray(),
            expiresAt: dateTime(true),
            key: { type: "string", description: "Plaintext secret — persist immediately." },
          },
          required: ["id", "name", "prefix", "scopes", "key"],
        },
        OAuthClientSummary: {
          type: "object",
          properties: {
            id: uuid(),
            client_id: { type: "string" },
            app_user_id: uuid(),
            organization_id: { type: ["string", "null"], format: "uuid" },
            name: { type: "string" },
            scopes: stringArray(),
            status: { type: "string", enum: CREDENTIAL_STATUS },
            created_at: dateTime(),
            revoked_at: dateTime(true),
          },
          required: ["id", "client_id", "name", "scopes", "status"],
        },
        OAuthClientEnvelope: {
          type: "object",
          properties: { client: ref("OAuthClientSummary") },
          required: ["client"],
        },
        CreateOAuthClientRequest: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            scopes: { type: "array", items: { type: "string" }, maxItems: 64 },
            serviceAppUserId: uuid(),
            organizationId: { type: ["string", "null"], format: "uuid" },
          },
          required: ["name", "serviceAppUserId"],
        },
        UpdateOAuthClientRequest: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            scopes: { type: "array", items: { type: "string" }, maxItems: 64 },
          },
        },
        OAuthClientCreated: {
          type: "object",
          description: "Returned once on create — `clientSecret` is shown only here.",
          properties: {
            id: uuid(),
            clientId: { type: "string" },
            name: { type: "string" },
            scopes: stringArray(),
            clientSecret: {
              type: "string",
              description: "Plaintext secret — persist immediately.",
            },
          },
          required: ["id", "clientId", "clientSecret"],
        },
        OAuthClientSecret: {
          type: "object",
          properties: {
            id: uuid(),
            clientId: { type: "string" },
            clientSecret: { type: "string" },
          },
          required: ["id", "clientId", "clientSecret"],
        },
        AuditEvent: {
          type: "object",
          properties: {
            id: uuid(),
            event_type: { type: "string" },
            outcome: { type: "string" },
            actor_better_auth_user_id: nullableString(),
            app_user_id: { type: ["string", "null"], format: "uuid" },
            organization_id: { type: ["string", "null"], format: "uuid" },
            reason: nullableString(),
            request_id: nullableString(),
            created_at: dateTime(),
          },
          required: ["id", "event_type", "outcome", "created_at"],
        },
        Jwks: {
          type: "object",
          description: "JSON Web Key Set; `keys` is empty when JWT issuance is disabled.",
          properties: {
            keys: { type: "array", items: { type: "object", additionalProperties: true } },
          },
          required: ["keys"],
        },
        UserList: pageList("UserListItem", { sort: true }),
        AuditEventList: pageList("AuditEvent", { sort: true }),
        ApiKeyAdminList: pageList("ApiKeySummary", { sort: false }),
        OAuthClientList: pageList("OAuthClientSummary", { sort: false }),
      },
    },
    paths: {
      "/auth/token": {
        post: {
          operationId: "issueToken",
          tags: ["Auth"],
          summary: "Exchange a credential for a JWT access token",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": { schema: ref("TokenRequest") },
              "application/json": { schema: ref("TokenRequest") },
            },
          },
          responses: {
            "200": { description: "Access token issued", ...json(ref("TokenResponse")) },
            "400": {
              description:
                "Invalid request (`unsupported_grant_type`, `invalid_scope`, or `invalid_target` for a `resource` this server does not issue tokens for)",
              ...problemContent(),
            },
            "401": errRef("Unauthorized"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/me": {
        get: {
          operationId: "getMe",
          tags: ["Account"],
          summary: "Current caller identity + effective scopes",
          security: [{ bearerAuth: ["account.read"] }],
          responses: {
            "200": { description: "OK", ...json(ref("Me")) },
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
          },
        },
      },
      "/me/api-keys": {
        get: {
          operationId: "listMyApiKeys",
          tags: ["Account"],
          summary: "List the caller's own API keys",
          security: [{ bearerAuth: ["account.read"] }],
          responses: {
            "200": { description: "OK", ...json(ref("ApiKeyList")) },
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
          },
        },
        post: {
          operationId: "createMyApiKey",
          tags: ["Account"],
          summary: "Create an API key (secret returned once)",
          security: [{ bearerAuth: ["account.apikeys.manage"] }],
          requestBody: { required: true, ...json(ref("CreateApiKeyRequest")) },
          responses: {
            "201": { description: "Created", ...json(ref("ApiKeyCreated")) },
            "400": errRef("BadRequest"),
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/me/api-keys/{id}": {
        delete: {
          operationId: "revokeMyApiKey",
          tags: ["Account"],
          summary: "Revoke one of the caller's API keys",
          parameters: [pathId()],
          security: [{ bearerAuth: ["account.apikeys.manage"] }],
          responses: {
            "200": { description: "Revoked", ...json(ref("Revoked")) },
            "400": errRef("BadRequest"),
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
            "404": errRef("NotFound"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/me/api-keys/{id}/rotate": {
        post: {
          operationId: "rotateMyApiKey",
          tags: ["Account"],
          summary: "Rotate one of the caller's API keys (new secret returned once)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["account.apikeys.manage"] }],
          responses: {
            "201": { description: "Rotated", ...json(ref("ApiKeyCreated")) },
            "400": errRef("BadRequest"),
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
            "404": errRef("NotFound"),
            "409": errRef("Conflict"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/users": {
        get: {
          operationId: "listUsers",
          tags: ["Users"],
          summary: "List users",
          security: [{ bearerAuth: ["admin.users.read"] }],
          parameters: [
            paramRef("Page"),
            paramRef("PageSize"),
            paramRef("Sort"),
            paramRef("Q"),
            filterParam("filter[status]", USER_STATUS),
          ],
          responses: {
            "200": { description: "OK", ...json(ref("UserList")) },
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
          },
        },
        post: {
          operationId: "createUser",
          tags: ["Users"],
          summary: "Create a user",
          security: [{ bearerAuth: ["admin.users.create"] }],
          requestBody: { required: true, ...json(ref("CreateUserRequest")) },
          responses: {
            "201": { description: "Created", ...json(ref("UserCreated")) },
            "400": errRef("BadRequest"),
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
            "409": errRef("Conflict"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/users/{id}": {
        get: {
          operationId: "getUser",
          tags: ["Users"],
          summary: "Read a user (emits a weak ETag for optimistic concurrency)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.users.read"] }],
          responses: {
            "200": {
              description: "OK",
              headers: {
                ETag: { schema: { type: "string" }, description: "Weak ETag from `updated_at`." },
              },
              ...json(ref("UserDetailEnvelope")),
            },
            "400": errRef("BadRequest"),
            "404": errRef("NotFound"),
          },
        },
      },
      "/users/{id}/status": {
        post: {
          operationId: "setUserStatus",
          tags: ["Users"],
          summary: "Apply a status transition (supports `If-Match`)",
          parameters: [
            pathId(),
            {
              name: "If-Match",
              in: "header",
              required: false,
              schema: { type: "string" },
              description: "Weak ETag from GET; a stale value yields 412.",
            },
          ],
          security: [{ bearerAuth: ["admin.users.manage"] }],
          requestBody: { required: true, ...json(ref("UserStatusRequest")) },
          responses: {
            "200": { description: "Applied", ...json(ref("OkStatus")) },
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
            "404": errRef("NotFound"),
            "412": errRef("PreconditionFailed"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/audit-events": {
        get: {
          operationId: "listAuditEvents",
          tags: ["Audit"],
          summary: "Read the audit log",
          security: [{ bearerAuth: ["admin.audit.read"] }],
          parameters: [
            paramRef("Page"),
            paramRef("PageSize"),
            paramRef("Sort"),
            filterParam("filter[event_type]"),
            filterParam("filter[outcome]"),
          ],
          responses: {
            "200": { description: "OK", ...json(ref("AuditEventList")) },
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
          },
        },
      },
      "/admin/api-keys": {
        get: {
          operationId: "listApiKeys",
          tags: ["API keys"],
          summary: "List API keys (admin)",
          security: [{ bearerAuth: ["admin.apikeys.read"] }],
          parameters: [
            paramRef("Page"),
            paramRef("PageSize"),
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: CREDENTIAL_STATUS },
            },
            { name: "appUserId", in: "query", required: false, schema: uuid() },
          ],
          responses: {
            "200": { description: "OK", ...json(ref("ApiKeyAdminList")) },
            // review #47: a non-UUID `appUserId` is now a 400 problem instead
            // of a Postgres 22P02 surfacing as a 500.
            "400": errRef("BadRequest"),
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
          },
        },
      },
      "/admin/api-keys/{id}": {
        delete: {
          operationId: "revokeApiKey",
          tags: ["API keys"],
          summary: "Revoke any API key (admin)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.apikeys.manage"] }],
          responses: {
            "200": { description: "Revoked", ...json(ref("Revoked")) },
            "400": errRef("BadRequest"),
            "404": errRef("NotFound"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/admin/oauth-clients": {
        get: {
          operationId: "listOauthClients",
          tags: ["OAuth clients"],
          summary: "List OAuth clients",
          security: [{ bearerAuth: ["admin.clients.read"] }],
          parameters: [
            paramRef("Page"),
            paramRef("PageSize"),
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: CREDENTIAL_STATUS },
            },
          ],
          responses: {
            "200": { description: "OK", ...json(ref("OAuthClientList")) },
            "401": errRef("Unauthorized"),
            "403": errRef("Forbidden"),
          },
        },
        post: {
          operationId: "createOauthClient",
          tags: ["OAuth clients"],
          summary: "Register an OAuth client (secret returned once)",
          security: [{ bearerAuth: ["admin.clients.manage"] }],
          requestBody: { required: true, ...json(ref("CreateOAuthClientRequest")) },
          responses: {
            "201": { description: "Created", ...json(ref("OAuthClientCreated")) },
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/admin/oauth-clients/{id}": {
        get: {
          operationId: "getOauthClient",
          tags: ["OAuth clients"],
          summary: "Read an OAuth client",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.clients.read"] }],
          responses: {
            "200": { description: "OK", ...json(ref("OAuthClientEnvelope")) },
            "400": errRef("BadRequest"),
            "404": errRef("NotFound"),
          },
        },
        patch: {
          operationId: "updateOauthClient",
          tags: ["OAuth clients"],
          summary: "Edit an OAuth client",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.clients.manage"] }],
          requestBody: { required: true, ...json(ref("UpdateOAuthClientRequest")) },
          responses: {
            "200": { description: "Updated", ...json(ref("OkId")) },
            "400": errRef("BadRequest"),
            "403": errRef("Forbidden"),
            "404": errRef("NotFound"),
            "409": errRef("Conflict"),
            "429": errRef("RateLimited"),
          },
        },
        delete: {
          operationId: "revokeOauthClient",
          tags: ["OAuth clients"],
          summary: "Revoke an OAuth client",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.clients.manage"] }],
          responses: {
            "200": { description: "Revoked", ...json(ref("Revoked")) },
            "400": errRef("BadRequest"),
            "404": errRef("NotFound"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/admin/oauth-clients/{id}/rotate-secret": {
        post: {
          operationId: "rotateOauthClientSecret",
          tags: ["OAuth clients"],
          summary: "Rotate an OAuth client secret (new secret returned once)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.clients.manage"] }],
          responses: {
            "200": { description: "Rotated", ...json(ref("OAuthClientSecret")) },
            "400": errRef("BadRequest"),
            "404": errRef("NotFound"),
            "409": errRef("Conflict"),
            "429": errRef("RateLimited"),
          },
        },
      },
      "/jwks.json": {
        get: {
          operationId: "getJwks",
          tags: ["Well-known"],
          summary: "Public JSON Web Key Set for verifying issued JWTs",
          security: [],
          responses: { "200": { description: "OK", ...json(ref("Jwks")) } },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          tags: ["Well-known"],
          summary: "This OpenAPI 3.1 document",
          security: [],
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
    "x-account-scopes": ACCOUNT_SCOPES,
  };
}

function pathId(): Obj {
  return { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
}

/** A `filter[…]` query parameter; repeatable so a generated client can pass
 * one or many values. */
function filterParam(name: string, enumValues?: string[]): Obj {
  const itemSchema: Obj = enumValues ? { type: "string", enum: enumValues } : { type: "string" };
  return {
    name,
    in: "query",
    required: false,
    explode: true,
    style: "form",
    schema: { type: "array", items: itemSchema },
    description: "Exact-match filter; repeat the parameter for multiple values.",
  };
}
