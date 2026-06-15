import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { rotateApiKey } from "@/lib/api-auth/api-keys.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/administrator/api-keys/:id/rotate
 *
 * Rotates an API key: issues a fresh secret with the same owner, scopes,
 * and expiry, then revokes the old key — atomically. Caller MUST hold
 * `admin.apikeys.manage`. The new plaintext is returned EXACTLY ONCE.
 *
 * Only `active` keys can be rotated; rotating a missing key returns
 * `404`, an already-revoked key returns `409`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apikeys.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apikeys.rotate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const actorAppUserId = guard.access.appUserId;
  if (!actorAppUserId) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request, { requestId: guard.requestId });
  }

  const existing = await db
    .selectFrom("app_api_keys")
    .select(["id", "app_user_id", "status", "organization_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  // ADR-0001: org admins may only rotate their own org's keys.
  if (!existing || !canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("api_key_not_found", 404, request, { requestId: guard.requestId });
  }
  if (existing.status !== "active") {
    return adminErrorResponse("api_key_inactive", 409, request, { requestId: guard.requestId });
  }

  const rotated = await rotateApiKey(id, actorAppUserId);
  if (!rotated) {
    // Lost a race with a concurrent revoke/rotate — surface as inactive.
    return adminErrorResponse("api_key_inactive", 409, request, { requestId: guard.requestId });
  }

  await auditEvent({
    eventType: "admin.api_key.rotated",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: existing.app_user_id,
    request,
    requestId: guard.requestId,
    metadata: { rotatedFromApiKeyId: id, apiKeyId: rotated.id, prefix: rotated.key_prefix },
  });

  return NextResponse.json(
    {
      id: rotated.id,
      rotatedFrom: id,
      name: rotated.name,
      prefix: rotated.key_prefix,
      scopes: rotated.scopes,
      expiresAt: rotated.expires_at,
      // Shown ONCE — persist it now, it cannot be retrieved again.
      key: rotated.plaintext,
    },
    { status: 201 },
  );
}
