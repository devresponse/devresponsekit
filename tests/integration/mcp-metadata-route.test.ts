import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the `/.well-known/*` OAuth discovery routes
 * (Phase 1). Env is mocked so these assert the dark gate + the served
 * metadata; the pure builders are covered in tests/unit/mcp-metadata.test.ts.
 */
const env = vi.hoisted(() => ({
  MCP_ENABLED: true,
  BETTER_AUTH_URL: "https://app.example.com",
  API_JWT_ISSUER: undefined as string | undefined,
}));

vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));

import { GET as protectedResourceGet } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as authServerGet } from "@/app/.well-known/oauth-authorization-server/route";

beforeEach(() => {
  env.MCP_ENABLED = true;
  env.API_JWT_ISSUER = undefined;
});

describe("MCP discovery routes", () => {
  it("404s both metadata documents when MCP is disabled", async () => {
    env.MCP_ENABLED = false;
    expect((await protectedResourceGet()).status).toBe(404);
    expect((await authServerGet()).status).toBe(404);
  });

  it("serves protected-resource metadata when enabled", async () => {
    const res = await protectedResourceGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.resource).toBe("https://app.example.com/api/mcp");
    expect(body.authorization_servers).toEqual(["https://app.example.com"]);
    expect(body.scopes_supported).toContain("admin.users.read");
  });

  it("serves authorization-server metadata pointing at the token endpoint + JWKS", async () => {
    const body = await (await authServerGet()).json();
    expect(body.token_endpoint).toBe("https://app.example.com/api/v1/auth/token");
    expect(body.jwks_uri).toBe("https://app.example.com/api/v1/jwks.json");
    expect(body.grant_types_supported).toContain("client_credentials");
  });

  it("uses API_JWT_ISSUER as the issuer when set", async () => {
    env.API_JWT_ISSUER = "https://issuer.example";
    const body = await (await authServerGet()).json();
    expect(body.issuer).toBe("https://issuer.example");
  });
});
