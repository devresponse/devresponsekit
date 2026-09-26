import type { NextRequest } from "next/server";
import { consumeToken, rateLimitKey, type RateLimitOptions } from "@/lib/admin/rate-limit.server";
import { mintAccessToken } from "@/lib/api-auth/jwt.server";
import {
  resolveCallerDetailed,
  type CallerRejectReason,
  type ResolvedCaller,
} from "@/lib/api-auth/resolve-caller.server";
import { mcpAudience } from "@/lib/api-auth/resources";
import { getServerEnv } from "@/lib/env";
import { handleMcpRequest } from "@/lib/mcp/dispatch.server";
import { mcpWwwAuthenticate } from "@/lib/mcp/metadata";
import { effectiveScopeHolder } from "@/lib/mcp/openapi-tools";
import { rateLimitDenialsTotal } from "@/lib/observability/metrics.server";
import {
  type JsonRpcResponse,
  RPC_INVALID_REQUEST,
  RPC_PARSE_ERROR,
  RPC_RATE_LIMITED,
  RPC_UNAUTHORIZED,
  checkProtocolVersionHeader,
  isNotification,
  isValidJsonRpcId,
  rpcError,
  validateJsonRpcEnvelope,
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
 * Tool-call budget per source credential (F-76): a 60-call burst, then one a
 * second. An agent is paced by its model, so a real session stays far below
 * it; a loop exporting data through read tools does not.
 */
const TOOL_CALLS: RateLimitOptions = { capacity: 60, refillPerSec: 1 };

/**
 * POST /api/mcp — Phase 0 Model Context Protocol endpoint (design
 * docs/design-mcp-agent-gateway.md §8). Stateless Streamable HTTP: one
 * JSON-RPC request in, one JSON response out. DARK unless `MCP_ENABLED`.
 *
 * Auth: a bearer credential — a `drk_…` API key, or a JWT minted for THIS
 * resource (`resource=<origin>/api/mcp` at the token endpoint, RFC 8707).
 * No valid credential → 401 with `WWW-Authenticate` naming the protected-
 * resource metadata (RFC 9728 §5.1) and, for a presented token that was
 * refused, the RFC 6750 `invalid_token` error ({@link bearerChallenge}).
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
  // Full JSON-RPC 2.0 envelope check: `jsonrpc` must be exactly "2.0" and a
  // present `id` must be a string or an integer (review #205; MCP forbids a
  // null request id, I-04). A malformed id is never echoed — the error
  // carries `id: null`.
  const envelope = validateJsonRpcEnvelope(payload);
  if (!envelope.ok) {
    return jsonRpc(rpcError(null, RPC_INVALID_REQUEST, envelope.reason), 400);
  }
  const message = envelope.message;
  const messageId = isValidJsonRpcId(message.id) ? (message.id ?? null) : null;

  // Streamable HTTP: a client that has completed `initialize` MUST send the
  // negotiated revision back on every later request. An absent header means
  // an older client (assume 2025-03-26); a header naming a revision this
  // server does not negotiate is a 400, not a silent downgrade (review #205).
  const version = checkProtocolVersionHeader(request.headers.get("MCP-Protocol-Version"));
  if (!version.ok) {
    return jsonRpc(rpcError(messageId, RPC_INVALID_REQUEST, version.message), 400);
  }

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
    return jsonRpc(rpcError(messageId, RPC_UNAUTHORIZED, "Unauthorized"), 401, {
      "WWW-Authenticate": mcpWwwAuthenticate(
        env.BETTER_AUTH_URL,
        resolution.ok ? undefined : bearerChallenge(resolution.reason, mcpAud),
      ),
    });
  }
  const caller = resolution.caller;

  // Notifications carry no data access and receive no response — but they are
  // still requests to a PROTECTED resource, so the bearer check comes first
  // (review #205): an unauthenticated caller gets the 401 challenge, not a
  // 202 that pretends the server accepted its message.
  if (isNotification(message)) return new Response(null, { status: 202 });

  // F-76: every tool call is charged to the credential's bucket BEFORE it is
  // dispatched. v1 limits only its mutations, so an agent could otherwise
  // page through the user directory and the audit log as fast as it liked.
  if (message.method === "tools/call") {
    const bucket = consumeToken(rateLimitKey("mcp.tools.call", toolCallActor(caller)), TOOL_CALLS);
    if (!bucket.ok) {
      rateLimitDenialsTotal.inc({ scope: "mcp.tools.call" });
      const retryAfter = bucket.retryAfterSeconds;
      return jsonRpc(rpcError(messageId, RPC_RATE_LIMITED, "Rate limited", { retryAfter }), 429, {
        "Retry-After": String(retryAfter),
      });
    }
  }

  return jsonRpc(
    await handleMcpRequest(message, {
      holdsScope: effectiveScopeHolder({
        permissions: caller.access.permissions,
        grantedScopes: caller.grantedScopes,
      }),
      forwardHeaders: () => forwardHeaders(request, caller),
    }),
    200,
  );
}

/**
 * The RFC 6750 §3 attributes of the 401 challenge. A request that presented
 * no token gets none (RFC 6750 §3.1: it "SHOULD NOT include an error
 * code"). One whose token was refused gets `invalid_token` whatever the
 * reason (I-04): before, only a wrong audience did, so a client whose token
 * had expired, or whose key or client was revoked, got a bare challenge and
 * a strict one never knew to fetch a new token. The reasons are not told
 * apart (a bad token, a disabled path and a banned owner read the same),
 * except that the audience case names the resource to request.
 */
function bearerChallenge(
  reason: CallerRejectReason,
  mcpAud: string,
): { error: string; description: string } | undefined {
  if (reason === "no_credential") return undefined;
  if (reason === "audience_mismatch") {
    return {
      error: "invalid_token",
      description: `The token was not issued for this resource; request it with resource=${mcpAud}`,
    };
  }
  return {
    error: "invalid_token",
    description: "The access token is invalid, expired or revoked",
  };
}

/**
 * The bucket a tool call is charged to: the credential the token was minted
 * FROM, not `credentialId`. A JWT's `credentialId` is its `jti`, fresh on
 * every mint, so keying on it would hand an agent a full budget each time it
 * re-minted (F-76). The source id is the key's row id for a key-minted token,
 * so it shares the bucket of the key used directly. A legacy token without a
 * `cid` falls back to its `jti`, and only a caller with neither to its
 * principal.
 */
function toolCallActor(caller: ResolvedCaller): string {
  return caller.jwt?.credential?.id ?? caller.credentialId ?? caller.betterAuthUserId;
}

/**
 * Headers the generated tools send to the v1 API.
 *
 * The gateway resolves the caller ONCE (above) and hands the self-call a
 * short-lived token derived from that resolution, rather than replaying the
 * long-lived credential for the v1 guard to resolve from scratch:
 *
 *   - an MCP-audience JWT MUST be exchanged — the v1 guard would refuse it,
 *     which is the whole point of audience binding (review #50/#53);
 *   - an API KEY is exchanged for the same reason the JWT is threaded
 *     through: replaying it made every `tools/call` verify the key twice and
 *     stamp `last_used_at` twice — two extra DB round-trips per call, one of
 *     them a write (review #207). The exchanged token keeps the key's row id
 *     as `jti` and as `cid`, so v1 still re-reads the key's status/expiry on
 *     every request and a revoked key dies at once, and charges the call to
 *     the same per-credential rate-limit bucket a direct API-key call uses
 *     (v1 keys a token's bucket on its `cid`, F-73).
 *   - a legacy v1-audience JWT (under `MCP_AUDIENCE_GRACE`) is forwarded
 *     untouched: it is already the right audience and re-verifying a
 *     signature costs no DB write.
 *
 * Every exchange carries the SAME subject, org, `jti` and source credential,
 * and the caller's resolved scopes (`grantedScopes`: for a JWT, its `scope`
 * claim already capped at its source credential's current scopes, F-71). It
 * is capped at {@link EXCHANGE_TTL_SECONDS} (and, for a JWT, at the
 * original's remaining life). Nothing widens: the v1 guard re-applies
 * permission ∩ scope, the ban check and the credential-status check to the
 * exchanged token exactly as it would have to the original.
 *
 * With `API_JWT_ENABLED` off there is no signing key to mint with (and v1
 * could not verify one anyway), so an API key is forwarded as before.
 */
async function forwardHeaders(request: NextRequest, caller: ResolvedCaller): Promise<Headers> {
  const headers = new Headers(request.headers);
  const env = getServerEnv();

  if (caller.kind === "api_key") {
    if (!env.API_JWT_ENABLED || !caller.credentialId) return headers;
    const exchanged = await mintAccessToken({
      subject: caller.betterAuthUserId,
      scopes: caller.grantedScopes ?? [],
      // The key's BINDING, not the resolved access context: a key bound to an
      // org whose membership the principal lost must keep failing closed
      // downstream, not fall back to their earliest org.
      organizationId: caller.boundOrganizationId,
      jti: caller.credentialId,
      ttlSeconds: EXCHANGE_TTL_SECONDS,
      audience: env.API_JWT_AUDIENCE,
      credential: { kind: "api_key", id: caller.credentialId },
    });
    headers.set("authorization", `Bearer ${exchanged.token}`);
    return headers;
  }

  if (caller.kind !== "jwt" || !caller.jwt) return headers;
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
