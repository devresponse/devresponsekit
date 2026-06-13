/**
 * OpenAPI 3.1 document for the `/api/v1` surface (design §8.1). Pure
 * builder so it can be unit-tested and served from a route. Scopes are
 * sourced from the live {@link API_SCOPE_CATALOG} so the security schemes
 * never drift from the permission model.
 */
import { ACCOUNT_SCOPES, API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";

export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  const scopeMap = Object.fromEntries(API_SCOPE_CATALOG.map((s) => [s, s]));

  const problem = {
    type: "object",
    properties: {
      type: { type: "string", format: "uri" },
      title: { type: "string" },
      status: { type: "integer" },
      code: { type: "string" },
      detail: { type: "string" },
      requestId: { type: "string" },
    },
    required: ["type", "title", "status", "code"],
  };

  const errorResponses = {
    Unauthorized: { description: "Missing or invalid credential", content: problemContent() },
    Forbidden: { description: "Insufficient scope or permission", content: problemContent() },
    NotFound: { description: "Resource not found", content: problemContent() },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "DevResponse API",
      version: "1.0.0",
      description:
        "Machine-facing REST surface. Authenticate with an API key or a JWT access token as `Authorization: Bearer …`. Scopes are the application permission keys; a credential can never exceed its owner's authority.",
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
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
      schemas: { Problem: problem },
    },
    paths: {
      "/auth/token": {
        post: {
          summary: "Exchange a credential for a JWT access token",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: {
                    grant_type: { type: "string", enum: ["client_credentials", "api_key"] },
                    client_id: { type: "string" },
                    client_secret: { type: "string" },
                    api_key: { type: "string" },
                    scope: { type: "string" },
                  },
                  required: ["grant_type"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Access token issued" },
            "400": { description: "Unsupported grant or invalid scope", content: problemContent() },
            "401": { description: "Invalid client", content: problemContent() },
          },
        },
      },
      "/me": {
        get: { summary: "Current caller identity + effective scopes", responses: ok() },
      },
      "/me/api-keys": {
        get: {
          summary: "List the caller's API keys",
          security: [{ bearerAuth: ["account.read"] }],
          responses: ok(),
        },
        post: {
          summary: "Create an API key (secret returned once)",
          security: [{ bearerAuth: ["account.apikeys.manage"] }],
          responses: { "201": { description: "Created" }, ...errorResponses },
        },
      },
      "/me/api-keys/{id}": {
        delete: {
          summary: "Revoke one of the caller's API keys",
          parameters: [pathId()],
          responses: ok(),
        },
      },
      "/me/api-keys/{id}/rotate": {
        post: {
          summary: "Rotate one of the caller's API keys",
          parameters: [pathId()],
          responses: { "201": { description: "Rotated" }, ...errorResponses },
        },
      },
      "/users": {
        get: {
          summary: "List users",
          security: [{ bearerAuth: ["admin.users.read"] }],
          responses: ok(),
        },
        post: {
          summary: "Create a user",
          security: [{ bearerAuth: ["admin.users.create"] }],
          responses: { "201": { description: "Created" }, ...errorResponses },
        },
      },
      "/users/{id}": {
        get: {
          summary: "Read a user (emits ETag)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.users.read"] }],
          responses: ok(),
        },
      },
      "/users/{id}/status": {
        post: {
          summary: "Apply a status transition (supports If-Match)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.users.manage"] }],
          responses: { "200": { description: "Applied" }, "412": { description: "Stale" } },
        },
      },
      "/audit-events": {
        get: {
          summary: "Read the audit log",
          security: [{ bearerAuth: ["admin.audit.read"] }],
          responses: ok(),
        },
      },
      "/admin/api-keys": {
        get: {
          summary: "List API keys (admin)",
          security: [{ bearerAuth: ["admin.apikeys.read"] }],
          responses: ok(),
        },
      },
      "/admin/api-keys/{id}": {
        delete: {
          summary: "Revoke any API key (admin)",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.apikeys.manage"] }],
          responses: ok(),
        },
      },
      "/admin/oauth-clients": {
        get: {
          summary: "List OAuth clients",
          security: [{ bearerAuth: ["admin.clients.read"] }],
          responses: ok(),
        },
        post: {
          summary: "Register an OAuth client (secret returned once)",
          security: [{ bearerAuth: ["admin.clients.manage"] }],
          responses: { "201": { description: "Created" }, ...errorResponses },
        },
      },
      "/admin/oauth-clients/{id}": {
        get: { summary: "Read an OAuth client", parameters: [pathId()], responses: ok() },
        patch: { summary: "Edit an OAuth client", parameters: [pathId()], responses: ok() },
        delete: { summary: "Revoke an OAuth client", parameters: [pathId()], responses: ok() },
      },
      "/admin/oauth-clients/{id}/rotate-secret": {
        post: {
          summary: "Rotate an OAuth client secret",
          parameters: [pathId()],
          security: [{ bearerAuth: ["admin.clients.manage"] }],
          responses: ok(),
        },
      },
    },
    "x-account-scopes": ACCOUNT_SCOPES,
  };
}

function problemContent() {
  return { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } };
}

function ok() {
  return { "200": { description: "OK" } };
}

function pathId() {
  return { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
}
