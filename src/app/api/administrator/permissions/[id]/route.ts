import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { AdminError, assertPermissionNotInUse } from "@/lib/admin/roles.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/administrator/permissions/[id]
 *
 * Edits the description of a permission. The `key` is read-only after
 * creation — code-paths and audit rows reference the key by string and
 * a rename would silently break them. Caller MUST hold
 * `admin.permissions.manage`.
 */
const patchSchema = z
  .object({
    description: z.string().max(1000).nullable(),
  })
  .strict();

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.permissions.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: the permission catalog is platform-global; confine writes to
  // SUPERADMIN even if an org admin holds `admin.permissions.manage`.
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

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
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const existing = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("not_found", 404, request);
  }

  await db
    .updateTable("app_permissions")
    .set({ description: parsed.data.description })
    .where("id", "=", id)
    .execute();

  await auditRoleAction("admin.permission.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    metadata: { permissionId: id, key: existing.key },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/permissions/[id]
 *
 * Refuses with `permission_in_use` (HTTP 409) when the row is still
 * referenced by `app_role_permissions`. Caller MUST hold
 * `admin.permissions.manage`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.permissions.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;
  // ADR-0001: the permission catalog is platform-global; confine writes to
  // SUPERADMIN even if an org admin holds `admin.permissions.manage`.
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("not_found", 404, request);
  }

  try {
    await assertPermissionNotInUse(id);
  } catch (err) {
    if (err instanceof AdminError && err.code === "permission_in_use") {
      await auditRoleAction("admin.permission.delete_blocked", "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        reason: "permission_in_use",
        metadata: { permissionId: id, key: existing.key },
      });
      return adminErrorResponse("permission_in_use", 409, request);
    }
    throw err;
  }

  await db.deleteFrom("app_permissions").where("id", "=", id).execute();

  await auditRoleAction("admin.permission.deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    metadata: { permissionId: id, key: existing.key },
  });

  return NextResponse.json({ ok: true });
}
