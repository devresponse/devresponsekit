import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { revokeInvitation } from "@/lib/invitations.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; invitationId: string }>;
}

/**
 * DELETE /api/administrator/organizations/:id/invitations/:invitationId
 *
 * Revokes a PENDING invitation — the accept link dies immediately. 404
 * `invitation_not_found` when there is no pending invitation with this id
 * in this org (accepted/revoked rows are history, not revocable).
 *
 * Caller MUST hold `admin.orgs.update`.
 */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  const limited = enforceRateLimit(
    "admin.orgs.invitations",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id, invitationId } = await context.params;
  if (!isUuid(id) || !isUuid(invitationId)) {
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
  // ADR-0001: foreign org → 404, never 403.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  const revoked = await revokeInvitation({
    invitationId,
    organizationId: org.id,
    revokedByBetterAuthUserId: guard.betterAuthUserId,
  });
  if (!revoked) {
    return adminErrorResponse("invitation_not_found", 404, request);
  }

  await auditOrgAction("admin.organization.invitation_revoked", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: org.id,
    requestId: guard.requestId,
    metadata: { organizationId: org.id, slug: org.slug, invitationId },
  });

  return NextResponse.json({ ok: true });
}
