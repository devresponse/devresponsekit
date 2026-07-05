import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { canAccessOrg } from "@/lib/admin/access-scope.server";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { isUuid } from "@/lib/admin/user-target.server";
import { buildInvitationAcceptUrl, regenerateInvitationToken } from "@/lib/invitations.server";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; invitationId: string }>;
}

/**
 * POST /api/administrator/organizations/:id/invitations/:invitationId/resend
 *
 * Rotates a PENDING invitation's token + expiry in place and re-sends the
 * email: the previous link dies immediately, and an expired-but-pending
 * invitation is deliberately revived with a fresh 7-day window. 404
 * `invitation_not_found` for accepted/revoked/unknown rows.
 *
 * Caller MUST hold `admin.orgs.update`.
 */
export async function POST(request: NextRequest, context: RouteContext) {
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
    .select(["id", "slug", "name"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!org) {
    return adminErrorResponse("organization_not_found", 404, request);
  }
  // ADR-0001: foreign org → 404, never 403.
  if (!canAccessOrg(guard.access, id)) {
    return adminErrorResponse("organization_not_found", 404, request);
  }

  const invitation = await db
    .selectFrom("app_organization_invitations")
    .select(["id", "email"])
    .where("id", "=", invitationId)
    .where("organization_id", "=", org.id)
    .executeTakeFirst();
  if (!invitation) {
    return adminErrorResponse("invitation_not_found", 404, request);
  }

  const rotated = await regenerateInvitationToken({ invitationId, organizationId: org.id });
  if (!rotated) {
    return adminErrorResponse("invitation_not_found", 404, request);
  }

  const inviter = await db
    .selectFrom("app_users")
    .select(["display_name", "primary_email"])
    .where("id", "=", guard.access.appUserId ?? "")
    .executeTakeFirst();
  const { sendAppEmail } = await import("@/lib/email/send.server");
  await sendAppEmail({
    to: invitation.email,
    templateKey: "organization_invitation",
    variables: {
      inviterName: inviter?.display_name || inviter?.primary_email || "An administrator",
      organizationName: org.name,
      acceptUrl: buildInvitationAcceptUrl(rotated.plaintextToken),
    },
  });

  await auditOrgAction("admin.organization.invitation_resent", "success", {
    request,
    actorBetterAuthUserId: guard.betterAuthUserId,
    organizationId: org.id,
    requestId: guard.requestId,
    metadata: { organizationId: org.id, slug: org.slug, invitationId },
  });

  return NextResponse.json({ ok: true, expiresAt: rotated.expiresAt.toISOString() });
}
