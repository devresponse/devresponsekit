import { getServerEnv } from "@/lib/env";
import { buildProtectedResourceMetadata, mcpDiscoveryConfig } from "@/lib/mcp/metadata";

export const dynamic = "force-dynamic";

/**
 * GET /.well-known/oauth-protected-resource (RFC 9728) — tells an MCP
 * client which authorization server protects `/api/mcp` and what scopes it
 * understands. Public, but DARK unless `MCP_ENABLED` (nothing is advertised
 * while the gateway is off). See docs/design-mcp-agent-gateway.md §9.
 */
export async function GET(): Promise<Response> {
  const env = getServerEnv();
  if (!env.MCP_ENABLED) return new Response("Not Found", { status: 404 });
  // Same single source as the AS metadata, so `authorization_servers` can
  // never name an origin that serves no AS metadata (review #57).
  const { baseUrl, issuer } = mcpDiscoveryConfig(env);
  const body = buildProtectedResourceMetadata(baseUrl, issuer);
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
