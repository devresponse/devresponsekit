import { GET as protectedResourceMetadata } from "@/app/.well-known/oauth-protected-resource/route";

export const dynamic = "force-dynamic";

/**
 * GET /.well-known/oauth-protected-resource/api/mcp (RFC 9728 §3.1) — the
 * protected-resource metadata at the path derived from the resource
 * identifier `<origin>/api/mcp`, which is where the `/api/mcp` 401 challenge
 * points and where a client without that challenge probes first (I-04). The
 * same document as the root one, from the same builder, so the two cannot
 * drift; dark unless `MCP_ENABLED`, like it.
 */
export async function GET(): Promise<Response> {
  return protectedResourceMetadata();
}
