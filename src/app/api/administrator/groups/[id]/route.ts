import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { updateGroupSchema } from "@/lib/validation/groups";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin } from "@/lib/admin/access-scope.server";
import {
  permissionKeysForGroup,
  conferrablePermissions,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import { loadGroupDetail } from "@/lib/admin/groups.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { withAdminRoute } from "@/lib/route-handler.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/groups/[id]
 *
 * Group detail + role/member counts. Caller MUST hold `admin.groups.read`.
 * ADR-0001: an org admin reaches only their org's groups (404 otherwise).
 */
export const GET = withAdminRoute(async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) return adminErrorResponse("invalid_id", 400, request);

  const group = await loadGroupDetail(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  return NextResponse.json({ group });
});

/**
 * PATCH /api/administrator/groups/[id]
 *
 * Partial update of name / description. `key` is read-only after creation.
 * Caller MUST hold `admin.groups.update`.
 */
export const PATCH = withAdminRoute(async function PATCH(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.update",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
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
});

/**
 * DELETE /api/administrator/groups/[id]
 *
 * Deletes the group; its role bundles and memberships cascade away (the
 * users keep any roles assigned to them DIRECTLY). Caller MUST hold
 * `admin.groups.delete`.
 *
 * Carries the SAME AUTHZ-3 subset test as adding a member, measured against
 * everything the group confers (REVOKE-1, F-11 — 403 `forbidden` and an
 * `admin.group.delete_denied` audit row).
 */
export const DELETE = withAdminRoute(async function DELETE(
  request: NextRequest,
  ctx: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.groups.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.delete",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
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

  // REVOKE-1 (symmetry), F-11: deleting a group is the widest group revocation
  // there is. The cascade detaches every role it bundles from every member at
  // once, which is `DELETE …/members` for the whole roster and
  // `DELETE …/roles` for the whole bundle in one request, and both of those
  // are bounded by the conferral guard. This route was not, so an admin
  // holding only `admin.groups.delete` could delete a group that models the
  // tenant's administrators (or one that confers `superuser`) and could never
  // rebuild it, since AUTHZ-3 forbids conferring what they lack. Measured
  // against everything the group confers, exactly as the membership twins
  // measure it; a group with no roles confers nothing and deletes freely. A
  // bearer credential is bounded by its scopes and never takes the SUPERADMIN
  // fast-path (P1-1), so a superuser-owned key scoped to `admin.groups.delete`
  // is refused too.
  //
  // REVOKE-2 (last superadmin) does not apply: the cascade touches only
  // `app_group_roles` and `app_group_memberships`, and the invariant counts
  // DIRECT assignments alone (see `SuperuserGrant`), so no group delete can
  // take that set from one to zero.
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferred = await permissionKeysForGroup(existing.id);
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, conferred);
    if (unheld.length > 0) {
      await auditOrgAction("admin.group.delete_denied", "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: existing.organization_id,
        reason: "unheld_permissions",
        requestId: guard.requestId,
        metadata: { groupId: id, key: existing.key, unheldPermissions: unheld },
      });
      return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
    }
  }

  await db.deleteFrom("app_groups").where("id", "=", id).execute();

  await auditOrgAction("admin.group.deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: existing.organization_id,
    metadata: { groupId: id, key: existing.key },
  });

  return NextResponse.json({ ok: true });
});
