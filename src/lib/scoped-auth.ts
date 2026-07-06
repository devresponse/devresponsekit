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
