import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import {
  deleteOrgAuthSettings,
  getOrgAuthSettingsRow,
  upsertOrgAuthSettings,
} from "@/lib/admin/auth-settings.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { getAuthPolicyForOrg } from "@/lib/auth-policy.server";
import { authPolicySettingsSchema } from "@/lib/validation/auth-policy";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function loadScopedOrg(
  request: NextRequest,
  context: RouteContext,
  guard: { access: Parameters<typeof canAccessOrg>[0] },
): Promise<{ id: string; slug: string } | NextResponse> {
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
  // ADR-0001: org admins are confined to their own org; 404 (not 403) so a
  // foreign org's existence is not confirmed. SUPERADMIN bypasses.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  return org;
}

/**
 * GET /api/administrator/organizations/:id/auth-settings
 *
 * The org's signup policy (0007): the raw override row (`settings`, null
 * when the org inherits) plus the EFFECTIVE resolved policy (`effective`,
 * whose `source` says organization / platform_default / fail_closed).
 *
 * Caller MUST hold `admin.orgs.read`.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const org = await loadScopedOrg(request, context, guard);
  if (org instanceof NextResponse) return org;

  const [settings, effective] = await Promise.all([
    getOrgAuthSettingsRow(org.id),
    getAuthPolicyForOrg(org.id),
  ]);
  return NextResponse.json({ ok: true, settings, effective });
}

/**
 * PATCH /api/administrator/organizations/:id/auth-settings
 *
 * Creates or replaces the org's COMPLETE policy override (0007 has no
 * per-field inheritance, so the body is the full policy — see
 * `authPolicySettingsSchema`).
 *
 * Caller MUST hold `admin.orgs.update`.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.auth-settings",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const org = await loadScopedOrg(request, context, guard);
  if (org instanceof NextResponse) return org;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = authPolicySettingsSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const previous = await getOrgAuthSettingsRow(org.id);
  await upsertOrgAuthSettings(org.id, parsed.data, guard.betterAuthUserId);

  await auditOrgAction("admin.organization.auth_policy_updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: org.id,
    requestId: guard.requestId,
    metadata: {
      organizationId: org.id,
      slug: org.slug,
      previous,
      next: parsed.data,
    },
  });

  const settings = await getOrgAuthSettingsRow(org.id);
  return NextResponse.json({ ok: true, settings });
}

/**
 * DELETE /api/administrator/organizations/:id/auth-settings
 *
 * Removes the org's policy override so it reverts to the platform default.
 * 404 `auth_settings_not_found` when the org has no override.
 *
 * Caller MUST hold `admin.orgs.update`.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.auth-settings",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const org = await loadScopedOrg(request, context, guard);
  if (org instanceof NextResponse) return org;

  const previous = await getOrgAuthSettingsRow(org.id);
  const removed = await deleteOrgAuthSettings(org.id);
  if (!removed) {
    return adminErrorResponse("auth_settings_not_found", 404, request);
  }

  await auditOrgAction("admin.organization.auth_policy_reset", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: org.id,
    requestId: guard.requestId,
    metadata: { organizationId: org.id, slug: org.slug, previous },
  });

  return NextResponse.json({ ok: true });
}
