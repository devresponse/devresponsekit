import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api-auth/openapi";
import { API_SCOPE_CATALOG } from "@/lib/api-auth/scopes";

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
  });
});
