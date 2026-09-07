import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  conferrablePermissions,
  permissionKeysForRoles,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { loadScopedOrg } from "@/lib/admin/org-route.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { createInvitation, sendInvitationEmail } from "@/lib/invitations.server";
import { createInvitationSchema } from "@/lib/validation/invitations";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
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

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
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
    base = base.where("i.email", "ilike", likeContains(query.q));
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
 * Attaching a role is a deferred role ASSIGNMENT, so it is bound by the same
 * privilege-escalation guard (AUTHZ-3) as `users/[id]/app-roles`: a
 * non-SUPERADMIN may only attach a role whose conferred permissions are a
 * subset of what they can confer themselves — 403 `forbidden` otherwise.
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

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
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
    // Privilege-escalation guard (AUTHZ-3, review #6): the invitee receives
    // this role on acceptance, so the inviter must be able to confer every
    // permission it carries — otherwise an org admin could invite their own
    // alternate mailbox with the seeded `superuser` role and mint a second,
    // global-superadmin account. Identical wiring to the sibling conferral
    // routes: a bearer credential is bounded by its scopes and never takes
    // the SUPERADMIN fast-path (P1-1). `consumeInvitation` re-checks against
    // the inviter's authority at accept time (defense in depth).
    if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
      const conferred = await permissionKeysForRoles([role.id]);
      const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
      const unheld = unheldPermissionKeys(conferrable, conferred);
      if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
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
  // this email; the DB holds the token's hash.
  await sendInvitationEmail({
    to: email,
    // ADR-0001 / review #220: the outbox row belongs to the inviting org, so
    // its admins can see the invitation in their own Email workspace.
    organizationId: org.id,
    organizationName: org.name,
    inviterAppUserId: guard.access.appUserId,
    plaintextToken: created.plaintextToken,
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
