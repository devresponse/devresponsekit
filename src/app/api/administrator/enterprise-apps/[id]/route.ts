import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { updateEnterpriseAppSchema } from "@/lib/validation/enterprise-apps";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  APP_ID_RE,
  isAllowedEnterpriseOrigin,
  isHttpsOrigin,
} from "@/lib/admin/enterprise-apps.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { canAccessOrg, isSuperadmin } from "@/lib/admin/access-scope.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/administrator/enterprise-apps/:id
 *
 * Returns an enterprise application by id (text PK, not UUID).
 * Caller MUST hold `admin.apps.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apps.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const row = await db
    .selectFrom("app_enterprise_applications as a")
    .leftJoin("app_organizations as o", "o.id", "a.organization_id")
    .select([
      "a.id",
      "a.label",
      "a.description",
      "a.origin",
      "a.subdomain",
      "a.sso_audience",
      "a.status",
      "a.sort_order",
      "a.organization_id",
      "o.slug as organization_slug",
      "o.name as organization_name",
      "a.created_at",
    ])
    .where("a.id", "=", id)
    .executeTakeFirst();
  if (!row) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // ADR-0001: an org admin sees only apps owned by their org; a global app
  // (organization_id null) is SUPERADMIN-only. 404, not 403, to avoid leak.
  if (!canAccessOrg(guard.access, row.organization_id)) {
    return adminErrorResponse("application_not_found", 404, request);
  }

  return NextResponse.json(row);
}

/**
 * PATCH /api/administrator/enterprise-apps/:id
 *
 * Updates mutable fields of an enterprise application. The `id` is a
 * stable primary key referenced by SSO handoff nonces and is therefore
 * not editable here. Caller MUST hold `admin.apps.manage`.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apps.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = updateEnterpriseAppSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  if (input.origin !== undefined && !isHttpsOrigin(input.origin)) {
    return adminErrorResponse("invalid_origin", 400, request);
  }
  // P2-5: confine the SSO redirect target to the trusted host allow-list.
  if (input.origin !== undefined && !isAllowedEnterpriseOrigin(input.origin)) {
    return adminErrorResponse("origin_not_allowed", 400, request);
  }

  const existing = await db
    .selectFrom("app_enterprise_applications")
    .select(["id", "organization_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // ADR-0001: an org admin may only manage apps owned by their org. 404 to
  // avoid confirming a foreign/global app exists.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // Re-homing an app to another org (or to global) is a tenancy boundary
  // change — SUPERADMIN only. An org admin cannot move apps in or out.
  if (input.organization_id !== undefined && !isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const updates: Record<string, unknown> = {};
  if (input.label !== undefined) updates.label = input.label;
  if (input.description !== undefined) updates.description = input.description;
  if (input.origin !== undefined) updates.origin = input.origin;
  if (input.subdomain !== undefined) updates.subdomain = input.subdomain;
  if (input.sso_audience !== undefined) updates.sso_audience = input.sso_audience;
  if (input.status !== undefined) updates.status = input.status;
  if (input.sort_order !== undefined) updates.sort_order = input.sort_order;
  if (input.organization_id !== undefined) updates.organization_id = input.organization_id;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true });
  }

  try {
    await db.updateTable("app_enterprise_applications").set(updates).where("id", "=", id).execute();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/foreign key/i.test(message)) {
      return adminErrorResponse("organization_not_found", 409, request);
    }
    throw err;
  }

  await auditEvent({
    eventType: "admin.app.updated",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: input.organization_id !== undefined ? (input.organization_id ?? null) : null,
    targetApplicationId: id,
    request,
    metadata: { id, changes: input },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/administrator/enterprise-apps/:id
 *
 * Deletes an enterprise application. Refuses with `application_in_use`
 * (409) when SSO handoff nonces still reference the row — the app id
 * is a stable foreign key and removing a row that's still in use would
 * orphan audit trails.
 *
 * Caller MUST hold `admin.apps.manage`.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.apps.write",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
  );
  if (limited) return limited;

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_enterprise_applications")
    .select(["id", "label", "organization_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("application_not_found", 404, request);
  }
  // ADR-0001: an org admin may only delete apps owned by their org; a
  // global app is SUPERADMIN-only. 404 to avoid leaking existence.
  if (!canAccessOrg(guard.access, existing.organization_id)) {
    return adminErrorResponse("application_not_found", 404, request);
  }

  try {
    await db.deleteFrom("app_enterprise_applications").where("id", "=", id).execute();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (/foreign key/i.test(message)) {
      await auditEvent({
        eventType: "admin.app.delete_blocked",
        outcome: "denied",
        actorBetterAuthUserId: guard.betterAuthUserId,
        targetApplicationId: id,
        request,
        metadata: { id, reason: "application_in_use" },
      });
      return adminErrorResponse("application_in_use", 409, request);
    }
    throw err;
  }

  await auditEvent({
    eventType: "admin.app.deleted",
    outcome: "success",
    actorBetterAuthUserId: guard.betterAuthUserId,
    targetApplicationId: id,
    request,
    metadata: { id, label: existing.label },
  });

  return NextResponse.json({ ok: true });
}
