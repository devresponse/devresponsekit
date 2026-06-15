import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction, auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/organizations/:id/members
 *
 * Paginated list of memberships for this organization.
 * Filters: `status` (membership status).
 * `q` searches app_user display_name.
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const orgExists = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!orgExists) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  // ADR-0001: org admins are confined to their own org; 404 (not 403) so a
  // foreign org's existence is not confirmed. SUPERADMIN bypasses.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["status", "created_at", "user_display_name", "source_provider"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_users as u", "u.id", "m.app_user_id")
    .where("m.organization_id", "=", id);

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("m.status", "=", statusFilter);
  }

  if (query.q) {
    const like = `%${query.q}%`;
    base = base.where("u.display_name", "ilike", like);
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "m.id",
      "m.app_user_id",
      "u.display_name as user_display_name",
      "m.status",
      "m.source_provider",
      "m.provider_organization_key",
      "m.created_at",
      "m.updated_at",
    ]),
    query,
  );

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

  return NextResponse.json(buildListResponse(items, total, query));
}

/**
 * POST /api/administrator/organizations/:id/members
 *
 * Adds a new membership for a user to this organization.
 *
 * Body:
 *   - appUserId: uuid
 *   - status: membership status (defaults to "active")
 *
 * Caller MUST hold `admin.orgs.update`.
 */
const createMemberSchema = z
  .object({
    appUserId: z.string().uuid(),
    status: z.enum(["active", "pending_approval", "blocked", "suspended"]).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createMemberSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const user = await db
    .selectFrom("app_users")
    .select(["id"])
    .where("id", "=", input.appUserId)
    .executeTakeFirst();
  if (!user) {
    return adminErrorResponse("user_not_found", 404, request);
  }

  let inserted: { id: string };
  try {
    inserted = await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: id,
        app_user_id: input.appUserId,
        status: input.status ?? "active",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("membership_exists", 409, request);
    }
    throw err;
  }

  await Promise.all([
    auditOrgAction("admin.organization.member_added", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      metadata: {
        organizationId: id,
        slug: org.slug,
        appUserId: input.appUserId,
        membershipId: inserted.id,
      },
    }),
    auditUserAction("admin.user.membership_added", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: input.appUserId,
      metadata: {
        organizationId: id,
        slug: org.slug,
        appUserId: input.appUserId,
        membershipId: inserted.id,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, id: inserted.id }, { status: 201 });
}

/**
 * PATCH /api/administrator/organizations/:id/members
 *
 * Updates one or more existing memberships by membership id.
 *
 * Body:
 *   - membershipIds: string[]
 *   - status: new membership status
 *
 * Caller MUST hold `admin.orgs.update`.
 */
const patchMembersSchema = z
  .object({
    membershipIds: z.array(z.string().uuid()).min(1),
    status: z.enum(["active", "pending_approval", "blocked", "suspended"]),
  })
  .strict();

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = patchMembersSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const memberships = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "app_user_id"])
    .where("organization_id", "=", id)
    .where("id", "in", input.membershipIds)
    .execute();
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }

  await db
    .updateTable("app_organization_memberships")
    .set({ status: input.status })
    .where("id", "in", input.membershipIds)
    .where("organization_id", "=", id)
    .execute();

  const auditPromises = [
    auditOrgAction("admin.organization.member_updated", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      metadata: {
        organizationId: id,
        slug: org.slug,
        membershipIds: input.membershipIds,
        status: input.status,
      },
    }),
    ...memberships.map((m) =>
      auditUserAction("admin.user.membership_updated", "success", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: m.app_user_id,
        metadata: { organizationId: id, slug: org.slug, membershipId: m.id, status: input.status },
      }),
    ),
  ];
  await Promise.all(auditPromises);

  return NextResponse.json({ ok: true, updated: memberships.length });
}

/**
 * DELETE /api/administrator/organizations/:id/members
 *
 * Removes one or more memberships by membership id.
 *
 * Body:
 *   - membershipIds: string[]
 *
 * Caller MUST hold `admin.orgs.update`.
 */
const deleteMembersSchema = z
  .object({
    membershipIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = deleteMembersSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const memberships = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "app_user_id"])
    .where("organization_id", "=", id)
    .where("id", "in", input.membershipIds)
    .execute();
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }

  await db
    .deleteFrom("app_organization_memberships")
    .where("id", "in", input.membershipIds)
    .where("organization_id", "=", id)
    .execute();

  const auditPromises = [
    auditOrgAction("admin.organization.members_removed", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      metadata: { organizationId: id, slug: org.slug, membershipIds: input.membershipIds },
    }),
    ...memberships.map((m) =>
      auditUserAction("admin.user.membership_removed", "success", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        appUserId: m.app_user_id,
        metadata: { organizationId: id, slug: org.slug, membershipId: m.id },
      }),
    ),
  ];
  await Promise.all(auditPromises);

  return NextResponse.json({ ok: true, removed: memberships.length });
}
