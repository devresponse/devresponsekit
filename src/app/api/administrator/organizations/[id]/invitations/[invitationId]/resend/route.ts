import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { auditOrgAction } from "@/lib/admin/audit-helpers.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { loadScopedOrg, ORGANIZATION_NOT_ACTIVE_ERROR } from "@/lib/admin/org-route.server";
import { isAdminPermissionDenial, requireAdminPermission } from "@/lib/admin/permissions.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT } from "@/lib/admin/rate-limit.server";
import { enforceSharedRateLimit } from "@/lib/admin/rate-limit-shared.server";
import {
  ADMIN_MAIL_EVENTS,
  enforceOrgAdminMailBudget,
  enforceRecipientCooldown,
} from "@/lib/admin/admin-mail-budget.server";
import { isUuid } from "@/lib/admin/user-target.server";
import type { SendAppEmailResult } from "@/lib/email/send.server";
import {
  enforceInviterStanding,
  regenerateInvitationToken,
  sendInvitationEmail,
} from "@/lib/invitations.server";
import { ACTIVE_ORGANIZATION_STATUS } from "@/lib/validation/organizations";
import { withAdminRoute } from "@/lib/route-handler.server";

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
 * `invitation_not_found` for accepted/revoked/unknown rows; 409
 * `organization_not_active` while the org is not `active` (F-09); 409
 * `invitation_inviter_lacks_standing` when the original inviter can no longer
 * invite, after voiding the invitation (F-149).
 *
 * F-64: 429 `rate_limited` when this invitation was resent in the last
 * 10 minutes (by anyone), or when an org-confined caller's organization has
 * spent its daily admin-mail budget. The per-actor budget is the create
 * route's, from the shared bucket.
 *
 * F-104: `ok` is false when the provider rejected the email: the token is
 * rotated, so the previous link is dead, and nobody received the new one. The
 * audit row carries the outbox id and the email's status, as on create.
 *
 * Caller MUST hold `admin.orgs.update`.
 */
export const POST = withAdminRoute(async function POST(
  request: NextRequest,
  context: RouteContext,
) {
  const guard = await requireAdminPermission(request, "admin.orgs.update");
  if (isAdminPermissionDenial(guard)) return guard.response;

  // F-64: from the SHARED bucket, the create route's: kept per process, it
  // multiplied by the instance count, and every token here mails someone.
  const limited = await enforceSharedRateLimit(
    "admin.orgs.invitations",
    guard.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    guard.requestId,
  );
  if (limited) return limited;

  const { id, invitationId } = await context.params;
  if (!isUuid(invitationId)) {
    return adminErrorResponse("invalid_id", 400, request);
  }
  const org = await loadScopedOrg(request, id, guard.access);
  if (org instanceof NextResponse) return org;

  // F-09: a fresh link into a non-active org would be dead on arrival, and
  // rotating the token would also kill the one the invitee already holds. The
  // invitation keeps its current link and can be resent once the org is
  // reactivated; revoking it stays available.
  if (org.status !== ACTIVE_ORGANIZATION_STATUS) {
    return adminErrorResponse(ORGANIZATION_NOT_ACTIVE_ERROR, 409, request, {
      requestId: guard.requestId,
    });
  }

  const invitation = await db
    .selectFrom("app_organization_invitations")
    .select(["id", "email", "role_id", "invited_by"])
    .where("id", "=", invitationId)
    .where("organization_id", "=", org.id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!invitation) {
    return adminErrorResponse("invitation_not_found", 404, request);
  }

  // F-64: a resend loop mailed one invitee at the mutation rate. The daily
  // budget is only read, so it goes first; the cooldown spends this
  // invitation's token, shared by every admin and every instance.
  const overBudget = await enforceOrgAdminMailBudget(guard, org.id, request);
  if (overBudget) return overBudget;
  const cooling = await enforceRecipientCooldown(
    "admin.orgs.invitations.resend",
    invitation.id,
    guard,
    request,
  );
  if (cooling) return cooling;

  // F-149: rotating the token leaves `invited_by` alone, and acceptance
  // refuses (and voids) an invitation whose inviter can no longer invite, so a
  // resend of one would mail a link that cannot work, under this caller's name.
  // Ask the acceptance gate now: it voids the invitation (audited), and the
  // caller sends a new one, which the create route checks against THEM, role
  // included.
  const honoured = await enforceInviterStanding({
    invitation: {
      id: invitation.id,
      organizationId: org.id,
      email: invitation.email,
      roleId: invitation.role_id,
      invitedByAppUserId: invitation.invited_by,
    },
    actorBetterAuthUserId: guard.betterAuthUserId,
    request,
  });
  if (!honoured) {
    return adminErrorResponse("invitation_inviter_lacks_standing", 409, request, {
      requestId: guard.requestId,
    });
  }

  const rotated = await regenerateInvitationToken({ invitationId, organizationId: org.id });
  if (!rotated) {
    return adminErrorResponse("invitation_not_found", 404, request);
  }

  // F-104: as on create, the audit names what became of the email, and a
  // send that throws after the rotation (before its outbox row was written,
  // so nothing was queued) is audited before the 500.
  const audit = (delivery: SendAppEmailResult | null) =>
    auditOrgAction(
      ADMIN_MAIL_EVENTS.invitationResent,
      delivery && delivery.status !== "failed" ? "success" : "error",
      {
        request,
        actorBetterAuthUserId: guard.betterAuthUserId,
        organizationId: org.id,
        requestId: guard.requestId,
        reason:
          delivery === null
            ? "email_send_failed"
            : delivery.status === "failed"
              ? "email_rejected"
              : null,
        metadata: {
          organizationId: org.id,
          slug: org.slug,
          invitationId,
          outboxId: delivery?.outboxId ?? null,
          emailStatus: delivery?.status ?? null,
        },
      },
    );

  const delivery = await sendInvitationEmail({
    to: invitation.email,
    // ADR-0001 / review #220: attribute the resend to the inviting org too.
    organizationId: org.id,
    organizationName: org.name,
    inviterAppUserId: guard.access.appUserId,
    plaintextToken: rotated.plaintextToken,
  }).catch(async (err: unknown) => {
    await audit(null);
    throw err;
  });
  await audit(delivery);

  return NextResponse.json({
    // F-104: false when the provider rejected the email (see above).
    ok: delivery.status !== "failed",
    expiresAt: rotated.expiresAt.toISOString(),
  });
});
