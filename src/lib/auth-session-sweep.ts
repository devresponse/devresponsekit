import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { readImpersonatorId } from "@/lib/impersonation";

/**
 * F-10 — "SIGN OUT MY OTHER SESSIONS" ALSO ENDS THE SESSIONS I OPENED AS
 * SOMEONE ELSE.
 *
 * Better Auth's self-service sweeps delete a user's sessions by `userId`, and
 * an impersonation session carries the TARGET's id there (the admin behind it
 * is only in `impersonatedBy`, F-08). So an admin who changed their password
 * with "sign out other devices", or clicked **Sign out other sessions**, ended
 * every session of their own except the one they, or whoever stole their
 * cookie, were driving as a customer. That session kept the customer's
 * authority for up to the one-hour impersonation cap.
 *
 * The sweeps covered here, by route PATTERN (`ctx.path` is the endpoint's own
 * path, never the URL spelling):
 *
 *   - `/change-password` with `revokeOtherSessions: true`. The account form
 *     always sends it. Without the flag the user chose to keep their other
 *     sessions, so nothing extra ends.
 *   - `/revoke-other-sessions`, the sessions panel's button.
 *   - `/revoke-sessions`. It is closed over HTTP (F-06, `AUTH_DISABLED_PATHS`)
 *     but still reachable as `auth.api.revokeSessions`, and it is the same
 *     sweep, so it gets the same rule if anyone reopens it.
 *
 * The other endpoints that end sessions are handled elsewhere: a password reset
 * in `onPasswordReset` (`src/lib/auth.ts`), and the admin ban, revoke-all and
 * set-password in the wrappers in `src/lib/admin/auth-admin.server.ts`.
 * `/revoke-session` deletes one session and only when it belongs to the
 * caller, so an impersonation session never qualifies.
 *
 * Bearer credentials are NOT revoked here, unlike a reset. Changing the password
 * requires the current one, which a cookie thief does not have, and the form
 * sweeps on every change. Revoking keys would break the user's integrations on
 * every routine change. The reset is the compromise path and does revoke them
 * (`credential-eviction.server.ts`).
 */

/** Always-sweeping endpoints (see the module doc for `/change-password`). */
export const OWN_SESSION_SWEEP_PATHS: readonly string[] = [
  "/revoke-other-sessions",
  "/revoke-sessions",
];

/** True when `path` + `body` describe a user ending their own other sessions. */
export function isOwnSessionSweep(path: string | undefined, body: unknown): boolean {
  if (typeof path !== "string") return false;
  if (OWN_SESSION_SWEEP_PATHS.includes(path)) return true;
  return (
    path === "/change-password" &&
    typeof body === "object" &&
    body !== null &&
    (body as { revokeOtherSessions?: unknown }).revokeOtherSessions === true
  );
}

/**
 * The app's single `hooks.after` middleware. Better Auth accepts only one, and
 * runs it for HTTP requests and for `auth.api.*` calls alike.
 *
 * It acts only after a SUCCESSFUL sweep: a wrong current password, a stale
 * session or any other refusal leaves `returned` as an `APIError` and nothing
 * more ends. The caller comes from `ctx.context.session`, which the endpoint's
 * session middleware set. An impersonated session is skipped. Over HTTP the
 * `hooks.before` guard already refuses it these endpoints (IMP-3), and on a
 * server-side call its user is the borrowed identity, not the person who asked.
 *
 * Best-effort, like the same step in `onPasswordReset`: the password has
 * already changed and the vendor's sweep has already run, so a failure is
 * logged and does not fail the request. The one-hour impersonation cap in
 * `getCurrentSession` still bounds anything that survives.
 */
export const endBorrowedSessionsAfterOwnSweep = createAuthMiddleware(async (ctx) => {
  if (!isOwnSessionSweep(ctx.path, ctx.body)) return;
  if (isAPIError(ctx.context.returned)) return;

  const session = ctx.context.session;
  const userId = session?.user.id;
  if (!userId || readImpersonatorId(session)) return;

  try {
    // Lazy, like the reset hook: keeps the server-only module out of the auth
    // instance's static import graph. The endpoint's own context carries the
    // adapter, so this never reaches back into `@/lib/auth`.
    const { revokeSessionsImpersonatedBy } = await import("@/lib/impersonation-sessions.server");
    await revokeSessionsImpersonatedBy(userId, ctx.context);
  } catch (error) {
    const { logServerError } = await import("@/lib/observability/logger.server");
    logServerError("could not end impersonation sessions after a session sweep", {
      err: error,
      betterAuthUserId: userId,
      path: ctx.path,
    });
  }
});
