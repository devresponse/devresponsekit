import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { updateGroupSchema } from "@/lib/validation/groups";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { loadGroupDetail } from "@/lib/admin/groups.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/groups/[id]
 *
 * Group detail + role/member counts. Caller MUST hold `admin.groups.read`.
 * ADR-0001: an org admin reaches only their org's groups (404 otherwise).
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  const group = await loadGroupDetail(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  return NextResponse.json({ group });
}

/**
 * PATCH /api/administrator/groups/[id]
 *
 * Partial update of name / description. `key` is read-only after creation.
 * Caller MUST hold `admin.groups.update`.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.update",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateGroupSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if (Object.keys(updates).length === 0) {
    return adminErrorResponse("no_changes", 400, request);
  }

  const existing = await db
    .selectFrom("app_groups")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing || !canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  updates.updated_at = new Date();
  await db.updateTable("app_groups").set(updates).where("id", "=", id).execute();

  await auditOrgAction("admin.group.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { groupId: id, key: existing.key, fields: Object.keys(updates) },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/groups/[id]
 *
 * Deletes the group; its role bundles and memberships cascade away (the
 * users keep any roles assigned to them DIRECTLY). Caller MUST hold
 * `admin.groups.delete`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.delete",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  const existing = await db
    .selectFrom("app_groups")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing || !canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  await db.deleteFrom("app_groups").where("id", "=", id).execute();

  await auditOrgAction("admin.group.deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { groupId: id, key: existing.key },
  });

  return NextResponse.json({ ok: true });
}
