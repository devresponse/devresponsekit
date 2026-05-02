import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditUserAction } from "@/lib/admin/audit-helpers.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";
import {
  isResolvedUserResponse,
  resolveTargetUser,
} from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/administrator/users/[id]/app-roles
 *
 * Returns the application-role assignments carried by the target
 * user (the User detail "Roles" tab from §8.4 consumes this). Each
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
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  const rows = await db
    .selectFrom("app_user_roles as ur")
    .innerJoin("app_roles as r", "r.id", "ur.role_id")
    .leftJoin("app_organizations as o", "o.id", "ur.organization_id")
    .select([
      "r.id as role_id",
      "r.key as role_key",
      "r.name as role_name",
      "ur.organization_id as organization_id",
      "o.name as organization_name",
      "ur.created_at as created_at",
    ])
    .where("ur.app_user_id", "=", target.appUserId)
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

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = assignSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Validate role + org existence up front so the FK violation surfaces
  // as a clean 404 rather than a 500.
  const role = await db
    .selectFrom("app_roles")
    .select(["id", "key", "organization_id"])
    .where("id", "=", parsed.data.roleId)
    .executeTakeFirst();
  if (!role) return NextResponse.json({ error: "role_not_found" }, { status: 404 });

  const org = await db
    .selectFrom("app_organizations")
    .select(["id"])
    .where("id", "=", parsed.data.organizationId)
    .executeTakeFirst();
  if (!org) return NextResponse.json({ error: "organization_not_found" }, { status: 404 });

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

  const { id } = await ctx.params;
  const target = await resolveTargetUser(id);
  if (isResolvedUserResponse(target)) return target;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = assignSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Pull the role's key for the audit row before deleting.
  const role = await db
    .selectFrom("app_roles")
    .select(["id", "key"])
    .where("id", "=", parsed.data.roleId)
    .executeTakeFirst();

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("app_user_roles")
      .where("app_user_id", "=", target.appUserId)
      .where("organization_id", "=", parsed.data.organizationId)
      .where("role_id", "=", parsed.data.roleId)
      .execute();
  });

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
