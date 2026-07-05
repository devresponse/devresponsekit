import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isSuperadmin } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { getOrgAuthSettingsRow, upsertOrgAuthSettings } from "@/lib/admin/auth-settings.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { FAIL_CLOSED_AUTH_POLICY } from "@/lib/auth-policy.server";
import { authPolicySettingsSchema } from "@/lib/validation/auth-policy";

export const dynamic = "force-dynamic";

/**
 * The PLATFORM-DEFAULT signup policy (0007) — the row every organization
 * without its own override inherits (`organization_id IS NULL`). Editing it
 * changes the signup workflow of every non-overridden org at once, so both
 * verbs are SUPERADMIN-only: a platform-level resource is reachable by no
 * org admin (403 `forbidden` — its existence is documented, so there is no
 * tenant-existence leak to hide behind a 404).
 *
 * There is deliberately NO DELETE: the baseline must always exist (the
 * resolver fails closed if it somehow doesn't, but offering deletion of the
 * platform baseline is a pure footgun).
 */

/** GET /api/administrator/auth-settings/defaults — superadmin only. */
export async function GET(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.orgs.read");
  if (isAdminPermissionDenial(guard)) return guard.response;
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const settings = await getOrgAuthSettingsRow(null);
  // Surface what actually governs when the seeded row is missing: the
  // fail-closed constants (same shape the org endpoint's `effective` uses).
  return NextResponse.json({
    ok: true,
    settings,
    effective: settings
      ? {
          requireEmailVerification: settings.requireEmailVerification,
          signupApprovalMode: settings.signupApprovalMode,
          allowedAuthMethods: settings.allowedAuthMethods,
          autoApproveEmailDomains: settings.autoApproveEmailDomains,
          source: "platform_default",
        }
      : FAIL_CLOSED_AUTH_POLICY,
  });
}

/** PATCH /api/administrator/auth-settings/defaults — superadmin only. */
export async function PATCH(request: NextRequest) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;
  if (!isSuperadmin(guard.access)) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const limited = enforceRateLimit(
    "admin.auth-settings.defaults",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

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

  const previous = await getOrgAuthSettingsRow(null);
  await upsertOrgAuthSettings(null, parsed.data, guard.betterAuthUserId);

  // organizationId null = platform-level audit row (superadmin-visible only).
  await auditOrgAction("admin.platform.auth_policy_updated", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: null,
    requestId: guard.requestId,
    metadata: { previous, next: parsed.data },
  });

  const settings = await getOrgAuthSettingsRow(null);
  return NextResponse.json({ ok: true, settings });
}
