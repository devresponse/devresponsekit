import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auditEvent } from "@/lib/audit.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { ACTIVE_ORG_COOKIE, userHasActiveMembership } from "@/lib/active-org.server";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ organizationId: z.string().uuid() });

/**
 * POST /api/preferences/active-org
 *
 * Sets the caller's active organization (multi-org switcher). The target
 * MUST be an org the caller is an ACTIVE member of — otherwise switching
 * would just bounce them to pending/blocked. The value is stored in the
 * `active_org` cookie that `getUserAccessContext` reads each request.
 *
 * Authority lives in the membership check here AND in
 * `getUserAccessContext` (which only resolves the caller's own
 * memberships), so the cookie is a selector, never a grant.
 */
export async function POST(request: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const access = await getUserAccessContext(session.user.id);
  if (decideSecureAccess(access.status, access.membershipStatus) === "blocked") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!access.appUserId) {
    return NextResponse.json({ error: "not_provisioned" }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { organizationId } = parsed.data;

  if (!(await userHasActiveMembership(access.appUserId, organizationId))) {
    // 404, not 403: do not confirm the existence of an org the caller has no
    // active membership in (consistent with the admin routes' tenant scoping).
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await auditEvent({
    eventType: "account.active_organization.changed",
    outcome: "success",
    actorBetterAuthUserId: session.user.id,
    appUserId: access.appUserId,
    organizationId,
    request,
    metadata: { organizationId },
  });

  const response = NextResponse.json({ ok: true, organizationId });
  response.cookies.set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return response;
}
