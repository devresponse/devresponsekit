import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db } from "@/db/database";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { consumeInvitation, findValidInvitationByToken } from "@/lib/invitations.server";
import { acceptInvitationSchema } from "@/lib/validation/invitations";

export const dynamic = "force-dynamic";

/**
 * POST /api/invitations/accept
 *
 * The explicit acceptance path (0008) for users who already have an
 * account: the invite page posts the plaintext token here once the user
 * confirms. Sign-up-time acceptance (a token riding the sign-up body) is
 * handled inside provisioning instead.
 *
 * Threat / contract:
 *   - Session required (401) — but NOT active membership: the primary
 *     audience includes `pending_approval` users, whose activation is the
 *     invitation's whole point. That is why this deliberately does NOT use
 *     `requireAccountUser` (which demands `decideSecureAccess = allow`).
 *     Blocked/suspended/deactivated users are refused by
 *     `consumeInvitation`'s eligibility rule.
 *   - Cookie CSRF: trusted-origin check on the mutation, mirroring the
 *     account/admin guards.
 *   - The SESSION's email (the live verified identity) must equal the
 *     invited address — 403 `invitation_email_mismatch`; unknown, expired,
 *     revoked, and consumed tokens all collapse into one 404
 *     `invitation_invalid` so nothing leaks to token guessers.
 *   - Per-user rate bucket on top of the ~190-bit token entropy.
 */
export async function POST(request: NextRequest) {
  const origin = checkTrustedOrigin(request);
  if (!origin.ok) {
    // Match the CSRF machine code used by the account + admin guards
    // (`untrusted_origin`); `invalid_origin` is a distinct 400 used by
    // enterprise-apps for a malformed origin field.
    return adminErrorResponse(origin.reason ?? "untrusted_origin", 403, request);
  }

  const session = await getCurrentSession();
  if (!session) {
    return adminErrorResponse("unauthenticated", 401, request);
  }

  const limited = enforceRateLimit(
    "invitations.accept",
    session.user.id,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request);
  }
  const parsed = acceptInvitationSchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request);
  }

  const invitation = await findValidInvitationByToken(parsed.data.token);
  if (!invitation) {
    return adminErrorResponse("invitation_invalid", 404, request);
  }

  const sessionEmail = session.user.email.trim().toLowerCase();
  if (sessionEmail !== invitation.email) {
    return adminErrorResponse("invitation_email_mismatch", 403, request);
  }

  // Any signed-in user has been provisioned by the session-create hook; a
  // missing row means something upstream is broken — refuse rather than
  // invent state here.
  const appUser = await db
    .selectFrom("app_users")
    .select(["id", "status"])
    .where("better_auth_user_id", "=", session.user.id)
    .executeTakeFirst();
  if (!appUser) {
    return adminErrorResponse("forbidden", 403, request);
  }

  const result = await consumeInvitation({
    invitation,
    // The session email is the live verified identity (primary_email can
    // lag an email change); consume re-asserts the match against it.
    appUser: { id: appUser.id, primaryEmail: sessionEmail, status: appUser.status },
    actorBetterAuthUserId: session.user.id,
  });

  if (!result.consumed) {
    if (result.reason === "user_not_eligible") {
      return adminErrorResponse("forbidden", 403, request);
    }
    if (result.reason === "email_mismatch") {
      return adminErrorResponse("invitation_email_mismatch", 403, request);
    }
    // already_consumed — the guarded flip lost a race with another accept.
    return adminErrorResponse("invitation_invalid", 404, request);
  }

  return NextResponse.json({ ok: true, organizationId: invitation.organizationId });
}
