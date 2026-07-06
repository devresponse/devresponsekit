import { NextResponse, type NextRequest } from "next/server";
import { auditEvent } from "@/lib/audit.server";
import { ACTIVE_ORG_COOKIE, userHasActiveMembership } from "@/lib/active-org.server";
import { getCurrentSession } from "@/lib/auth-guard";
import { getUserAccessContext } from "@/lib/auth-status";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";
import { getSafeReturnTo } from "@/lib/safe-return-to";
import { ORG_SIGNUP_HINT_COOKIE } from "@/lib/scoped-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/preferences/active-org/apply?org=<slug|id>&next=<path>
 *
 * Post-sign-in landing target for the organization-scoped entry points
 * (`/sign-in/<org>`, `?org=<slug>`). The sign-in form points Better Auth's
 * `callbackURL` here so that, immediately after authentication (email OR
 * social, both of which redirect through `callbackURL`), the caller's active
 * organization is pinned to the scoped org — but ONLY when they are already an
 * active member of it. Then it redirects to the sanitized `next`.
 *
 * A GET with a cookie side effect is deliberate and safe here: this is a
 * browser redirect target, and — exactly like `POST /api/preferences/active-org`
 * — the cookie is a SELECTOR among the caller's own memberships, never a grant.
 * `getUserAccessContext` re-derives access from memberships every request, so a
 * forged or prefetched hit can at worst switch a user to one of their own orgs.
 *
 * Every branch degrades to a plain redirect to `next`: a missing session, an
 * unknown org, or a non-membership never errors and never leaks whether an org
 * exists.
 */
export async function GET(request: NextRequest) {
  const nextParam = request.nextUrl.searchParams.get("next");
  const orgParam = request.nextUrl.searchParams.get("org");
  // `next` is re-sanitized here (never trust the query): only a same-origin
  // localized browser path survives; anything else becomes the safe default.
  const localeHint = nextParam?.split("/").filter(Boolean)[0];
  const safeNext = getSafeReturnTo(nextParam, localeHint);
  const redirect = NextResponse.redirect(new URL(safeNext, request.url));

  // This applicator is the completion point of a scoped social flow: the
  // provisioning hook has already read the hint, so retire the cookie here so
  // it can't linger and misroute a later sign-up.
  if (request.cookies.has(ORG_SIGNUP_HINT_COOKIE)) {
    redirect.cookies.delete(ORG_SIGNUP_HINT_COOKIE);
  }

  if (!orgParam) {
    return redirect;
  }

  const session = await getCurrentSession();
  if (!session) {
    return redirect;
  }
  const access = await getUserAccessContext(session.user.id);
  if (!access.appUserId) {
    return redirect;
  }

  const org = await resolveOrganizationByIdentifier(orgParam);
  if (!org || !(await userHasActiveMembership(access.appUserId, org.id))) {
    return redirect;
  }

  await auditEvent({
    eventType: "account.active_organization.changed",
    outcome: "success",
    actorBetterAuthUserId: session.user.id,
    appUserId: access.appUserId,
    organizationId: org.id,
    request,
    metadata: { organizationId: org.id, source: "scoped_sign_in" },
  });

  redirect.cookies.set(ACTIVE_ORG_COOKIE, org.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return redirect;
}
