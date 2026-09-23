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
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import {
  canAccessOrg,
  isSuperadmin,
  resolveOrgScope,
  wouldStripLastGlobalSuperuser,
  LAST_SUPERADMIN_ERROR,
  LAST_SUPERADMIN_EVENT,
  LAST_SUPERADMIN_REASON,
  LAST_SUPERADMIN_STATUS,
} from "@/lib/admin/access-scope.server";
import {
  conferrablePermissions,
  permissionKeysForGroups,
  permissionKeysForRoles,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import {
  auditRemovedMembershipGrants,
  grantIdsRemovedWith,
  MembershipGrantsRefusal,
  MEMBERSHIP_REVOCATION_DENIED_EVENT,
  MEMBERSHIP_REVOCATION_DENIED_REASON,
  unheldOnMembershipRemoval,
} from "@/lib/admin/membership-grants.server";
import {
  isResolvedUserResponse,
  refuseOutrankingTarget,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

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

  // ADR-0001: an org admin sees only this user's memberships in their own
  // org, never the user's footprint in other tenants. SUPERADMIN: all.
  const scope = resolveOrgScope(guard.access);
  if (scope?.kind === "org") {
    base = base.where("m.organization_id", "=", scope.organizationId);
  }

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

  const { items, total } = await executeListWithTotal(
    itemsQuery.select(windowTotalColumn()),
    base.select(sql<string>`count(*)`.as("total")),
    query,
  );

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

  const limited = enforceRateLimit(
    "admin.users.memberships",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

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
  // ADR-0001: an org admin may only enroll a user into their OWN org.
  if (!canAccessOrg(guard.access, input.organizationId)) {
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

  const limited = enforceRateLimit(
    "admin.users.memberships",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // REVOKE-1 (rank): a membership status change is a LOCKOUT primitive — the
  // active-membership join in `userIsGlobalSuperuser`, and `decideSecureAccess`
  // itself, both hang off it — yet these two verbs carried no review #7 rank
  // guard, unlike ban / unban / soft-delete / restore / status / sessions /
  // password next door. Without it an org admin holding `admin.users.update`
  // could suspend or block a SUPERADMIN co-member they cannot ban, soft-delete
  // or set a password for, and take the platform down that way instead. Same
  // ordering as every sibling: straight after `resolveTargetUser`, before the
  // body is even read.
  const outranked = await refuseOutrankingTarget(guard, target, request, "membership_update");
  if (outranked) return outranked;

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

  let membershipQuery = db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["m.id", "m.organization_id", "o.slug"])
    .where("m.app_user_id", "=", target.appUserId)
    .where("m.id", "in", input.membershipIds);
  // ADR-0001: confine the mutation to memberships in the actor's org. A
  // foreign-org membership id is simply not found (404), and only the
  // resolved ids are mutated below — never the raw request list.
  const mScope = resolveOrgScope(guard.access);
  if (mScope?.kind === "org") {
    membershipQuery = membershipQuery.where("m.organization_id", "=", mScope.organizationId);
  }
  const memberships = await membershipQuery.execute();
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }
  const allowedMembershipIds = memberships.map((m) => m.id);

  // REVOKE-2: only a move AWAY from `active` can destroy a superuser grant —
  // reactivating a membership can only ever create one, so it is never gated
  // (blocking it would strand the very admin who could fix the platform).
  const outcome = await db.transaction().execute(async (trx) => {
    if (
      input.status !== "active" &&
      (await wouldStripLastGlobalSuperuser(
        {
          memberships: memberships.map((m) => ({
            appUserId: target.appUserId,
            organizationId: m.organization_id,
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
      .where("app_user_id", "=", target.appUserId)
      .where("id", "in", allowedMembershipIds)
      .execute();
    return "updated" as const;
  });

  if (outcome === "last_superadmin") {
    await auditUserAction(LAST_SUPERADMIN_EVENT, "denied", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: LAST_SUPERADMIN_REASON,
      metadata: {
        action: "membership_update",
        membershipIds: allowedMembershipIds,
        status: input.status,
      },
    });
    return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
      requestId: guard.requestId,
    });
  }

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
 * Removes one or more memberships for this user, and with each one the user's
 * grants in that org: their direct role assignments there and their
 * memberships in its groups (F-12). A non-SUPERADMIN may only remove grants
 * they could have conferred (REVOKE-1: 403 `forbidden`, nothing removed).
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

  const limited = enforceRateLimit(
    "admin.users.memberships",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // REVOKE-1 (rank): removing a membership is the strongest lockout primitive
  // on this route — it revokes every role the target held in that org along
  // with the membership row (since F-12 it deletes those rows too; before, it
  // only stopped them counting until the user was re-added). See the PATCH
  // twin above for why review #7 has to reach here.
  const outranked = await refuseOutrankingTarget(guard, target, request, "membership_remove");
  if (outranked) return outranked;

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

  let membershipQuery = db
    .selectFrom("app_organization_memberships as m")
    .innerJoin("app_organizations as o", "o.id", "m.organization_id")
    .select(["m.id", "m.organization_id", "o.slug"])
    .where("m.app_user_id", "=", target.appUserId)
    .where("m.id", "in", input.membershipIds);
  // ADR-0001: confine the mutation to memberships in the actor's org. A
  // foreign-org membership id is simply not found (404), and only the
  // resolved ids are mutated below — never the raw request list.
  const mScope = resolveOrgScope(guard.access);
  if (mScope?.kind === "org") {
    membershipQuery = membershipQuery.where("m.organization_id", "=", mScope.organizationId);
  }
  const memberships = await membershipQuery.execute();
  if (memberships.length === 0) {
    return adminErrorResponse("membership_not_found", 404, request);
  }
  const allowedMembershipIds = memberships.map((m) => m.id);
  const organizationIds = memberships.map((m) => m.organization_id);

  const outcome = await db
    .transaction()
    .execute(async (trx) => {
      // REVOKE-2: deleting the membership removes the ACTIVE row the superuser
      // grant hangs off, so it is checked unconditionally (unlike PATCH, which
      // only matters on a move away from `active`). It must read the grants
      // BEFORE the deletes below: afterwards the assignment rows are gone and
      // it would see nothing left to protect.
      const stripsLast = await wouldStripLastGlobalSuperuser(
        {
          memberships: memberships.map((m) => ({
            appUserId: target.appUserId,
            organizationId: m.organization_id,
          })),
        },
        trx,
      );
      if (stripsLast) return { kind: "last_superadmin" } as const;

      // F-12: the user's grants IN THOSE ORGS leave with the memberships —
      // their direct role assignments there and their memberships in those
      // orgs' groups. Left behind, they sat dormant and came back, `superuser`
      // included, the moment anyone re-added or re-invited the user, with no
      // conferral check and no audit row. Grants in any other org stay.
      const roles = await trx
        .deleteFrom("app_user_roles")
        .using("app_roles")
        .whereRef("app_roles.id", "=", "app_user_roles.role_id")
        .where("app_user_roles.app_user_id", "=", target.appUserId)
        .where("app_user_roles.organization_id", "in", organizationIds)
        .returning([
          "app_user_roles.app_user_id as app_user_id",
          "app_user_roles.organization_id as organization_id",
          "app_user_roles.role_id as role_id",
          "app_roles.key as role_key",
        ])
        .execute();
      const groups = await trx
        .deleteFrom("app_group_memberships")
        .using("app_groups")
        .whereRef("app_groups.id", "=", "app_group_memberships.group_id")
        .where("app_group_memberships.app_user_id", "=", target.appUserId)
        .where("app_groups.organization_id", "in", organizationIds)
        .returning([
          "app_group_memberships.app_user_id as app_user_id",
          "app_group_memberships.group_id as group_id",
          "app_groups.key as group_key",
          "app_groups.organization_id as organization_id",
        ])
        .execute();

      // REVOKE-1 (conferral symmetry), F-12: removing those grants is a
      // revocation, so it takes the AUTHZ-3 subset test the role and group
      // routes apply when they remove the same rows one at a time. For a
      // cookie org admin it refuses what the rank guard above already
      // refuses; what it adds is the P1-1 bound. The rank guard measures the
      // member against the actor's HELD permissions and exempts any superuser
      // principal, so a superuser-owned key scoped only to this route's
      // permission passes it, and without this test would strip an org
      // admin's roles. A bearer credential may only take away what its scopes
      // let it confer, and never takes the SUPERADMIN fast-path. Measured on
      // EXACTLY the rows just deleted, so nothing is removed unchecked.
      // `unheldOnMembershipRemoval` then drops `shell.view`, which the
      // membership itself implies, and bounds a key no scope can name by the
      // key owner's authority instead of the scopes. Without it no bearer
      // credential could remove a member holding any ordinary role.
      // Thrown, not returned, so the deletes above roll back with the refusal.
      if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
        const conferred = [
          ...(await permissionKeysForRoles(
            roles.map((r) => r.role_id),
            trx,
          )),
          ...(await permissionKeysForGroups(
            groups.map((g) => g.group_id),
            trx,
          )),
        ];
        const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
        const unheld = unheldOnMembershipRemoval(
          unheldPermissionKeys(conferrable, conferred),
          guard.access,
          guard.grantedScopes,
        );
        if (unheld.length > 0) throw new MembershipGrantsRefusal(unheld);
      }

      await trx
        .deleteFrom("app_organization_memberships")
        .where("app_user_id", "=", target.appUserId)
        .where("id", "in", allowedMembershipIds)
        .execute();
      return { kind: "removed", roles, groups } as const;
    })
    .catch((err: unknown) => {
      if (err instanceof MembershipGrantsRefusal) {
        return { kind: "unheld", unheld: err.unheldPermissions } as const;
      }
      throw err;
    });

  if (outcome.kind === "unheld") {
    await auditUserAction(MEMBERSHIP_REVOCATION_DENIED_EVENT, "denied", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: MEMBERSHIP_REVOCATION_DENIED_REASON,
      metadata: {
        action: "membership_remove",
        membershipIds: allowedMembershipIds,
        unheldPermissions: outcome.unheld,
      },
    });
    return adminErrorResponse("forbidden", 403, request, { requestId: guard.requestId });
  }

  if (outcome.kind === "last_superadmin") {
    await auditUserAction(LAST_SUPERADMIN_EVENT, "denied", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      email: target.primaryEmail,
      requestId: guard.requestId,
      reason: LAST_SUPERADMIN_REASON,
      metadata: { action: "membership_remove", membershipIds: allowedMembershipIds },
    });
    return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  const { roles, groups } = outcome;
  const auditPromises = [
    auditUserAction("admin.user.membership_removed", "success", {
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      appUserId: target.appUserId,
      metadata: {
        membershipIds: input.membershipIds,
        revokedRoleIds: roles.map((r) => r.role_id),
        removedGroupIds: groups.map((g) => g.group_id),
      },
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
          ...grantIdsRemovedWith(target.appUserId, m.organization_id, roles, groups),
        },
      }),
    ),
    // F-12: each removed grant is also recorded as its own revocation.
    ...auditRemovedMembershipGrants({
      request,
      actorBetterAuthUserId: guard.betterAuthUserId,
      requestId: guard.requestId,
      roles,
      groups,
    }),
  ];
  await Promise.all(auditPromises);

  return NextResponse.json({ ok: true, removed: memberships.length });
}
