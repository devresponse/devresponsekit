import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import {
  deleteOrgAuthSettings,
  getOrgAuthSettingsRow,
  upsertOrgAuthSettings,
} from "@/lib/admin/auth-settings.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { loadScopedOrg } from "@/lib/admin/org-route.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { getAuthPolicyForOrg } from "@/lib/auth-policy.server";
import { authPolicySettingsSchema } from "@/lib/validation/auth-policy";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
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

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
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
    "admin.orgs.auth_settings",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
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
    "admin.orgs.auth_settings",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id } = await context.params;
  const org = await loadScopedOrg(request, id, guard.access);
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
