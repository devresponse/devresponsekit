import { getServerEnv } from "@/lib/env";
import { buildProtectedResourceMetadata } from "@/lib/mcp/metadata";

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
  const body = buildProtectedResourceMetadata(
    env.BETTER_AUTH_URL,
    env.API_JWT_ISSUER ?? env.BETTER_AUTH_URL,
  );
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}
