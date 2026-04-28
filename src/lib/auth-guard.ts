import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Reads the Better Auth session from incoming request headers.
 *
 * Returns `null` when the user is not authenticated or the session has
 * expired. This function is safe to call from layouts, route handlers,
 * server components, and server actions.
 */
export async function getCurrentSession() {
  const requestHeaders = await headers();
  return auth.api.getSession({ headers: requestHeaders });
}

/**
 * Enforces secure access for localized browser routes.
 *
 * `proxy.ts` performs only an early cookie-based redirect; this helper is
 * the real server-side authorization boundary. It validates:
 *   1. The session exists.
 *   2. The application user is provisioned and `active`.
 *   3. The user has at least one `active` organization membership.
 *
 * Any failure short-circuits with a redirect — never returns to the
 * caller — so calling code can rely on the returned access context.
 */
export async function requireSecureSession(locale: string, returnTo?: string) {
  const session = await getCurrentSession();

  if (!session) {
    const params = new URLSearchParams();
    params.set("returnTo", getSafeReturnTo(returnTo, locale));
    redirect(`/${locale}/sign-in?${params.toString()}`);
  }

  const access = await getUserAccessContext(session.user.id);
  const decision = decideSecureAccess(access.status, access.membershipStatus);

  if (decision === "pending_approval") {
    redirect(`/${locale}/pending-approval`);
  }

  if (decision === "blocked") {
    redirect(`/${locale}/blocked?reason=${encodeURIComponent(access.status)}`);
  }

  return { session, access };
}
