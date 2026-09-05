import type { NextRequest } from "next/server";
import { mintAccessToken } from "@/lib/api-auth/jwt.server";
import { resolveCallerDetailed, type ResolvedCaller } from "@/lib/api-auth/resolve-caller.server";
import { mcpAudience } from "@/lib/api-auth/resources";
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
 * Upper bound on the v1-audience token the gateway mints for its own
 * self-call (review #50/#53). One JSON-RPC request → one v1 call, so a few
 * seconds would do; 60 s leaves headroom for a slow upstream without
 * creating a long-lived v1 credential out of an MCP-only one.
 */
const EXCHANGE_TTL_SECONDS = 60;

/**
 * POST /api/mcp — Phase 0 Model Context Protocol endpoint (design
 * docs/design-mcp-agent-gateway.md §8). Stateless Streamable HTTP: one
 * JSON-RPC request in, one JSON response out. DARK unless `MCP_ENABLED`.
 *
 * Auth: a bearer credential — a `drk_…` API key, or a JWT minted for THIS
 * resource (`resource=<origin>/api/mcp` at the token endpoint, RFC 8707).
 * No valid credential → 401 with `WWW-Authenticate` naming the protected-
 * resource metadata (RFC 9728 §5.1) and, for a wrong-audience token, the
 * RFC 6750 `invalid_token` challenge.
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

  // JSON-RPC batching was removed in MCP 2025-06-18. protocol.ts still
  // accepts the older 2025-03-26 / 2024-11-05 revisions, under which batching
  // was permitted — rejecting batches for those too is a deliberate deviation
  // that keeps one code path; narrowing SUPPORTED_PROTOCOL_VERSIONS to
  // 2025-06-18 would remove it (review #232).
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
  // though it authenticates elsewhere.
  //
  // Audience binding (RFC 8707, review #50/#53): a JWT must carry the MCP
  // resource identifier as `aud`, so a token minted for general `/api/v1` use
  // cannot drive the gateway (and vice versa). `MCP_AUDIENCE_GRACE` widens the
  // accepted set to the v1 audience for a rollout window so agents minted
  // before the change keep working while they migrate; API keys are not
  // audience-bound and pass either way.
  const mcpAud = mcpAudience(env);
  const expectedAudience = env.MCP_AUDIENCE_GRACE ? [mcpAud, env.API_JWT_AUDIENCE] : [mcpAud];
  const resolution = await resolveCallerDetailed(request, { expectedAudience });
  if (!resolution.ok || !resolution.caller.isBearer) {
    const challenge =
      !resolution.ok && resolution.reason === "audience_mismatch"
        ? {
            error: "invalid_token",
            description: `The token was not issued for this resource; request it with resource=${mcpAud}`,
          }
        : undefined;
    return jsonRpc(rpcError(payload.id ?? null, RPC_UNAUTHORIZED, "Unauthorized"), 401, {
      "WWW-Authenticate": mcpWwwAuthenticate(env.BETTER_AUTH_URL, challenge),
    });
  }

  return jsonRpc(
    await handleMcpRequest(payload, { headers: await forwardHeaders(request, resolution.caller) }),
    200,
  );
}

/**
 * Headers the generated tools send to the v1 API. Normally the agent's own
 * `Authorization` header is forwarded untouched (API key, or a legacy
 * v1-audience JWT under `MCP_AUDIENCE_GRACE`). An MCP-audience JWT would be
 * REJECTED by the v1 guard — that rejection is the whole point of audience
 * binding — so the gateway, which is also the authorization server,
 * exchanges it for a v1-audience token with the SAME subject, scopes, org,
 * `jti` and source credential (`cid`), capped at the shorter of the original
 * token's remaining life and {@link EXCHANGE_TTL_SECONDS}. Nothing widens:
 * the v1 guard re-applies permission ∩ scope, the ban check and the
 * credential-status check to the exchanged token exactly as it would have
 * to the original.
 */
async function forwardHeaders(request: NextRequest, caller: ResolvedCaller): Promise<Headers> {
  const headers = new Headers(request.headers);
  if (caller.kind !== "jwt" || !caller.jwt) return headers;
  const env = getServerEnv();
  if (caller.jwt.audience.includes(env.API_JWT_AUDIENCE)) return headers;

  const remaining = Math.floor((caller.jwt.expiresAt.getTime() - Date.now()) / 1000);
  const exchanged = await mintAccessToken({
    subject: caller.betterAuthUserId,
    scopes: caller.grantedScopes ?? [],
    organizationId: caller.jwt.organizationId,
    jti: caller.credentialId ?? crypto.randomUUID(),
    ttlSeconds: Math.max(1, Math.min(EXCHANGE_TTL_SECONDS, remaining)),
    audience: env.API_JWT_AUDIENCE,
    credential: caller.jwt.credential,
  });
  headers.set("authorization", `Bearer ${exchanged.token}`);
  return headers;
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
