import type { NextRequest } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { requireAccountUser } from "@/lib/account/guard.server";
import { getServerEnv } from "@/lib/env";
import { createApiKey, listApiKeysForUser } from "@/lib/api-auth/api-keys.server";
import { normalizeScopes, ungrantableScopesForCaller } from "@/lib/api-auth/scopes";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/me/api-keys
 *
 * Lists the CALLER'S OWN API keys (design §9.1). Strictly self-scoped via
 * the account guard — no id is accepted; rows are keyed on the session/
 * credential principal. The secret and hash are never returned.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAccountUser(request, "account.read");
  if (!guard.ok) return guard.response;

  const items = await listApiKeysForUser(guard.actor.appUserId);
  return v1JsonResponse({ items }, request);
}

/**
 * POST /api/v1/me/api-keys
 *
 * Mints a new API key for the caller. The plaintext is returned EXACTLY
 * ONCE and never recoverable afterward.
 *
 * Threat / contract:
 *   - Requires the `account.apikeys.manage` scope (bearer) or a cookie
 *     session.
 *   - Requested scopes are checked against the caller's OWN authority
 *     ({@link ungrantableScopesForCaller}) so a credential can never mint
 *     a broader credential than itself (design §7, §10.2).
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(z.string().min(1).max(120)).max(64).default([]),
    expiresInDays: z.number().int().positive().max(3650).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireAccountUser(request, "account.apikeys.manage");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request);
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { detail: "Invalid request body." });
  }

  const scopes = normalizeScopes(parsed.data.scopes);
  const ungrantable = ungrantableScopesForCaller(actor.access.permissions, actor.grantedScopes, scopes);
  if (ungrantable.length > 0) {
    return problemResponse("invalid_scope", 403, request, {
      detail: "You cannot grant scopes you do not hold.",
      extra: { ungrantableScopes: ungrantable },
    });
  }

  const env = getServerEnv();
  const ttlDays = parsed.data.expiresInDays ?? env.API_KEY_DEFAULT_TTL_DAYS ?? null;
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : null;

  const created = await createApiKey({
    ownerAppUserId: actor.appUserId,
    organizationId: actor.access.organizationId,
    name: parsed.data.name,
    scopes,
    expiresAt,
    createdByAppUserId: actor.appUserId,
  });

  await auditEvent({
    eventType: "api_key.created",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    organizationId: actor.access.organizationId,
    request,
    // NEVER the plaintext or hash — only non-secret metadata.
    metadata: { apiKeyId: created.id, scopes, prefix: created.key_prefix },
  });

  return v1JsonResponse(
    {
      id: created.id,
      name: created.name,
      prefix: created.key_prefix,
      scopes: created.scopes,
      expiresAt: created.expires_at,
      // Shown ONCE. Persist it now — it cannot be retrieved again.
      key: created.plaintext,
    },
    request,
    { status: 201 },
  );
}
