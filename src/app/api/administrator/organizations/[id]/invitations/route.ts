import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { buildInvitationAcceptUrl, createInvitation } from "@/lib/invitations.server";
import { createInvitationSchema } from "@/lib/validation/invitations";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function loadScopedOrg(
  request: NextRequest,
  context: RouteContext,
  guard: { access: Parameters<typeof canAccessOrg>[0] },
): Promise<{ id: string; slug: string; name: string } | NextResponse> {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }
  const org = await db
    .selectFrom("app_organizations")
    .select(["id", "slug", "name"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  // ADR-0001: org admins are confined to their own org; 404 (not 403) so a
  // foreign org's existence is not confirmed. SUPERADMIN bypasses.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  return org;
}

/**
 * GET /api/administrator/organizations/:id/invitations
 *
 * Paginated invitations for this organization. Filters: `status`
 * (pending/accepted/revoked/expired). `q` searches the invitee email.
 * Token hashes are never returned.
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const org = await loadScopedOrg(request, context, guard);
  if (org instanceof NextResponse) return org;

  const query = parseListQuery(request.nextUrl.searchParams, {
    allowedSortFields: ["status", "email", "created_at", "expires_at"],
    allowedFilters: ["status"],
    defaultSort: [{ field: "created_at", direction: "desc" }],
    defaultPageSize: 25,
    maxPageSize: 200,
  });

  let base = db
    .selectFrom("app_organization_invitations as i")
    .leftJoin("app_roles as r", "r.id", "i.role_id")
    .leftJoin("app_users as u", "u.id", "i.invited_by")
    .where("i.organization_id", "=", org.id);

  // `expired` is a derived status, not a stored one: a `pending` row past
  // `expires_at` is dead (findValidInvitationByToken/consume reject it) but
  // the column still reads `pending`. Compute the effective status so the
  // grid badge and the `status` filter tell the truth.
  const statusFilter = query.filters.status;
  if (statusFilter === "expired") {
    base = base.where("i.status", "=", "pending").where("i.expires_at", "<=", sql<Date>`now()`);
  } else if (statusFilter === "pending") {
    base = base.where("i.status", "=", "pending").where("i.expires_at", ">", sql<Date>`now()`);
  } else if (typeof statusFilter === "string" && statusFilter.length > 0) {
    base = base.where("i.status", "=", statusFilter);
  }
  if (query.q) {
    base = base.where("i.email", "ilike", `%${query.q}%`);
  }

  const itemsQuery = applySortAndPagination(
    base.select((eb) => [
      "i.id",
      "i.email",
      eb
        .case()
        .when(eb.and([eb("i.status", "=", "pending"), eb("i.expires_at", "<=", sql<Date>`now()`)]))
        .then(sql.lit("expired"))
        .else(eb.ref("i.status"))
        .end()
        .as("status"),
      "i.role_id",
      "r.name as role_name",
      "u.display_name as invited_by_display_name",
      "i.expires_at",
      "i.accepted_at",
      "i.created_at",
      "i.updated_at",
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
 * POST /api/administrator/organizations/:id/invitations
 *
 * Invites an email address into the organization (optionally with a role
 * belonging to it) and sends the accept link through the outbox. 409
 * `member_exists` when the address already belongs to an ACTIVE member;
 * 409 `invitation_exists` when a pending invitation is already out.
 *
 * Caller MUST hold `admin.orgs.update`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.invitations",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const org = await loadScopedOrg(request, context, guard);
  if (org instanceof NextResponse) return org;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = createInvitationSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const email = parsed.data.email.trim().toLowerCase();

  // The optional role must belong to THIS org — never a cross-org grant.
  if (parsed.data.roleId) {
    const role = await db
      .selectFrom("app_roles")
      .select(["id"])
      .where("id", "=", parsed.data.roleId)
      .where("organization_id", "=", org.id)
      .executeTakeFirst();
    if (!role) {
      return adminErrorResponse("role_not_found", 404, request);
    }
  }

  // Already an active member? Inviting again is a no-op the admin should
  // see as a conflict (a PENDING member may legitimately be re-invited —
  // acceptance is what activates them).
  const activeMember = await db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_users as u", "u.id", "m.app_user_id")
    .select(["m.id"])
    .where("m.organization_id", "=", org.id)
    .where("m.status", "=", "active")
    .where(sql`lower(u.primary_email)`, "=", email)
    .executeTakeFirst();
  if (activeMember) {
    return adminErrorResponse("member_exists", 409, request);
  }

  let created: { id: string; plaintextToken: string; expiresAt: Date };
  try {
    created = await createInvitation({
      organizationId: org.id,
      email,
      roleId: parsed.data.roleId ?? null,
      invitedByAppUserId: guard.access.appUserId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("invitation_exists", 409, request);
    }
    throw err;
  }

  // Outbox-first delivery (specs.md §35): the accept link exists only in
  // this email; the DB holds the token's hash. Inviter display name falls
  // back to their email so the template never renders blank.
  const inviter = await db
    .selectFrom("app_users")
    .select(["display_name", "primary_email"])
    .where("id", "=", guard.access.appUserId ?? "")
    .executeTakeFirst();
  const { sendAppEmail } = await import("@/lib/email/send.server");
  await sendAppEmail({
    to: email,
    templateKey: "organization_invitation",
    variables: {
      inviterName: inviter?.display_name || inviter?.primary_email || "An administrator",
      organizationName: org.name,
      acceptUrl: buildInvitationAcceptUrl(created.plaintextToken),
    },
  });

  await auditOrgAction("admin.organization.invitation_created", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: org.id,
    requestId: guard.requestId,
    metadata: {
      organizationId: org.id,
      slug: org.slug,
      invitationId: created.id,
      email,
      roleId: parsed.data.roleId ?? null,
    },
  });

  return NextResponse.json(
    { ok: true, id: created.id, expiresAt: created.expiresAt.toISOString() },
    { status: 201 },
  );
}
