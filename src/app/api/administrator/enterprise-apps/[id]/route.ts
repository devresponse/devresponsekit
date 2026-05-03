import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/database";
import { auditEvent } from "@/lib/audit.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isHttpsOrigin,
} from "@/lib/admin/enterprise-apps.server";
import {
  isAdminPermissionDenial,
  requireAdminPermission,
} from "@/lib/admin/permissions.server";

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

  return NextResponse.json(row);
}

/**
 * PATCH /api/administrator/enterprise-apps/:id
 *
 * Updates mutable fields of an enterprise application. The `id` is a
 * stable primary key referenced by SSO handoff nonces and is therefore
 * not editable here. Caller MUST hold `admin.apps.manage`.
 */
const patchSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).nullable().optional(),
    origin: z.string().min(1).max(500).optional(),
    subdomain: z.string().min(1).max(63).regex(SUBDOMAIN_RE).optional(),
    sso_audience: z.string().min(1).max(200).regex(SSO_AUDIENCE_RE).optional(),
    status: z.enum(APP_STATUS_VALUES).optional(),
    sort_order: z.number().int().min(0).max(10000).optional(),
    organization_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.apps.manage");
  if (isAdminPermissionDenial(guard)) return guard.response;

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
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const input = parsed.data;

  if (input.origin !== undefined && !isHttpsOrigin(input.origin)) {
    return adminErrorResponse("invalid_origin", 400, request);
  }

  const existing = await db
    .selectFrom("app_enterprise_applications")
    .select(["id"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
    return adminErrorResponse("application_not_found", 404, request);
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
    await db
      .updateTable("app_enterprise_applications")
      .set(updates)
      .where("id", "=", id)
      .execute();
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
    organizationId:
      input.organization_id !== undefined ? (input.organization_id ?? null) : null,
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

  const { id } = await context.params;
  if (!APP_ID_RE.test(id)) {
    return adminErrorResponse("invalid_id", 400, request);
  }

  const existing = await db
    .selectFrom("app_enterprise_applications")
    .select(["id", "label"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing) {
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
