import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  canAccessOrg,
  resolveOrgScope,
  userHasMembershipInOrg,
} from "@/lib/admin/access-scope.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ groupId: z.string().regex(UUID_RE) }).strict();

/**
 * GET /api/administrator/users/[id]/groups
 *
 * The groups the target user belongs to, confined to the actor's org scope
 * (a foreign org's groups never appear). Caller MUST hold `admin.groups.read`.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json({ groups: [] });

  let base = db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_groups as g", "g.id", "gm.group_id")
    .where("gm.app_user_id", "=", target.appUserId);
  if (scope.kind === "org") {
    base = base.where("g.organization_id", "=", scope.organizationId);
  }
  const groups = await base
    .select([
      "g.id as id",
      "g.organization_id as organization_id",
      "g.key as key",
      "g.name as name",
    ])
    .orderBy("g.key", "asc")
    .execute();

  return NextResponse.json({ groups });
}

/** Loads a group's id + org for the membership-mutation guards. */
async function loadGroup(groupId: string) {
  return db
    .selectFrom("app_groups")
    .select(["id", "organization_id", "key"])
    .where("id", "=", groupId)
    .executeTakeFirst();
}

/**
 * POST /api/administrator/users/[id]/groups
 *
 * Add the target user to a group. Body: `{ groupId }`. The group must be in
 * the actor's scope and the user must hold an active membership in the
 * group's org. Caller MUST hold `admin.groups.assign`.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.assign",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return adminErrorResponse("invalid_body", 400, request);

  const group = await loadGroup(parsed.data.groupId);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("group_not_found", 404, request);
  }
  if (!(await userHasMembershipInOrg(target.appUserId, group.organization_id))) {
    return adminErrorResponse("user_not_found", 404, request);
  }

  await db
    .insertInto("app_group_memberships")
    .values({ group_id: group.id, app_user_id: target.appUserId })
    .onConflict((oc) => oc.doNothing())
    .execute();

  await auditOrgAction("admin.group.members_added", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: group.organization_id,
    appUserId: target.appUserId,
    metadata: { groupId: group.id, key: group.key, appUserIds: [target.appUserId] },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

/**
 * DELETE /api/administrator/users/[id]/groups
 *
 * Remove the target user from a group. Body: `{ groupId }`. Caller MUST hold
 * `admin.groups.assign`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.assign",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return adminErrorResponse("invalid_body", 400, request);

  const group = await loadGroup(parsed.data.groupId);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("group_not_found", 404, request);
  }

  await db
    .deleteFrom("app_group_memberships")
    .where("group_id", "=", group.id)
    .where("app_user_id", "=", target.appUserId)
    .execute();

  await auditOrgAction("admin.group.members_removed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: group.organization_id,
    appUserId: target.appUserId,
    metadata: { groupId: group.id, key: group.key, appUserIds: [target.appUserId] },
  });

  return NextResponse.json({ ok: true });
}
