import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction, auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  applySortAndPagination,
  buildListResponse,
  parseListQuery,
} from "@/lib/admin/list-query.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";
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
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const orgExists = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!orgExists) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["status", "created_at"],
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

  const [items, totalRow] = await Promise.all([
    itemsQuery.execute(),
    base.select(sql<string>`count(*)`.as("total")).executeTakeFirst(),
  ]);

  const total = Number(totalRow?.total ?? 0);
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
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = createMemberSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = parsed.data;

  const user = await db
    .selectFrom("app_users")
    .select(["id"])
    .where("id", "=", input.appUserId)
    .executeTakeFirst();
  if (!user) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
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
      return NextResponse.json({ error: "membership_exists" }, { status: 409 });
    }
    throw err;
  }

  await Promise.all([
    auditOrgAction("admin.organization.member_added", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      metadata: { organizationId: id, slug: org.slug, appUserId: input.appUserId, membershipId: inserted.id },
    }),
    auditUserAction("admin.user.membership_added", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: input.appUserId,
      metadata: { organizationId: id, slug: org.slug, appUserId: input.appUserId, membershipId: inserted.id },
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
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = patchMembersSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = parsed.data;

  const memberships = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "app_user_id"])
    .where("organization_id", "=", id)
    .where("id", "in", input.membershipIds)
    .execute();
  if (memberships.length === 0) {
    return NextResponse.json({ error: "membership_not_found" }, { status: 404 });
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
      metadata: { organizationId: id, slug: org.slug, membershipIds: input.membershipIds, status: input.status },
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
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return NextResponse.json({ error: "organization_not_found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = deleteMembersSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const input = parsed.data;

  const memberships = await db
    .selectFrom("app_organization_memberships")
    .select(["id", "app_user_id"])
    .where("organization_id", "=", id)
    .where("id", "in", input.membershipIds)
    .execute();
  if (memberships.length === 0) {
    return NextResponse.json({ error: "membership_not_found" }, { status: 404 });
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
