import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { updateRoleSchema } from "@/lib/validation/roles";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { AdminError, assertRoleNotInUse, loadRoleOrThrow } from "@/lib/admin/roles.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/roles/[id]
 *
 * Fetches a single role plus its permission keys and member count.
 * Caller MUST hold `admin.roles.read`.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  try {
    const role = await loadRoleOrThrow(id);
    // ADR-0001: confine an org admin to their org's roles; a global role is
    // SUPERADMIN-only. 404 (not 403) so a foreign role is not confirmed.
    if (!canAccessOrg(guard.access, role.organization_id)) {
      return adminErrorResponse("not_found", 404, request);
    }
    return NextResponse.json({ role });
  } catch (err) {
    if (err instanceof AdminError && err.code === "role_not_found") {
      return adminErrorResponse("not_found", 404, request);
    }
    throw err;
  }
}

/**
 * PATCH /api/administrator/roles/[id]
 *
 * Partial update of name / description. The `key` is intentionally
 * read-only after creation (mirrors §8.6 — "Settings" tab) so audit
 * trails referencing it stay valid.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateRoleSchema.safeParse(json);
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
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("not_found", 404, request);
  }
  // ADR-0001: confine an org admin to their org's roles; a global role is
  // SUPERADMIN-only. 404 (not 403) so a foreign role is not confirmed.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  await db.updateTable("app_roles").set(updates).where("id", "=", id).execute();

  await auditRoleAction("admin.role.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { roleId: id, key: existing.key, fields: Object.keys(updates) },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/roles/[id]
 *
 * Refuses with `role_in_use` (HTTP 409) when the role is still
 * referenced by `app_user_roles`. On success: deletes
 * `app_role_permissions` and the `app_roles` row in one transaction so
 * the constraint cannot leave orphan permission rows behind.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("not_found", 404, request);
  }
  // ADR-0001: confine an org admin to their org's roles; a global role is
  // SUPERADMIN-only. 404 (not 403) so a foreign role is not confirmed.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  try {
    await assertRoleNotInUse(id);
  } catch (err) {
    if (err instanceof AdminError && err.code === "role_in_use") {
      await auditRoleAction("admin.role.delete_blocked", "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: existing.organization_id,
        reason: "role_in_use",
        metadata: { roleId: id, key: existing.key },
      });
      return adminErrorResponse("role_in_use", 409, request);
    }
    throw err;
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("app_role_permissions").where("role_id", "=", id).execute();
    await trx.deleteFrom("app_roles").where("id", "=", id).execute();
  });

  await auditRoleAction("admin.role.deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { roleId: id, key: existing.key },
  });

  // All reads/writes above used the imported `db` symbol; no extra
  // bookkeeping needed before returning.
  return NextResponse.json({ ok: true });
}
