import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction, auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  likeContains,
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  parseListQuery,
  windowTotalColumn,
} from "@/lib/admin/list-query.server";
import { MAX_BULK_IDS } from "@/lib/admin/bulk-limits";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  canAccessOrg,
  wouldStripLastGlobalSuperuser,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  LAST_SUPERADMIN_STATUS,
  type AccessLike,
} from "@/lib/admin/access-scope.server";
import { isUuid, refuseOutrankingTarget } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * One membership row this route is about to mutate, joined with enough of its
 * `app_users` row to run the review #7 rank guard on the member it belongs to.
 */
interface ScopedMemberRow {
  id: string;
  app_user_id: string;
  better_auth_user_id: string;
  primary_email: string;
  display_name: string | null;
  status: string;
}

/**
 * Resolve the membership ids named in the body, confined to THIS organization,
 * carrying the target-user columns the rank guard needs. Shared by PATCH and
 * DELETE so the two cannot drift.
 */
async function loadScopedMembers(
  organizationId: string,
  membershipIds: ReadonlyArray<string>,
): Promise<ScopedMemberRow[]> {
  return db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_users as u", "u.id", "m.app_user_id")
    .select([
      "m.id as id",
      "m.app_user_id as app_user_id",
      "u.better_auth_user_id as better_auth_user_id",
      "u.primary_email as primary_email",
      "u.display_name as display_name",
      "u.status as status",
    ])
    .where("m.organization_id", "=", organizationId)
    .where("m.id", "in", [...membershipIds])
    .execute();
}

/**
 * REVOKE-1 (rank): refuse the WHOLE batch when any member it names outranks
 * the actor (review #7).
 *
 * This route is ORG-CENTRIC — it never calls `resolveTargetUser`, so it was the
 * one place where `admin.orgs.update` alone let an org admin block, suspend or
 * delete the membership of a SUPERADMIN co-member, which the user-centric twin
 * (and every other account-level action) refuses. The batch is denied whole
 * rather than partially applied: a caller who mixes an ordinary member with a
 * superadmin gets one unambiguous 403 and no half-done mutation.
 *
 * `refuseOutrankingTarget` costs a `getUserAccessContext` round-trip per
 * DISTINCT member, and a SUPERADMIN cookie actor short-circuits before any of
 * them — so the cost is paid only by the delegated admins this guard exists for.
 * The loop is SEQUENTIAL on purpose: it stops at the first refusal, so a mixed
 * batch writes ONE `admin.user.action_denied` audit row rather than one per
 * member. Both body schemas therefore cap `membershipIds` at `MAX_BULK_IDS` —
 * see the note there — so the fan-out is bounded.
 */
async function refuseOutrankedMembers(
  guard: { access: AccessLike; betterAuthUserId: string; requestId?: string },
  members: ReadonlyArray<ScopedMemberRow>,
  request: NextRequest,
  action: string,
): Promise<NextResponse | null> {
  const checked = new Set<string>();
  for (const member of members) {
    if (checked.has(member.app_user_id)) continue;
    checked.add(member.app_user_id);
    const refused = await refuseOutrankingTarget(
      guard,
      {
        appUserId: member.app_user_id,
        betterAuthUserId: member.better_auth_user_id,
        primaryEmail: member.primary_email,
        displayName: member.display_name,
        status: member.status,
      },
      request,
      action,
    );
    if (refused) return refused;
  }
  return null;
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
    const like = likeContains(query.q);
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

  const limited = enforceRateLimit(
    "admin.orgs.members",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

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

  // Intentional asymmetry with users/[id]/memberships (audit #23): that route
  // is user-centric and gates on canAccessUser; this one is ORG-CENTRIC. The
  // actor holds admin.orgs.update AND canAccessOrg(this org) — i.e. they
  // administer the target org — so enrolling a member is a core org-management
  // capability and is deliberately NOT gated on separately "seeing" the user.
  // Consent-based self-enrollment for brand-new users goes through invitations;
  // this direct-add is the admin counterpart. Membership only ever grants
  // access to an org the actor already controls, and the target UUID is
  // unguessable, so there is no cross-tenant or enumeration exposure.
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
/**
 * `membershipIds` is capped at {@link MAX_BULK_IDS} — the same ceiling
 * `POST /users/bulk` and the group sub-resources use — because REVOKE-1's
 * `refuseOutrankedMembers` costs a `getUserAccessContext` per DISTINCT member
 * and runs them one at a time. Uncapped, a single rate-limited request from a
 * delegated admin could turn into thousands of sequential round-trips holding
 * one pool connection for the whole batch. (The console only ever sends one id.)
 */
const patchMembersSchema = z
  .object({
    membershipIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_IDS),
    status: z.enum(["active", "pending_approval", "blocked", "suspended"]),
  })
  .strict();

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.members",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

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

  const memberships = await loadScopedMembers(id, input.membershipIds);
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }

  const outranked = await refuseOutrankedMembers(guard, memberships, request, "member_update");
  if (outranked) return outranked;

  // REVOKE-2: a move away from `active` breaks the active-membership join that
  // makes a superuser assignment count. Reactivation can only ever ADD a grant,
  // so it is never gated.
  const outcome = await db.transaction().execute(async (trx) => {
    if (
      input.status !== "active" &&
      (await wouldStripLastGlobalSuperuser(
        {
          memberships: memberships.map((m) => ({
            appUserId: m.app_user_id,
            organizationId: id,
          })),
        },
        trx,
      ))
    ) {
      return "last_superadmin" as const;
    }
    await trx
      .updateTable("app_organization_memberships")
      .set({ status: input.status })
      .where("id", "in", input.membershipIds)
      .where("organization_id", "=", id)
      .execute();
    return "updated" as const;
  });

  if (outcome === "last_superadmin") {
    await auditOrgAction(LAST_SUPERADMIN_EVENT, "denied", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      requestId: guard.requestId,
      reason: LAST_SUPERADMIN_REASON,
      metadata: {
        action: "member_update",
        organizationId: id,
        slug: org.slug,
        membershipIds: memberships.map((m) => m.id),
        status: input.status,
      },
    });
    return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
      requestId: guard.requestId,
    });
  }

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
/** Same cap as {@link patchMembersSchema}, for the same reason. */
const deleteMembersSchema = z
  .object({
    membershipIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_IDS),
  })
  .strict();

export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.members",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

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

  const memberships = await loadScopedMembers(id, input.membershipIds);
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }

  const outranked = await refuseOutrankedMembers(guard, memberships, request, "member_remove");
  if (outranked) return outranked;

  // REVOKE-2: deleting the membership removes the ACTIVE row every superuser
  // grant in this org hangs off, so it is checked unconditionally.
  const outcome = await db.transaction().execute(async (trx) => {
    const stripsLast = await wouldStripLastGlobalSuperuser(
      {
        memberships: memberships.map((m) => ({ appUserId: m.app_user_id, organizationId: id })),
      },
      trx,
    );
    if (stripsLast) return "last_superadmin" as const;
    await trx
      .deleteFrom("app_organization_memberships")
      .where("id", "in", input.membershipIds)
      .where("organization_id", "=", id)
      .execute();
    return "removed" as const;
  });

  if (outcome === "last_superadmin") {
    await auditOrgAction(LAST_SUPERADMIN_EVENT, "denied", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      organizationId: id,
      requestId: guard.requestId,
      reason: LAST_SUPERADMIN_REASON,
      metadata: {
        action: "member_remove",
        organizationId: id,
        slug: org.slug,
        membershipIds: memberships.map((m) => m.id),
      },
    });
    return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
      requestId: guard.requestId,
    });
  }

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
