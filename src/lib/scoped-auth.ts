/**
 * Client-safe helpers for the organization-scoped auth entry points
 * (`/sign-in/<org>`, `?org=<slug>`). Pure string building — no server imports —
 * so both the server-rendered auth forms and any client code share one
 * definition of the apply-org callback path.
 */

/**
 * Path of the post-sign-in active-org applicator route
 * (`GET /api/preferences/active-org/apply`). Used as Better Auth's
 * `callbackURL` on a scoped sign-in so that, after authentication, an existing
 * member lands with the scoped org active; `next` is where it redirects on.
 */
export function buildActiveOrgApplyPath(orgIdentifier: string, next: string): string {
  const params = new URLSearchParams({ org: orgIdentifier, next });
  return `/api/preferences/active-org/apply?${params.toString()}`;
}

/**
 * Short-lived cookie that carries the organization scope across the social
 * OAuth round trip — which has no request body, so the sign-up-body
 * `organizationHint` cannot reach the provider callback. The proxy sets it on a
 * scoped sign-in/up page and clears it on a plain one; the sign-in provisioning
 * hook reads it for a brand-new social user. Placement only — provisioning
 * still applies the target org's signup policy.
 */
export const ORG_SIGNUP_HINT_COOKIE = "org_signup_hint";

/**
 * Reads a single cookie value out of a raw `Cookie` request header. Kept here
 * (dependency-free) so both the Edge proxy and the Node auth hook parse the
 * hint identically. Returns undefined when absent or empty.
 */
export function readCookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() !== name) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || undefined;
    } catch {
      return raw || undefined;
    }
  }
  return undefined;
}
