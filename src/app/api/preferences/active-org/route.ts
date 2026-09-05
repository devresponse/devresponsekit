import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAccountUser } from "@/lib/account/guard.server";
import { adminErrorResponse } from "@/lib/admin/errors.server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { auditEvent } from "@/lib/audit.server";
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
 *
 * Authorization goes through the shared self-service guard
 * (`requireAccountUser`, review #28): trusted-origin CSRF check on the
 * ambient cookie (review #39/#188), active user + active membership, and a
 * per-user rate limit on the mutation tier. Two route-specific refusals sit
 * on top of the guard:
 *
 *   - Bearer credentials (API key / JWT) are refused. They are bound to the
 *     tenant they were minted in (MACHINE-1) and never read the cookie, so
 *     there is nothing for them to switch — and before review #28 they could
 *     not reach this route at all (it authenticated only via the session
 *     cookie), so refusing them preserves that contract exactly.
 *   - An impersonated session is refused (P0-1, below).
 */
export async function POST(request: NextRequest) {
  const guard = await requireAccountUser(request, "account.preferences.write");
  if (!guard.ok) return guard.response;
  const { actor } = guard;

  const requestId = getOrCreateRequestId(request);
  if (actor.callerKind !== "session") {
    return adminErrorResponse("forbidden", 403, request, { requestId });
  }

  // An impersonated session must never change tenant. The impersonation
  // escalation guard (POST /api/administrator/users/[id]/impersonate) validates
  // the target's permissions only in the org active when impersonation STARTED;
  // were the impersonated session then free to switch active_org, a
  // non-superadmin actor could pivot into a tenant the guard never checked and
  // wield the target's admin.* permissions there — a cross-tenant privilege
  // escalation. Confine the impersonated session to its starting org. (P0-1)
  // The marker rides the resolved caller (`actor.impersonatorId`) so no second
  // session lookup is needed (review #28).
  if (actor.impersonatorId) {
    return NextResponse.json({ error: "forbidden_while_impersonating" }, { status: 403 });
  }

  const limited = enforceRateLimit(
    "preferences.active_org",
    actor.betterAuthUserId,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    requestId,
  );
  if (limited) return limited;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return adminErrorResponse("invalid_body", 400, request, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return adminErrorResponse("invalid_body", 400, request, { requestId });
  }
  const { organizationId } = parsed.data;

  if (!(await userHasActiveMembership(actor.appUserId, organizationId))) {
    // 404, not 403: do not confirm the existence of an org the caller has no
    // active membership in (consistent with the admin routes' tenant scoping).
    return adminErrorResponse("not_found", 404, request, { requestId });
  }

  await auditEvent({
    eventType: "account.active_organization.changed",
    outcome: "success",
    actorBetterAuthUserId: actor.betterAuthUserId,
    appUserId: actor.appUserId,
    organizationId,
    request,
    requestId,
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
