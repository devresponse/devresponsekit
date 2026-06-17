import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/db/database";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin } from "@/lib/admin/access-scope.server";
import { permissionKeysForRoles, unheldPermissionKeys } from "@/lib/admin/grantable-permissions.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/administrator/roles/[id]/duplicate
 *
 * Server-side clone of a role. In a single Kysely transaction:
 *   1. Insert a new `app_roles` row with the source's organization,
 *      name, and description. The `key` is suffixed with `-copy` and
 *      de-duplicated (e.g. `admin-copy`, `admin-copy-2`, ...) so the
 *      `(organization_id, key)` unique constraint never trips.
 *   2. Copy every `app_role_permissions` entry from the source.
 *
 * Caller MUST hold `admin.roles.create`. Audited as
 * `admin.role.duplicated` with the `sourceRoleId` in metadata so ops
 * can distinguish manual creates from duplicates.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.create");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.duplicate",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const source = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key", "name", "description"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!source) {
    return adminErrorResponse("not_found", 404, request);
  }
  // ADR-0001: an org admin may only duplicate a role owned by their org —
  // never a global role (which would clone a SUPERADMIN-scoped role into a
  // tenant). 404 to avoid confirming a foreign/global role exists.
  if (!canAccessOrg(guard.access, source.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  // Privilege-escalation guard (AUTHZ-3): a non-SUPERADMIN may duplicate a
  // role only when its permissions are a subset of their own — otherwise the
  // clone would hand them an editable role carrying authority they lack
  // (including a `superuser`-bearing role), which they could then assign.
  if (!isSuperadmin(guard.access)) {
    const conferred = await permissionKeysForRoles([source.id]);
    const unheld = unheldPermissionKeys(guard.access.permissions, conferred);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  // Compute a unique key suffix. We collect all candidate "starts-with"
  // matches in ONE query to avoid a loop of `select exists` round-trips.
  const candidates = await db
    .selectFrom("app_roles")
    .select(["key"])
    .where("organization_id", source.organization_id === null ? "is" : "=", source.organization_id)
    .where("key", "like", `${source.key}-copy%`)
    .execute();
  const taken = new Set(candidates.map((c) => c.key));
  let candidate = `${source.key}-copy`;
  if (taken.has(candidate)) {
    let i = 2;
    while (taken.has(`${source.key}-copy-${i}`)) i++;
    candidate = `${source.key}-copy-${i}`;
  }
  // Hard cap on key length per the create-schema contract (120). If the
  // suffixed candidate is too long, refuse rather than silently mutate.
  if (candidate.length > 120) {
    return adminErrorResponse("key_taken", 409, request);
  }

  const created = await db.transaction().execute(async (trx) => {
    const newRole = await trx
      .insertInto("app_roles")
      .values({
        organization_id: source.organization_id,
        key: candidate,
        name: source.name,
        description: source.description,
      })
      .returning(["id", "key"])
      .executeTakeFirstOrThrow();

    // Copy permissions in one INSERT … SELECT.
    await trx
      .insertInto("app_role_permissions")
      .columns(["role_id", "permission_id"])
      .expression((eb) =>
        eb
          .selectFrom("app_role_permissions")
          .select([sql.lit(newRole.id).as("role_id"), "permission_id"])
          .where("role_id", "=", source.id),
      )
      .execute();

    return newRole;
  });

  await auditRoleAction("admin.role.duplicated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: source.organization_id,
    metadata: {
      sourceRoleId: source.id,
      sourceKey: source.key,
      roleId: created.id,
      key: created.key,
    },
  });

  return NextResponse.json({ ok: true, id: created.id, key: created.key }, { status: 201 });
}
