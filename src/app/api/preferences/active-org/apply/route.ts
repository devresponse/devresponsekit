import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_ADMIN_MUTATION_LIMIT, enforceRateLimit } from "@/lib/admin/rate-limit.server";
import { getOrCreateRequestId } from "@/lib/admin/request-id.server";
import { auditEvent } from "@/lib/audit.server";
import { userHasActiveMembership } from "@/lib/active-org.server";
import { ACTIVE_ORG_COOKIE, setActiveOrgCookie } from "@/lib/active-org-cookie";
import { getCurrentSession, getImpersonatorId } from "@/lib/auth-guard";
import { getSessionAccessContext } from "@/lib/session-access.server";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";
import { getSafeReturnTo } from "@/lib/safe-return-to";
import { ORG_SIGNUP_HINT_COOKIE } from "@/lib/scoped-auth";
import { withAdminRoute } from "@/lib/route-handler.server";

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
 * unknown org, a non-membership or an exhausted rate limit never errors and
 * never leaks whether an org exists.
 *
 * F-105: a switch writes an append-only audit row, so the GET draws on the
 * same per-user bucket as the POST switcher (`preferences.active_org`). A real
 * sign-in spends one token; a scripted loop, or a cross-site top-level
 * navigation replayed against a victim (the cookies are SameSite=Lax), stops
 * adding switch rows once the bucket is empty; the limiter itself samples an
 * `administrator.rate_limited` row, about once a minute per user, as it does
 * for every refusal. A hit that would change nothing (the
 * browser already holds this org's cookie) writes neither the row nor the
 * cookie.
 */
export const GET = withAdminRoute(async function GET(request: NextRequest) {
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
  // Never re-pin the active org for an impersonated session — degrade to a
  // plain redirect so an impersonated session cannot change tenant. Mirrors the
  // guard on POST /api/preferences/active-org (P0-1).
  if (getImpersonatorId(session)) {
    return redirect;
  }
  // F-105: charged before the lookups, so a loop also stops costing the org
  // and membership queries. The 429 itself is discarded: this is a browser
  // landing, so a refusal degrades to the plain redirect like every branch.
  const limited = enforceRateLimit(
    "preferences.active_org",
    session.user.id,
    DEFAULT_ADMIN_MUTATION_LIMIT,
    request,
    getOrCreateRequestId(request),
  );
  if (limited) {
    return redirect;
  }
  const access = await getSessionAccessContext(session);
  if (!access.appUserId) {
    return redirect;
  }

  const org = await resolveOrganizationByIdentifier(orgParam);
  if (!org || !(await userHasActiveMembership(access.appUserId, org.id))) {
    return redirect;
  }
  // F-105: already the active org. Re-auditing it would record a change that
  // did not happen.
  if (request.cookies.get(ACTIVE_ORG_COOKIE)?.value === org.id) {
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

  setActiveOrgCookie(redirect, org.id);
  return redirect;
});
