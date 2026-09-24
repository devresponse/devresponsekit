import "server-only";
import type { NextResponse } from "next/server";

/**
 * The `active_org` selector cookie: which of the caller's memberships a
 * browser session acts in. `getUserAccessContext` (src/lib/auth-status.ts)
 * reads it through `readActiveOrgId` (src/lib/active-org.server.ts); what it
 * may and may not decide is documented there.
 */
export const ACTIVE_ORG_COOKIE = "active_org";

/** One year. The choice deliberately outlives sign-out and sign-in. */
const ACTIVE_ORG_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Pins the active organization on a route response. The ONE writer of the
 * cookie, so every route that pins it — the switcher
 * (`POST /api/preferences/active-org`), the scoped-sign-in applicator
 * (`GET /api/preferences/active-org/apply`) and invitation acceptance
 * (`POST /api/invitations/accept`, F-33) — sets identical attributes. Two
 * copies with different attributes would leave the browser holding two
 * `active_org` cookies, and which one a request carries would then be up to
 * the browser.
 *
 * Host-only on purpose (no `Domain`). `COOKIE_DOMAIN` widens Better Auth's
 * SESSION cookie to the parent domain so Option C satellites share the
 * session; the org selector is read by this deployment alone and must not
 * follow it there. The caller decides WHETHER to pin — each route first
 * checks that the caller holds an ACTIVE membership in an active org
 * (`userHasActiveMembership`), so the cookie never names an org the caller
 * cannot enter.
 */
export function setActiveOrgCookie(response: NextResponse, organizationId: string): void {
  response.cookies.set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACTIVE_ORG_MAX_AGE_SECONDS,
  });
}
