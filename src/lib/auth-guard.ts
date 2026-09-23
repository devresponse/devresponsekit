import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { decideSecureAccess } from "@/lib/auth-status";
import { getSessionAccessContext } from "@/lib/session-access.server";
import { withTrustedClientIp } from "@/lib/client-ip";
import { getServerEnv } from "@/lib/env";
import {
  isImpersonationSessionPastMaxAge,
  isSessionPastAbsoluteLifetime,
} from "@/lib/session-lifetime";
import { readImpersonatorId } from "@/lib/impersonation";
import { noteSessionImpersonation } from "@/lib/impersonation-attribution.server";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Per-request memoization of the Better Auth session lookup (review #75).
 *
 * A single admin render resolved the session 4-5 times: the secure layout,
 * the administrator layout, the page guard and each nested guard all funnel
 * through here, and `session.cookieCache` is off, so every one of them was a
 * real Better Auth session read (a DB round-trip). They all read the SAME
 * incoming headers and therefore always produced the same answer.
 *
 * React `cache()` is the idiomatic per-request memo — it is what
 * `getUserAccessContext` uses — but it memoizes only inside a React render,
 * and this function is also the session source for every `/api/*` route
 * handler (via `resolveCaller`), where the guard can run several times per
 * request. Keying a `WeakMap` on the per-request `Headers` object gives the
 * same request scoping uniformly across renders, route handlers and server
 * actions, and it is the carrier `getOrCreateRequestId` already memoizes on.
 *
 * Correctness:
 *   - Scope. `headers()` returns a fresh object per request, so an entry can
 *     never be read by another request; the entry dies with the request
 *     because nothing else holds the object.
 *   - Impersonation. The memo is keyed on the INCOMING headers, which never
 *     change mid-request. Starting or stopping impersonation writes a new
 *     session cookie on the RESPONSE; the next request carries new headers and
 *     takes a fresh lookup. Within one request, a second call would have
 *     re-read the very same cookie and got the very same session — so
 *     `getImpersonatorId` (and the stop-impersonation authority derived from
 *     it) sees exactly what it saw before.
 *   - Ban chokepoint. `resolveCaller` still evaluates the ban state itself on
 *     every call; this memoizes the session read, not any authorization.
 *   - Failures are NOT memoized: a rejected lookup is evicted so the request
 *     can retry rather than being pinned to a transient error.
 *   - Absolute lifetime (review #200). The cap lives INSIDE the memoized
 *     value: `readSession` applies it, so a session past the operator cap is
 *     reported as absent (and revoked once) no matter which guard asks first.
 *     The one-hour impersonation cap (F-08) rides the same path.
 */
const sessionByRequestHeaders = new WeakMap<object, ReturnType<typeof readSession>>();

async function readSession(requestHeaders: Headers) {
  const session = await auth.api.getSession({ headers: withTrustedClientIp(requestHeaders) });
  if (!session) return null;

  // F-08: an impersonation session is ALSO capped at one hour from creation,
  // whatever the operator cap says. Better Auth's own one-hour `expiresAt` is
  // soft — the plugin skips the rolling refresh only while the signed
  // `dont_remember` cookie is present, so a holder who drops it and calls
  // `/get-session` rolls the row forward 8 h at a time, indefinitely. The
  // borrowed shell reaches Better Auth over HTTP only for `/get-session` and
  // `/sign-out` (F-06); everything it can DO goes through this function, so
  // this is where the bound holds.
  const pastCap =
    isSessionPastAbsoluteLifetime(
      session.session,
      getServerEnv().SESSION_ABSOLUTE_LIFETIME_HOURS,
    ) ||
    (readImpersonatorId(session) !== null && isImpersonationSessionPastMaxAge(session.session));

  if (!pastCap) {
    // F-07: an impersonated session is recorded against the ambient headers —
    // the carrier the RSC admin gate audits its denials with — so those rows
    // name the human behind the session, not the borrowed identity. Inside the
    // memo, so it runs once per request like the read itself.
    noteSessionImpersonation(requestHeaders, session);
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
 *
 * IMPERSONATION CAP (F-08): a session carrying `impersonatedBy` is refused
 * and revoked the same way once it is an hour old
 * (`IMPERSONATION_SESSION_MAX_AGE_SECONDS`), independent of that variable.
 *
 * Memoized per request — see {@link sessionByRequestHeaders} (review #75).
 * The memo holds the CAPPED answer, so the absolute-lifetime check and its
 * best-effort revocation run at most once per request rather than on each of
 * the four or five guards a single render walks through.
 */
export async function getCurrentSession() {
  const requestHeaders = await headers();

  const cached = sessionByRequestHeaders.get(requestHeaders);
  if (cached) return cached;

  const pending = readSession(requestHeaders);
  sessionByRequestHeaders.set(requestHeaders, pending);
  // Evict on failure so a transient error is not pinned for the whole
  // request. The rejection is still delivered to every awaiting caller.
  void pending.catch(() => sessionByRequestHeaders.delete(requestHeaders));
  return pending;
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

  // IMP-1: resolved THROUGH the session, so an impersonated shell is confined
  // to the impersonator's own tenancy rather than to whatever the (unsigned)
  // `active_org` cookie names among the TARGET's memberships.
  const access = await getSessionAccessContext(session);
  const decision = decideSecureAccess(access.status, access.membershipStatus);

  if (decision === "pending_approval") {
    redirect(`/${locale}/pending-approval`);
  }

  if (decision === "blocked") {
    redirect(`/${locale}/blocked?reason=${encodeURIComponent(access.status)}`);
  }

  return { session, access };
}
