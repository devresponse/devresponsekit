import { getServerEnv } from "@/lib/env";
import { buildAuthorizationServerMetadata, mcpDiscoveryConfig } from "@/lib/mcp/metadata";

export const dynamic = "force-dynamic";

/**
 * GET /.well-known/oauth-authorization-server (RFC 8414) — advertises the
 * authorization server backing the MCP gateway. The app IS the AS, so this
 * points at the existing `/api/v1/auth/token` + `/api/v1/jwks.json`. Public,
 * but DARK unless `MCP_ENABLED`. See docs/design-mcp-agent-gateway.md §9.
 */
export async function GET(): Promise<Response> {
  const env = getServerEnv();
  if (!env.MCP_ENABLED) return new Response("Not Found", { status: 404 });
  // One source for the origin + issuer both discovery documents advertise
  // (review #57); the env schema refuses a divergent API_JWT_ISSUER while
  // MCP_ENABLED, because this document is only served under BETTER_AUTH_URL.
  const { baseUrl, issuer } = mcpDiscoveryConfig(env);
  const body = buildAuthorizationServerMetadata(baseUrl, issuer, {
    registrationEndpoint: env.MCP_REGISTRATION_ENABLED,
  });
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
