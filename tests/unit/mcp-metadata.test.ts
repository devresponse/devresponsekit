import { describe, expect, it } from "vitest";
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  mcpResourceIdentifier,
  mcpWwwAuthenticate,
  protectedResourceMetadataUrl,
} from "@/lib/mcp/metadata";

const BASE = "https://app.example.com";

/** Pure coverage for the OAuth discovery-metadata builders (Phase 1). */
describe("MCP discovery metadata", () => {
  it("derives the resource identifier and metadata URL, trimming trailing slashes", () => {
    expect(mcpResourceIdentifier("https://app.example.com/")).toBe(
      "https://app.example.com/api/mcp",
    );
    expect(protectedResourceMetadataUrl(BASE)).toBe(
      "https://app.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("builds RFC 9728 protected-resource metadata", () => {
    const m = buildProtectedResourceMetadata(BASE, BASE);
    expect(m.resource).toBe("https://app.example.com/api/mcp");
    expect(m.authorization_servers).toEqual([BASE]);
    expect(m.bearer_methods_supported).toEqual(["header"]);
    expect(m.scopes_supported).toContain("account.read");
    expect(m.scopes_supported).toContain("admin.users.read");
  });

  it("builds RFC 8414 authorization-server metadata pointing at the existing endpoints", () => {
    const m = buildAuthorizationServerMetadata(BASE, "https://issuer.example");
    expect(m.issuer).toBe("https://issuer.example");
    expect(m.token_endpoint).toBe("https://app.example.com/api/v1/auth/token");
    expect(m.jwks_uri).toBe("https://app.example.com/api/v1/jwks.json");
    expect(m.grant_types_supported).toEqual(["client_credentials"]);
    expect(m.token_endpoint_auth_methods_supported).toContain("client_secret_post");
  });

  it("builds a WWW-Authenticate header that points at the resource metadata", () => {
    expect(mcpWwwAuthenticate(BASE)).toContain(
      'resource_metadata="https://app.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("includes the registration endpoint only when self-registration is enabled", () => {
    expect(buildAuthorizationServerMetadata(BASE, BASE).registration_endpoint).toBeUndefined();
    expect(
      buildAuthorizationServerMetadata(BASE, BASE, { registrationEndpoint: true })
        .registration_endpoint,
    ).toBe("https://app.example.com/api/mcp/register");
  });
});
