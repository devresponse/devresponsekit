import { describe, expect, it, vi } from "vitest";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";
import { ACTIVATION_PERMISSION, ENROLMENT_PERMISSIONS } from "@/lib/admin/user-create.server";

// user-create.server imports the database module; nothing here queries it.
vi.mock("@/db/database", () => ({ db: {} }));

describe("openapi document", () => {
  const doc = buildOpenApiDocument("https://app.devresponse.com") as Record<string, unknown>;

  it("is a 3.1 document with the api server", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(JSON.stringify(doc.servers)).toContain("https://app.devresponse.com/api/v1");
  });

  it("declares bearer + oauth2 security schemes with the full scope catalog", () => {
    const components = doc.components as { securitySchemes: Record<string, unknown> };
    const schemes = components.securitySchemes;
    expect(schemes.bearerAuth).toBeTruthy();
    const oauth = schemes.oauth2ClientCredentials as {
      flows: { clientCredentials: { scopes: Record<string, string> } };
    };
    const scopes = oauth.flows.clientCredentials.scopes;
    for (const key of API_SCOPE_CATALOG) {
      expect(scopes[key]).toBe(key);
    }
  });

  it("documents the token, key-management, and user paths", () => {
    const paths = doc.paths as Record<string, unknown>;
    expect(paths["/auth/token"]).toBeTruthy();
    expect(paths["/me/api-keys"]).toBeTruthy();
    expect(paths["/users/{id}/status"]).toBeTruthy();
    expect(paths["/admin/oauth-clients"]).toBeTruthy();
    expect(paths["/jwks.json"]).toBeTruthy();
  });

  it("gives every operation an operationId and typed responses (for client generation)", () => {
    const paths = doc.paths as Record<
      string,
      Record<string, { operationId?: string; responses?: Record<string, unknown> }>
    >;
    const operationIds = new Set<string>();
    for (const ops of Object.values(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
        expect(op.operationId, `${method} missing operationId`).toBeTruthy();
        operationIds.add(op.operationId!);
      }
    }
    // Unique ids → unique generated client methods.
    expect(operationIds.size).toBeGreaterThanOrEqual(20);
    expect(operationIds.has("listUsers")).toBe(true);
    expect(operationIds.has("createUser")).toBe(true);
  });

  it("defines reusable component schemas the responses reference", () => {
    const schemas = (doc.components as { schemas: Record<string, unknown> }).schemas;
    for (const name of [
      "Problem",
      "UserList",
      "UserDetailEnvelope",
      "ApiKeyCreated",
      "TokenResponse",
      "Me",
    ]) {
      expect(schemas[name], `missing schema ${name}`).toBeTruthy();
    }
    // The list endpoint responds with a $ref to the UserList schema.
    const paths = doc.paths as Record<
      string,
      { get: { responses: { "200": { content: Record<string, { schema: { $ref?: string } }> } } } }
    >;
    const listUsers = paths["/users"]!;
    expect(listUsers.get.responses["200"].content["application/json"]!.schema.$ref).toBe(
      "#/components/schemas/UserList",
    );
  });

  // F-480: every bearer credential is confined to one org, so `createUser`
  // enrols the new user there and the route refuses it without a membership
  // permission (`refuseConfinedCreation`). The published contract must say so:
  // clients and the MCP tool list read the scopes from here. Pinned to the
  // constants the route enforces, so the two cannot drift.
  it("createUser's security demands a membership scope, as the route enforces", () => {
    const paths = doc.paths as Record<
      string,
      Record<string, { security?: unknown; description?: string }>
    >;
    const createUser = paths["/users"]!.post!;
    expect(createUser.security).toEqual(
      ENROLMENT_PERMISSIONS.map((permission) => ({
        bearerAuth: ["admin.users.create", permission],
      })),
    );
    // The status-dependent half cannot be a security requirement.
    expect(createUser.description).toContain(`\`${ACTIVATION_PERMISSION}\``);
    expect(createUser.description).toContain('`initialAppStatus: "active"`');
  });
});
