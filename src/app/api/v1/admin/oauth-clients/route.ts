import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { requireApiPermission, enforceApiRateLimit } from "@/lib/api-auth/v1-guard.server";
import { createOauthClient, listOauthClients } from "@/lib/api-auth/oauth-clients.server";
import { normalizeScopes, ungrantableScopesForCaller } from "@/lib/api-auth/scopes";
import { isUuid } from "@/lib/admin/user-target.server";
import { problemResponse, v1JsonResponse } from "@/lib/api-auth/problem";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/oauth-clients — list registrations (`admin.clients.read`).
 */
export async function GET(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.clients.read");
  if (!guard.ok) return guard.response;

  const sp = request.nextUrl.searchParams;
  const page = Math.max(1, Number(sp.get("page") ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(sp.get("pageSize") ?? 25) || 25));
  const status = sp.get("status");

  const { items, total } = await listOauthClients({
    limit: pageSize,
    offset: (page - 1) * pageSize,
    status: status === "active" || status === "revoked" ? status : undefined,
  });

  return v1JsonResponse({ items, page, pageSize, total }, request);
}

/**
 * POST /api/v1/admin/oauth-clients — register a machine identity
 * (`admin.clients.manage`). Returns the client secret ONCE.
 *
 * The client borrows `serviceAppUserId`'s authority intersected with
 * `scopes`; that service user must already exist (provision it via
 * `/api/v1/users` first). The admin may only grant scopes they themselves
 * hold (design §7).
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scopes: z.array(z.string().min(1).max(120)).max(64).default([]),
    serviceAppUserId: z.string().refine(isUuid, "invalid_uuid"),
    organizationId: z.string().refine(isUuid, "invalid_uuid").nullable().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const guard = await requireApiPermission(request, "admin.clients.manage");
  if (!guard.ok) return guard.response;
  const { grant } = guard;

  const limited = enforceApiRateLimit("api.admin.clients", grant, request);
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return problemResponse("invalid_request", 400, request, { requestId: grant.requestId });
  }

  // The service principal must exist as an app user.
  const serviceUser = await db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("id", "=", parsed.data.serviceAppUserId)
    .executeTakeFirst();
  if (!serviceUser) {
    return problemResponse("invalid_request", 400, request, {
      detail: "serviceAppUserId does not reference an existing user.",
      requestId: grant.requestId,
    });
  }

  const scopes = normalizeScopes(parsed.data.scopes);
  const ungrantable = ungrantableScopesForCaller(
    grant.caller.access.permissions,
    grant.caller.grantedScopes,
    scopes,
  );
  if (ungrantable.length > 0) {
    return problemResponse("invalid_scope", 403, request, {
      detail: "You cannot grant scopes you do not hold.",
      extra: { ungrantableScopes: ungrantable },
      requestId: grant.requestId,
    });
  }

  const created = await createOauthClient({
    name: parsed.data.name,
    scopes,
    organizationId: parsed.data.organizationId ?? null,
    serviceAppUserId: parsed.data.serviceAppUserId,
    createdByAppUserId: grant.caller.access.appUserId ?? parsed.data.serviceAppUserId,
  });

  await auditEvent({
    eventType: "oauth_client.created",
    outcome: "success",
    actorBetterAuthUserId: grant.caller.betterAuthUserId,
    appUserId: parsed.data.serviceAppUserId,
    request,
    requestId: grant.requestId,
    metadata: { clientRowId: created.id, clientId: created.client_id, scopes },
  });

  return v1JsonResponse(
    {
      id: created.id,
      clientId: created.client_id,
      name: created.name,
      scopes: created.scopes,
      // Shown ONCE.
      clientSecret: created.clientSecret,
    },
    request,
    { status: 201, requestId: grant.requestId },
  );
}
