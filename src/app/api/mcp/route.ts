import type { NextRequest } from "next/server";
import { resolveCaller } from "@/lib/api-auth/resolve-caller.server";
import { getServerEnv } from "@/lib/env";
import { handleMcpRequest } from "@/lib/mcp/dispatch.server";
import { mcpWwwAuthenticate } from "@/lib/mcp/metadata";
import {
  type JsonRpcResponse,
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR,
  RPC_UNAUTHORIZED,
  isJsonRpcMessage,
  isNotification,
  rpcError,
} from "@/lib/mcp/protocol";

export const dynamic = "force-dynamic";

/**
 * POST /api/mcp — Phase 0 Model Context Protocol endpoint (design
 * docs/design-mcp-agent-gateway.md §8). Stateless Streamable HTTP: one
 * JSON-RPC request in, one JSON response out. DARK unless `MCP_ENABLED`.
 *
 * Auth: the same bearer credential the machine API accepts — a `drk_…` API
 * key or a client-credentials JWT. No valid credential → 401 with
 * `WWW-Authenticate` (the hook Phase 1's OAuth discovery builds on).
 */
export async function POST(request: NextRequest): Promise<Response> {
  const env = getServerEnv();
  if (!env.MCP_ENABLED) return notFound();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonRpc(rpcError(null, RPC_PARSE_ERROR, "Parse error"), 400);
  }

  // JSON-RPC batching was removed in MCP 2025-06-18.
  if (Array.isArray(payload)) {
    return jsonRpc(rpcError(null, RPC_INVALID_REQUEST, "JSON-RPC batching is not supported"), 400);
  }
  if (!isJsonRpcMessage(payload)) {
    return jsonRpc(rpcError(null, RPC_INVALID_REQUEST, "Invalid Request"), 400);
  }

  // Notifications carry no data access and receive no response.
  if (isNotification(payload)) return new Response(null, { status: 202 });

  // Protected resource: require a BEARER credential (API key / JWT). A cookie
  // session is not an audience-bound OAuth token, so it is rejected here even
  // though it authenticates elsewhere. The 401 points at the protected-resource
  // metadata (RFC 9728 §5.1) so a client can discover the authorization server.
  const caller = await resolveCaller(request);
  if (!caller || !caller.isBearer) {
    return jsonRpc(rpcError(payload.id ?? null, RPC_UNAUTHORIZED, "Unauthorized"), 401, {
      "WWW-Authenticate": mcpWwwAuthenticate(env.BETTER_AUTH_URL),
    });
  }

  return jsonRpc(await handleMcpRequest(payload, request), 200);
}

/**
 * GET /api/mcp — Phase 0 offers no server-initiated SSE stream, so per the
 * Streamable HTTP spec this returns 405 (still dark when disabled).
 */
export async function GET(): Promise<Response> {
  if (!getServerEnv().MCP_ENABLED) return notFound();
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function jsonRpc(
  body: JsonRpcResponse,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
  });
}
