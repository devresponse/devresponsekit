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
    expect(mcpWwwAuthenticate(BASE)).not.toContain("error=");
  });

  it("appends an RFC 6750 error challenge when given, with double quotes neutralised", () => {
    const value = mcpWwwAuthenticate(BASE, {
      error: "invalid_token",
      description: 'wrong "audience"; request resource=https://app.example.com/api/mcp',
    });
    expect(value).toContain("resource_metadata=");
    expect(value).toContain('error="invalid_token"');
    expect(value).toContain(
      `error_description="wrong 'audience'; request resource=https://app.example.com/api/mcp"`,
    );
  });

  it("advertises the RFC 8707 resources the token endpoint accepts (review #50/#53)", () => {
    const as = buildAuthorizationServerMetadata(BASE, BASE);
    expect(as.resources_supported).toEqual([
      "https://app.example.com/api/v1",
      "https://app.example.com/api/mcp",
    ]);
    // The protected resource's identifier IS the second entry, so a client
    // can pass the advertised `resource` straight to the token endpoint.
    expect(as.resources_supported).toContain(buildProtectedResourceMetadata(BASE, BASE).resource);
    expect(buildProtectedResourceMetadata(BASE, BASE).resource).toBe(mcpResourceIdentifier(BASE));
  });

  it("includes the registration endpoint only when self-registration is enabled", () => {
    expect(buildAuthorizationServerMetadata(BASE, BASE).registration_endpoint).toBeUndefined();
    expect(
      buildAuthorizationServerMetadata(BASE, BASE, { registrationEndpoint: true })
        .registration_endpoint,
    ).toBe("https://app.example.com/api/mcp/register");
  });
});
