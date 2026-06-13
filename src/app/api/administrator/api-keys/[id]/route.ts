import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { revokeApiKey } from "@/lib/api-auth/api-keys.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/administrator/api-keys/:id
 *
 * Returns a single API key with its resolved owner / creator / revoker
 * emails. Caller MUST hold `admin.apikeys.read`. Never returns the
 * secret or its hash.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apikeys.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request, { requestId: guard.requestId });
  }

  const row = await db
    .selectFrom("app_api_keys as k")
    .leftJoin("app_users as u", "u.id", "k.app_user_id")
    .leftJoin("app_users as c", "c.id", "k.created_by")
    .leftJoin("app_users as r", "r.id", "k.revoked_by")
    .select([
      "k.id",
      "k.app_user_id",
      "u.primary_email as owner_email",
      "u.display_name as owner_name",
      "k.organization_id",
      "k.name",
      "k.key_prefix",
      "k.scopes",
      "k.status",
      "k.expires_at",
      "k.last_used_at",
      "k.last_used_ip",
      "k.created_at",
      "c.primary_email as created_by_email",
      "k.revoked_at",
      "r.primary_email as revoked_by_email",
      "k.revoked_reason",
    ])
    .where("k.id", "=", id)
    .executeTakeFirst();
  if (!row) {
    return adminErrorResponse("api_key_not_found", 404, request, { requestId: guard.requestId });
  }

  return NextResponse.json(row);
}

/**
 * DELETE /api/administrator/api-keys/:id
 *
 * Revokes (soft-deletes) an API key. Caller MUST hold
 * `admin.apikeys.manage`.
 *
 * Keys are never hard-deleted: the row is the audit trail for every
 * request the key ever made and is referenced by usage telemetry.
 * Revocation flips `status` to `revoked` and stamps the actor/reason —
 * verification rejects revoked keys immediately. The operation is
 * idempotent: revoking an already-revoked key returns `200` without a
 * second audit row.
 */
const deleteBodySchema = z.object({ reason: z.string().max(500).optional() }).strict();

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apikeys.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const actorAppUserId = guard.access.appUserId;
  if (!actorAppUserId) {
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request, { requestId: guard.requestId });
  }

  // Reason is optional; tolerate an empty/absent body.
  let reason: string | undefined;
  try {
    const text = await request.text();
    if (text) {
      const parsed = deleteBodySchema.safeParse(JSON.parse(text));
      if (parsed.success) reason = parsed.data.reason;
    }
  } catch {
    // No body / invalid JSON — revoke without a reason.
  }

  const existing = await db
    .selectFrom("app_api_keys")
    .select(["id", "app_user_id", "status", "key_prefix"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("api_key_not_found", 404, request, { requestId: guard.requestId });
  }
  if (existing.status !== "active") {
    // Already revoked — idempotent success, no duplicate audit row.
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await revokeApiKey(id, actorAppUserId, reason);

  await auditEvent({
    eventType: "admin.api_key.revoked",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: existing.app_user_id,
    request,
    requestId: guard.requestId,
    reason: reason ?? null,
    metadata: { apiKeyId: id, prefix: existing.key_prefix },
  });

  return NextResponse.json({ ok: true });
}
