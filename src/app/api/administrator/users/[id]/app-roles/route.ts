import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
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
  permissionKeysForRoles,
  conferrablePermissions,
  unheldPermissionKeys,
} from "@/lib/admin/grantable-permissions.server";
import { isResolvedUserResponse, resolveTargetUser } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/administrator/users/[id]/app-roles
 *
 * Returns the application-role assignments carried by the target
 * user (the User detail "Roles" tab from §8.1 consumes this). Each
 * row is one `app_user_roles` entry joined with the role + org so
 * the UI doesn't need a second round-trip per row.
 *
 * Caller MUST hold `admin.roles.assign` (the perm consistent with the
 * mutating verbs on the same endpoint).
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id, guard.access);
  if (isResolvedUserResponse(target)) return target;

  // ADR-0001: an org admin sees only this user's assignments in their own org
  // — never the user's role footprint in other tenants (the sibling /roles
  // route is scoped the same way). SUPERADMIN: all orgs.
  const scope = resolveOrgScope(guard.access);
  if (!scope) return NextResponse.json({ assignments: [] });

  let query = db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_roles as r", "r.id", "ur.role_id")
    .leftJoin("app_organizations as o", "o.id", "ur.organization_id")
    .where("ur.app_user_id", "=", target.appUserId);
  if (scope.kind === "org") {
    query = query.where("ur.organization_id", "=", scope.organizationId);
  }

  const rows = await query
    .select([
      "r.id as role_id",
      "r.key as role_key",
      "r.name as role_name",
      "ur.organization_id as organization_id",
      "o.name as organization_name",
      "ur.created_at as created_at",
    ])
    .orderBy("r.key", "asc")
    .execute();

  return NextResponse.json({ assignments: rows });
}

/**
 * POST /api/administrator/users/[id]/app-roles
 *
 * Assigns a role to the target user inside an organization. Body:
 *   `{ roleId: string, organizationId: string }`
 *
 * Both ids are UUIDs and BOTH are required: `app_user_roles` is keyed
 * by `(app_user_id, organization_id, role_id)` so an assignment
 * without an org context is meaningless. Idempotent (`on conflict do
 * nothing`).
 *
 * Caller MUST hold `admin.roles.assign`.
 */
const assignSchema = z
  .object({
    roleId: z.string().regex(UUID_RE),
    organizationId: z.string().regex(UUID_RE),
  })
  .strict();

export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.approles",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
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
  const parsed = assignSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  // Validate role + org existence up front so the FK violation surfaces
  // as a clean 404 rather than a 500.
  const role = await db
    .selectFrom("app_roles")
    .select(["id", "key", "organization_id"])
    .where("id", "=", parsed.data.roleId)
    .executeTakeFirst();
  if (!role) return adminErrorResponse("role_not_found", 404, request);

  const org = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", parsed.data.organizationId)
    .executeTakeFirst();
  if (!org) return adminErrorResponse("organization_not_found", 404, request);

  // ADR-0001: an org admin may only assign WITHIN their org and may only
  // use a role belonging to their org (404, not 403, to avoid confirming a
  // foreign org/role exists). SUPERADMIN bypasses both.
  if (!canAccessOrg(guard.access, parsed.data.organizationId)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  if (!canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("role_not_found", 404, request);
  }
  // Review #218: an org-scoped role may only be assigned INSIDE its own org —
  // for EVERY caller. The scope checks above let a SUPERADMIN (who can access
  // every org) pair an org-B role with an org-A membership; that row is now
  // unrepresentable (composite FK + trigger in migration 0005), so refuse it
  // here with a specific 409 instead of surfacing the DB error. A global role
  // (organization_id null) is assignable in any org.
  if (role.organization_id !== null && role.organization_id !== parsed.data.organizationId) {
    return adminErrorResponse("role_organization_mismatch", 409, request);
  }
  // Privilege-escalation guard (AUTHZ-3): a non-SUPERADMIN may assign only a
  // role whose conferred permissions are a subset of their own — otherwise
  // they could grant a user (including themselves) authority they lack. This
  // subsumes the old `superuser`-marker-only check.
  // A bearer credential is bounded by its scopes, not just its owner's
  // permissions, and never takes the SUPERADMIN fast-path (P1-1).
  if (!(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferred = await permissionKeysForRoles([role.id]);
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, conferred);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("app_user_roles")
      .values({
        app_user_id: target.appUserId,
        organization_id: parsed.data.organizationId,
        role_id: parsed.data.roleId,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  });

  await auditUserAction("admin.user.role_assigned", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: {
      roleId: role.id,
      roleKey: role.key,
      organizationId: parsed.data.organizationId,
    },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}

/**
 * DELETE /api/administrator/users/[id]/app-roles
 *
 * Revokes a role assignment. Body has the same shape as POST. No-op
 * (and 200) when the row already does not exist so the editor's
 * "remove then redo" loop is idempotent.
 *
 * Caller MUST hold `admin.roles.assign`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.assign");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.users.approles",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
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
  const parsed = assignSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  // An org admin may only mutate assignments within their own org (404,
  // not 403, to avoid confirming a foreign org exists). SUPERADMIN bypasses.
  if (!canAccessOrg(guard.access, parsed.data.organizationId)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  // Pull the role's key for the audit row before deleting.
  const role = await db
    .selectFrom("app_roles")
    .select(["id", "key", "organization_id"])
    .where("id", "=", parsed.data.roleId)
    .executeTakeFirst();

  if (role && !canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("role_not_found", 404, request);
  }

  // REVOKE-1 (symmetry): the AUTHZ-3 conferral guard now bounds the REVOKE as
  // well as the grant. It was only ever applied to POST, which left the mirror
  // image wide open: an org admin holding `admin.roles.assign` could not GRANT
  // the seeded org-scoped `superuser` role, but could freely REVOKE it — and
  // could not confer it back afterwards, since AUTHZ-3 forbids conferring what
  // you do not hold. Revocation is a mutation of authority the actor does not
  // possess, so it takes the same test against the REMOVED set: a
  // non-SUPERADMIN may only revoke a role whose conferred permissions are a
  // subset of what they could themselves confer. A bearer credential is bounded
  // by its scopes and never takes the SUPERADMIN fast-path (P1-1), identically
  // to POST above. A role that no longer exists confers nothing and the delete
  // below is a no-op, so the guard has nothing to measure.
  if (role && !(isSuperadmin(guard.access) && guard.grantedScopes === null)) {
    const conferred = await permissionKeysForRoles([role.id]);
    const conferrable = conferrablePermissions(guard.access.permissions, guard.grantedScopes);
    const unheld = unheldPermissionKeys(conferrable, conferred);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  // REVOKE-2: a SUPERADMIN passes the guard above by construction, so this is
  // the only thing standing between "demote a co-superadmin" and "leave the
  // platform with none". The check runs INSIDE the deleting transaction and
  // takes a row lock on the superuser assignments (see
  // `activeGlobalSuperuserGrants`), so two concurrent revocations aimed at two
  // different superadmins cannot each believe the other survives.
  const outcome = await db.transaction().execute(async (trx) => {
    const stripsLast = await wouldStripLastGlobalSuperuser(
      {
        assignments: [
          {
            appUserId: target.appUserId,
            organizationId: parsed.data.organizationId,
            roleId: parsed.data.roleId,
          },
        ],
      },
      trx,
    );
    if (stripsLast) return "last_superadmin" as const;
    await trx
      .deleteFrom("app_user_roles")
      .where("app_user_id", "=", target.appUserId)
      .where("organization_id", "=", parsed.data.organizationId)
      .where("role_id", "=", parsed.data.roleId)
      .execute();
    return "revoked" as const;
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
        action: "role_revoke",
        roleId: parsed.data.roleId,
        roleKey: role?.key ?? null,
        organizationId: parsed.data.organizationId,
      },
    });
    return adminErrorResponse(LAST_SUPERADMIN_ERROR, LAST_SUPERADMIN_STATUS, request, {
      requestId: guard.requestId,
    });
  }

  await auditUserAction("admin.user.role_revoked", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    appUserId: target.appUserId,
    email: target.primaryEmail,
    metadata: {
      roleId: parsed.data.roleId,
      roleKey: role?.key ?? null,
      organizationId: parsed.data.organizationId,
    },
  });

  return NextResponse.json({ ok: true });
}
