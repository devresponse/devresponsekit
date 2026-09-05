import type { NextRequest } from "next/server";
import { consumeToken, rateLimitKey } from "@/lib/admin/rate-limit.server";
import { auditEvent } from "@/lib/audit.server";
import { clientIpKey } from "@/lib/client-ip";
import { getServerEnv } from "@/lib/env";
import {
  buildRegistrationResponse,
  isRegistrationOrgPermitted,
  parseRegistrationOrgAllowList,
  registrationRequestSchema,
  statusForMode,
} from "@/lib/mcp/registration";
import { registerMcpAgent } from "@/lib/mcp/registration.server";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";

export const dynamic = "force-dynamic";

// Registration is a sensitive creation endpoint: a hard per-IP bucket plus a
// deployment-wide floor a spoofed XFF cannot escape (mirrors /auth/token).
const REG_LIMIT = { capacity: 5, refillPerSec: 0.1 }; // ~1 / 10s, burst 5
const REG_GLOBAL_LIMIT = { capacity: 60, refillPerSec: 1 };

/**
 * POST /api/mcp/register — RFC 7591 Dynamic Client Registration for AI
 * agents (Phase 2, design docs/design-mcp-agent-gateway.md §10). Public and
 * rate-limited. Provisions a machine service account + a ZERO-SCOPE OAuth
 * client bound to the target org, and returns the credentials once. DARK
 * unless `MCP_REGISTRATION_ENABLED`.
 *
 * Safe by construction: in `approval` mode the account is `pending_approval`
 * (it cannot even mint a token until an admin activates it); in `open` mode
 * it is active but the client is scopeless, so every tool 403s until an
 * admin grants scopes.
 *
 * Abuse controls (review #51): a caller may name an `organization` only where
 * the operator opened it (default org / `MCP_REGISTRATION_ALLOWED_ORGS`); the
 * per-org quota counts SELF-registered active clients only and is checked
 * atomically with the insert under a per-org advisory lock
 * (`registerMcpAgent`); stale pending registrations are expired by the
 * scheduled reaper (`/api/internal/mcp-registration-reap`).
 */
export async function POST(request: NextRequest): Promise<Response> {
  const env = getServerEnv();
  if (!env.MCP_REGISTRATION_ENABLED) return notFound();

  // Rate-limit before any DB work: a global floor + a per-IP bucket.
  if (!consumeToken(rateLimitKey("mcp.register", "__global__"), REG_GLOBAL_LIMIT).ok) {
    return oauthError("temporarily_unavailable", "Registration is rate limited.", 429);
  }
  if (!consumeToken(rateLimitKey("mcp.register", clientIpKey(request.headers)), REG_LIMIT).ok) {
    return oauthError("temporarily_unavailable", "Registration is rate limited.", 429);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "Request body must be JSON.", 400);
  }
  const parsed = registrationRequestSchema.safeParse(json);
  if (!parsed.success) {
    return oauthError("invalid_client_metadata", "A non-empty `client_name` is required.", 400);
  }
  const body = parsed.data;

  // Resolve the target org. A request that omits `organization` goes to the
  // configured default; one that names an org must name one the operator
  // opened (review #51 — before this a caller-supplied `organization`
  // silently overrode MCP_REGISTRATION_DEFAULT_ORG and could target any
  // active tenant). Active orgs only; a refused-but-existing org gets the
  // SAME generic rejection as an unknown one, so the endpoint never reveals
  // which orgs exist beyond the ones it is open for.
  const identifier = body.organization ?? env.MCP_REGISTRATION_DEFAULT_ORG ?? "";
  if (!identifier) {
    return oauthError("invalid_client_metadata", "An `organization` is required.", 400);
  }
  const org = await resolveOrganizationByIdentifier(identifier);
  if (
    !org ||
    (body.organization !== undefined &&
      !isRegistrationOrgPermitted(org, {
        defaultOrg: env.MCP_REGISTRATION_DEFAULT_ORG,
        allowList: parseRegistrationOrgAllowList(env.MCP_REGISTRATION_ALLOWED_ORGS),
      }))
  ) {
    return oauthError("invalid_client_metadata", "Unknown organization.", 400);
  }

  // Quota + provisioning in one transaction under a per-org advisory lock:
  // the former route-level count → insert was a TOCTOU that let concurrent
  // requests overshoot the quota (review #51). 0 = unlimited.
  const status = statusForMode(env.MCP_REGISTRATION_MODE);
  const registered = await registerMcpAgent({
    clientName: body.client_name,
    organizationId: org.id,
    status,
    maxPerOrg: env.MCP_REGISTRATION_MAX_PER_ORG,
  });
  if (!registered.ok) {
    return oauthError("access_denied", "Registration quota reached for this organization.", 403);
  }
  const provisioned = registered.agent;

  await auditEvent({
    eventType: "mcp.client.registered",
    outcome: "success",
    actorBetterAuthUserId: provisioned.betterAuthUserId,
    appUserId: provisioned.appUserId,
    organizationId: org.id,
    request,
    metadata: {
      clientId: provisioned.client.client_id,
      clientName: body.client_name,
      mode: env.MCP_REGISTRATION_MODE,
      status,
    },
  });

  const response = buildRegistrationResponse({
    clientId: provisioned.client.client_id,
    clientSecret: provisioned.client.clientSecret,
    clientName: body.client_name,
    issuedAt: Math.floor(Date.now() / 1000),
  });
  return new Response(JSON.stringify(response), {
    status: 201,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

/** RFC 7591 §3.2.2 registration error (`application/json`). */
function oauthError(error: string, description: string, status: number): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
