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
  parseListQuery,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/users/:id/memberships
 *
 * Paginated list of memberships for a specific user.
 * Filters: `status`, `organization_id`.
 *
 * Caller MUST hold `admin.users.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: [
      "status",
      "created_at",
      "organization_slug",
      "organization_name",
      "source_provider",
    ],
    allowedFilters: ["status", "organization_id"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .where("m.app_user_id", "=", target.appUserId);

  const statusFilter = query.filters.status;
  if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("m.status", "=", statusFilter);
  }

  const orgIdFilter = query.filters.organization_id;
  if (typeof orgIdFilter === "string" && orgIdFilter.length > 0) {
    base = base.where("m.organization_id", "=", orgIdFilter);
  }

  const itemsQuery = applySortAndPagination(
    base.select([
      "m.id",
      "m.organization_id",
      "o.slug as organization_slug",
      "o.name as organization_name",
      "m.status",
      "m.source_provider",
      "m.provider_organization_key",
      "m.created_at",
      "m.updated_at",
    ]),
    query,
  );

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  const total = Number(totalRow?.total ?? 0);
  return NextResponse.json(buildListResponse(items, total, query));
}

/**
 * POST /api/administrator/users/:id/memberships
 *
 * Adds a membership for this user to an organization.
 *
 * Body:
 *   - organizationId: uuid
 *   - status: membership status (defaults to "active")
 *
 * Caller MUST hold `admin.users.update`.
 */
const createMembershipSchema = z
  .object({
    organizationId: z.string().uuid(),
    status: z.enum(["active", "pending_approval", "blocked", "suspended"]).optional(),
  })
  .strict();

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createMembershipSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", input.organizationId)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  let inserted: { id: string };
  try {
    inserted = await db
      .insertInto("app_organization_memberships")
      .values({
        organization_id: input.organizationId,
        app_user_id: target.appUserId,
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
    auditUserAction("admin.user.membership_added", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      metadata: {
        organizationId: org.id,
        slug: org.slug,
        appUserId: target.appUserId,
        membershipId: inserted.id,
      },
    }),
    auditOrgAction("admin.organization.member_added", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: org.id,
      metadata: {
        organizationId: org.id,
        slug: org.slug,
        appUserId: target.appUserId,
        membershipId: inserted.id,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, id: inserted.id }, { status: 201 });
}

/**
 * PATCH /api/administrator/users/:id/memberships
 *
 * Updates one or more memberships for this user.
 *
 * Body:
 *   - membershipIds: string[]
 *   - status: new membership status
 *
 * Caller MUST hold `admin.users.update`.
 */
const patchMembershipSchema = z
  .object({
    membershipIds: z.array(z.string().uuid()).min(1),
    status: z.enum(["active", "pending_approval", "blocked", "suspended"]),
  })
  .strict();

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = patchMembershipSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const memberships = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["m.id", "m.organization_id", "o.slug"])
    .where("m.app_user_id", "=", target.appUserId)
    .where("m.id", "in", input.membershipIds)
    .execute();
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }

  await db
    .updateTable("app_organization_memberships")
    .set({ status: input.status })
    .where("app_user_id", "=", target.appUserId)
    .where("id", "in", input.membershipIds)
    .execute();

  const auditPromises = [
    auditUserAction("admin.user.membership_updated", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      metadata: { membershipIds: input.membershipIds, status: input.status },
    }),
    ...memberships.map((m) =>
      auditOrgAction("admin.organization.member_updated", "success", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: m.organization_id,
        metadata: {
          organizationId: m.organization_id,
          slug: m.slug,
          appUserId: target.appUserId,
          membershipId: m.id,
          status: input.status,
        },
      }),
    ),
  ];
  await Promise.all(auditPromises);

  return NextResponse.json({ ok: true, updated: memberships.length });
}

/**
 * DELETE /api/administrator/users/:id/memberships
 *
 * Removes one or more memberships for this user.
 *
 * Body:
 *   - membershipIds: string[]
 *
 * Caller MUST hold `admin.users.update`.
 */
const deleteMembershipSchema = z
  .object({
    membershipIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.users.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = deleteMembershipSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const memberships = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["m.id", "m.organization_id", "o.slug"])
    .where("m.app_user_id", "=", target.appUserId)
    .where("m.id", "in", input.membershipIds)
    .execute();
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }

  await db
    .deleteFrom("app_organization_memberships")
    .where("app_user_id", "=", target.appUserId)
    .where("id", "in", input.membershipIds)
    .execute();

  const auditPromises = [
    auditUserAction("admin.user.membership_removed", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      metadata: { membershipIds: input.membershipIds },
    }),
    ...memberships.map((m) =>
      auditOrgAction("admin.organization.members_removed", "success", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: m.organization_id,
        metadata: {
          organizationId: m.organization_id,
          slug: m.slug,
          appUserId: target.appUserId,
          membershipId: m.id,
        },
      }),
    ),
  ];
  await Promise.all(auditPromises);

  return NextResponse.json({ ok: true, removed: memberships.length });
}
