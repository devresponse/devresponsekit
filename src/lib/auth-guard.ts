import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { decideSecureAccess, getUserAccessContext } from "@/lib/auth-status";
import { withTrustedClientIp } from "@/lib/client-ip";
import { getServerEnv } from "@/lib/env";
import { isSessionPastAbsoluteLifetime } from "@/lib/session-lifetime";
import { readImpersonatorId } from "@/lib/impersonation";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Reads the Better Auth session from incoming request headers.
 *
 * Returns `null` when the user is not authenticated or the session has
 * expired. This function is safe to call from layouts, route handlers,
 * server components, and server actions.
 *
 * The headers handed to Better Auth are a copy stamped with the trusted
 * client-IP header (`withTrustedClientIp`, review #35) — the ambient store
 * may come from a route the proxy never matched, so the derivation is
 * applied here rather than trusted from the request.
 *
 * ABSOLUTE LIFETIME (review #200): Better Auth's window is rolling, so an
 * active session refreshes indefinitely. When the operator sets
 * `SESSION_ABSOLUTE_LIFETIME_HOURS`, a session older than that — measured
 * from CREATION, not last activity — is reported as absent here and revoked,
 * so every caller (browser guards, server actions, the `/api/v1` cookie path)
 * inherits the cap from this one chokepoint. The variable is UNSET by
 * default, which keeps the pre-existing "rolls forever" behaviour exactly.
 */
export async function getCurrentSession() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: withTrustedClientIp(requestHeaders) });
  if (!session) return null;

  if (
    !isSessionPastAbsoluteLifetime(session.session, getServerEnv().SESSION_ABSOLUTE_LIFETIME_HOURS)
  ) {
    return session;
  }

  // Best-effort revocation: the cap holds even if this fails (we already
  // decided to report the session as absent), but deleting the row stops the
  // cookie from being replayed against every subsequent request and from
  // being refreshed back to life by Better Auth.
  try {
    const ctx = await auth.$context;
    await ctx.internalAdapter.deleteSession(session.session.token);
  } catch (error) {
    const { logServerError } = await import("@/lib/observability/logger.server");
    logServerError("absolute-lifetime session revocation failed", {
      err: error,
      betterAuthUserId: session.user.id,
    });
  }
  return null;
}

/**
 * The ORIGINAL actor's id when the current session is an impersonation
 * session, else `null`. Better Auth's admin plugin stamps `impersonatedBy`
 * onto the session row when an admin starts impersonating; different plugin
 * versions camel- or snake-case the field, so accept both shapes (the read
 * itself lives in the pure `impersonation.ts` so the caller resolver can
 * share it — review #28).
 *
 * This is the authority to STOP impersonating: the impersonated identity is
 * typically a plain member with no admin permissions, so the right to end the
 * session derives from it being an impersonation session — not from the
 * impersonated user's permissions.
 */
export function getImpersonatorId(
  session: Awaited<ReturnType<typeof getCurrentSession>>,
): string | null {
  return readImpersonatorId(session);
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
