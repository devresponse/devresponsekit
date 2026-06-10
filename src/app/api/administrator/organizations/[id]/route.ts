import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  AdminError,
  assertOrgEmpty,
  assertOrgNotDefault,
  loadOrgOrThrow,
  SLUG_RE,
} from "@/lib/admin/orgs.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { isUuid } from "@/lib/admin/user-target.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/organizations/:id
 *
 * Returns detailed view of an organization with associated counts.
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  try {
    const org = await loadOrgOrThrow(id);
    return NextResponse.json(org);
  } catch (err) {
    if (err instanceof AdminError && err.code === "organization_not_found") {
      return adminErrorResponse(err.code, 404, request);
    }
    throw err;
  }
}

/**
 * PATCH /api/administrator/organizations/:id
 *
 * Updates organization fields. Caller MUST hold `admin.orgs.update`.
 *
 * Body fields (all optional):
 *   - slug: string
 *   - name: string
 *   - status: "active" | "pending" | "suspended" | "archived"
 *   - isDefault: boolean
 */
const patchSchema = z
  .object({
    slug: z.string().min(1).max(64).regex(SLUG_RE).optional(),
    name: z.string().min(1).max(200).optional(),
    status: z.enum(["active", "pending", "suspended", "archived"]).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  const existing = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  const updates: Record<string, unknown> = {};
  if (input.slug !== undefined) updates.slug = input.slug;
  if (input.name !== undefined) updates.name = input.name;
  if (input.status !== undefined) updates.status = input.status;
  if (input.isDefault !== undefined) updates.is_default = input.isDefault;
  updates.updated_at = new Date();

  try {
    if (input.isDefault === true) {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("app_organizations")
          .set({ is_default: false })
          .where("is_default", "=", true)
          .execute();
        await trx.updateTable("app_organizations").set(updates).where("id", "=", id).execute();
      });
    } else {
      await db.updateTable("app_organizations").set(updates).where("id", "=", id).execute();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/duplicate key|unique constraint/i.test(message)) {
      return adminErrorResponse("slug_taken", 409, request);
    }
    throw err;
  }

  await auditOrgAction("admin.organization.updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: id,
    metadata: { organizationId: id, slug: input.slug ?? existing.slug, changes: input },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/organizations/:id
 *
 * Deletes an organization if empty and not the default.
 * Caller MUST hold `admin.orgs.delete`.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.delete");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!isUuid(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_organizations")
    .select(["id", "slug"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  try {
    await assertOrgNotDefault(id);
    await assertOrgEmpty(id);
  } catch (err) {
    if (err instanceof AdminError) {
      await auditOrgAction("admin.organization.delete_blocked", "denied", {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: id,
        metadata: { organizationId: id, slug: existing.slug, reason: err.code },
      });
      return adminErrorResponse(err.code, 409, request);
    }
    throw err;
  }

  await db.deleteFrom("app_organizations").where("id", "=", id).execute();

  await auditOrgAction("admin.organization.deleted", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: id,
    metadata: { organizationId: id, slug: existing.slug },
  });

  return NextResponse.json({ ok: true });
}
