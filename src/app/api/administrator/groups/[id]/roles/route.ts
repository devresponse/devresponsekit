import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { canAccessOrg, isSuperadmin, SUPERADMIN_PERMISSION } from "@/lib/admin/access-scope.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadGroup(id: string) {
  return db
    .selectFrom("app_groups")
    .select(["id", "organization_id", "key"])
    .where("id", "=", id)
    .executeTakeFirst();
}

async function currentRoleIds(groupId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_group_roles")
    .select("role_id")
    .where("group_id", "=", groupId)
    .execute();
  return rows.map((r) => r.role_id);
}

/**
 * GET /api/administrator/groups/[id]/roles
 *
 * The roles a group confers. Caller MUST hold `admin.groups.read`.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  const group = await loadGroup(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  const roles = await db
    .selectFrom("app_group_roles as gr")
    .innerJoin("app_roles as r", "r.id", "gr.role_id")
    .select(["r.id as id", "r.key as key", "r.name as name"])
    .where("gr.group_id", "=", id)
    .orderBy("r.key", "asc")
    .execute();

  return NextResponse.json({ roles });
}

const idsSchema = z
  .object({ roleIds: z.array(z.string().min(1).max(120)).min(1).max(500) })
  .strict();

/**
 * POST /api/administrator/groups/[id]/roles
 *
 * Attach roles to the group. Body: `{ roleIds: string[] }`. Caller MUST hold
 * `admin.groups.assign`.
 *
 * Guards (ADR-0002): every role must belong to the GROUP'S org — a group may
 * not bundle a global or foreign-org role (404). Only a SUPERADMIN may bundle
 * a role that carries the `superuser` marker (privilege escalation → 403).
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) return adminErrorResponse("invalid_body", 400, request);

  const group = await loadGroup(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  // Every requested role must exist AND belong to the group's own org.
  const roles = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id"])
    .where("id", "in", parsed.data.roleIds)
    .execute();
  const sameOrg = roles.filter((r) => r.organization_id === group.organization_id);
  if (sameOrg.length !== parsed.data.roleIds.length) {
    return adminErrorResponse("role_not_found", 404, request);
  }

  // Privilege-escalation guard: only a SUPERADMIN may bundle a role that
  // grants the `superuser` marker.
  if (!isSuperadmin(guard.access)) {
    const grantsSuperuser = await db
      .selectFrom("app_role_permissions as rp")
      .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
      .select("p.id")
      .where("rp.role_id", "in", parsed.data.roleIds)
      .where("p.key", "=", SUPERADMIN_PERMISSION)
      .executeTakeFirst();
    if (grantsSuperuser) return adminErrorResponse("forbidden", 403, request);
  }

  await db
    .insertInto("app_group_roles")
    .values(parsed.data.roleIds.map((roleId) => ({ group_id: id, role_id: roleId })))
    .onConflict((oc) => oc.doNothing())
    .execute();

  await auditOrgAction("admin.group.roles_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: group.organization_id,
    metadata: { groupId: id, key: group.key, added: parsed.data.roleIds },
  });

  return NextResponse.json({ ok: true, roleIds: await currentRoleIds(id) });
}

/**
 * DELETE /api/administrator/groups/[id]/roles
 *
 * Detach roles from the group. Body: same `{ roleIds: string[] }`. Caller MUST
 * hold `admin.groups.assign`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) return adminErrorResponse("invalid_body", 400, request);

  const group = await loadGroup(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  await db
    .deleteFrom("app_group_roles")
    .where("group_id", "=", id)
    .where("role_id", "in", parsed.data.roleIds)
    .execute();

  await auditOrgAction("admin.group.roles_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: group.organization_id,
    metadata: { groupId: id, key: group.key, removed: parsed.data.roleIds },
  });

  return NextResponse.json({ ok: true, roleIds: await currentRoleIds(id) });
}
