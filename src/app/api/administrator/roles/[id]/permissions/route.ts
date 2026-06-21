import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditRoleAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin } from "@/lib/admin/access-scope.server";
import { unheldPermissionKeys } from "@/lib/admin/grantable-permissions.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/administrator/roles/[id]/permissions
 *
 * Returns the permission keys currently attached to a role. Caller MUST
 * hold `admin.roles.read` (the canonical "read role detail"
 * permission). The shape `{ permissions: string[] }` matches what the
 * dual-list editor (§8.6) consumes.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const roleRow = await db
    .selectFrom("app_roles")
    .select(["id", "organization_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!roleRow || !canAccessOrg(guard.access, roleRow.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  const rows = await db
    .selectFrom("app_role_permissions as rp")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select(["p.key as key"])
    .where("rp.role_id", "=", id)
    .orderBy("p.key", "asc")
    .execute();

  return NextResponse.json({ permissions: rows.map((r) => r.key) });
}

/**
 * POST/DELETE body shared schema. The dual-list editor sends two
 * atomic mutations (one POST for `toAdd`, one DELETE for `toRemove`)
 * per the Phase-4 spec; both endpoints accept the same `{ ids }` body.
 *
 * `ids` are permission keys (not row UUIDs) — the editor works in the
 * domain language of "admin.users.read" rather than opaque ids.
 */
const idsSchema = z
  .object({
    ids: z.array(z.string().min(1).max(120)).min(1).max(500),
  })
  .strict();

async function loadRoleHeader(roleId: string) {
  return db
    .selectFrom("app_roles")
    .select(["id", "organization_id", "key"])
    .where("id", "=", roleId)
    .executeTakeFirst();
}

async function currentPermissionKeys(roleId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("app_role_permissions as rp")
    .innerJoin("app_permissions as p", "p.id", "rp.permission_id")
    .select(["p.key as key"])
    .where("rp.role_id", "=", roleId)
    .execute();
  return rows.map((r) => r.key);
}

/**
 * POST /api/administrator/roles/[id]/permissions
 *
 * Attaches the given permission keys to the role. Body: `{ ids: string[] }`.
 * Unknown keys are silently dropped — they cannot grant power they
 * don't have. Existing assignments are left untouched (idempotent).
 *
 * Caller MUST hold `admin.roles.update`.
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.permissions",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const role = await loadRoleHeader(id);
  if (!role) return adminErrorResponse("not_found", 404, request);
  // ADR-0001: confine an org admin to their org's roles (404 to avoid
  // confirming a foreign/global role exists).
  if (!canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }
  // Privilege-escalation guard (AUTHZ-3): a non-SUPERADMIN may attach only
  // permission keys they themselves currently hold. Otherwise an org admin
  // could grant a role authority they lack — including the `superuser` marker
  // (subsumed here, since it is never in a non-superadmin's held set) — and
  // then assign that role to themselves.
  if (!isSuperadmin(guard.access)) {
    const unheld = unheldPermissionKeys(guard.access.permissions, parsed.data.ids);
    if (unheld.length > 0) return adminErrorResponse("forbidden", 403, request);
  }

  // Resolve key -> permission_id. Keys not in the catalog are dropped.
  const permRows = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("key", "in", parsed.data.ids)
    .execute();
  const resolved = permRows.map((r) => ({ id: r.id, key: r.key }));

  if (resolved.length > 0) {
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("app_role_permissions")
        .values(resolved.map((p) => ({ role_id: id, permission_id: p.id })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    });
  }

  const finalKeys = await currentPermissionKeys(id);

  await auditRoleAction("admin.role.permissions_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: role.organization_id,
    metadata: {
      roleId: id,
      key: role.key,
      added: resolved.map((r) => r.key).sort(),
      removed: [],
      resulting: finalKeys,
    },
  });

  return NextResponse.json({ ok: true, permissions: finalKeys });
}

/**
 * DELETE /api/administrator/roles/[id]/permissions
 *
 * Detaches the given permission keys from the role. Body: same
 * `{ ids: string[] }` shape. Keys not currently attached are no-ops.
 *
 * Caller MUST hold `admin.roles.update`.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.roles.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.roles.permissions",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = idsSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const role = await loadRoleHeader(id);
  if (!role) return adminErrorResponse("not_found", 404, request);
  // ADR-0001: confine an org admin to their org's roles (404 to avoid
  // confirming a foreign/global role exists).
  if (!canAccessOrg(guard.access, role.organization_id)) {
    return adminErrorResponse("not_found", 404, request);
  }

  const permRows = await db
    .selectFrom("app_permissions")
    .select(["id", "key"])
    .where("key", "in", parsed.data.ids)
    .execute();
  const resolved = permRows.map((r) => ({ id: r.id, key: r.key }));

  if (resolved.length > 0) {
    await db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom("app_role_permissions")
        .where("role_id", "=", id)
        .where(
          "permission_id",
          "in",
          resolved.map((r) => r.id),
        )
        .execute();
    });
  }

  const finalKeys = await currentPermissionKeys(id);

  await auditRoleAction("admin.role.permissions_changed", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: role.organization_id,
    metadata: {
      roleId: id,
      key: role.key,
      added: [],
      removed: resolved.map((r) => r.key).sort(),
      resulting: finalKeys,
    },
  });

  return NextResponse.json({ ok: true, permissions: finalKeys });
}
