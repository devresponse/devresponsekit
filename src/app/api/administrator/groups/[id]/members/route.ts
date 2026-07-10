import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin } from "@/lib/admin/access-scope.server";
import {
  permissionKeysForGroup,
  conferrablePermissions,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
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

/**
 * GET /api/administrator/groups/[id]/members
 *
 * Paginated users in the group. Caller MUST hold `admin.groups.read`.
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

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["primary_email", "display_name", "created_at"],
    defaultSort: [{ field: "primary_email", direction: "asc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_group_memberships as gm")
    .innerJoin("app_users as u", "u.id", "gm.app_user_id")
    .where("gm.group_id", "=", id);
  if (query.q) {
    const like = likeContains(query.q);
    base = base.where((eb) =>
      eb.or([eb("u.primary_email", "ilike", like), eb("u.display_name", "ilike", like)]),
    );
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "u.id as app_user_id",
      "u.primary_email as primary_email",
      "u.display_name as display_name",
      "u.status as status",
      "gm.created_at as created_at",
    ]),
    query,
  );

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  return NextResponse.json(buildListResponse(items, Number(totalRow?.total ?? 0), query));
}

const idsSchema = z
  .object({
    appUserIds: z
      .array(z.string().regex(/^[0-9a-f-]{36}$/i))
      .min(1)
      .max(500),
  })
  .strict();

/**
 * POST /api/administrator/groups/[id]/members
 *
 * Add users to the group. Body: `{ appUserIds: string[] }`. A user may only
 * be added if they hold an ACTIVE membership in the group's org — a
 * cross-org id is silently dropped, never added (ADR-0001/0002). Caller MUST
 * hold `admin.groups.assign`.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.assign",
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
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) return adminErrorResponse("invalid_body", 400, request);

  const group = await loadGroup(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  // Privilege-escalation guard (AUTHZ-3): group membership confers the union
  // of the group's roles' permissions to every member (ADR-0002), so a
  // non-SUPERADMIN may only add members to a group whose conferred permissions
  // are a subset of their own. Mirrors the role-attach guard in
  // groups/[id]/roles; checked per-group, so it covers the whole batch.
  // A bearer credential is bounded by its scopes, not just its owner's
  // permissions, and never takes the SUPERADMIN fast-path (P1-1).
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferred = await permissionKeysForGroup(group.id);
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, conferred);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  // Confine to users who are ACTIVE members of the group's org.
  const eligible = await db
    .selectFrom("app_organization_memberships")
    .select("app_user_id")
    .where("organization_id", "=", group.organization_id)
    .where("status", "=", "active")
    .where("app_user_id", "in", parsed.data.appUserIds)
    .execute();
  const eligibleIds = eligible.map((r) => r.app_user_id);
  if (eligibleIds.length === 0) {
    return adminErrorResponse("user_not_found", 404, request);
  }

  await db
    .insertInto("app_group_memberships")
    .values(eligibleIds.map((appUserId) => ({ group_id: id, app_user_id: appUserId })))
    .onConflict((oc) => oc.doNothing())
    .execute();

  await auditOrgAction("admin.group.members_added", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: group.organization_id,
    metadata: { groupId: id, key: group.key, appUserIds: eligibleIds },
  });

  return NextResponse.json({ ok: true, added: eligibleIds.length });
}

/**
 * DELETE /api/administrator/groups/[id]/members
 *
 * Remove users from the group. Body: same `{ appUserIds: string[] }`. Caller
 * MUST hold `admin.groups.assign`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.groups.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.groups.assign",
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
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) return adminErrorResponse("invalid_body", 400, request);

  const group = await loadGroup(id);
  if (!group || !canAccessOrg(guard.access, group.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  await db
    .deleteFrom("app_group_memberships")
    .where("group_id", "=", id)
    .where("app_user_id", "in", parsed.data.appUserIds)
    .execute();

  await auditOrgAction("admin.group.members_removed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: group.organization_id,
    metadata: { groupId: id, key: group.key, appUserIds: parsed.data.appUserIds },
  });

  return NextResponse.json({ ok: true, removed: parsed.data.appUserIds.length });
}
