import "server-only";
import type { AuthContext } from "better-auth";

/**
 * Ends every session a user has opened AS SOMEONE ELSE (F-08).
 *
 * An impersonation session belongs to the TARGET: Better Auth stores it with
 * `userId` = the borrowed identity and records the admin behind it only in
 * `impersonatedBy`. Every vendor call that ends "a user's sessions" —
 * `banUser`, `revokeUserSessions`, the `revokeSessionsOnPasswordReset`
 * sweep — deletes by `userId`, so none of them touches the sessions that user
 * is driving as other people. Banning a compromised superadmin, revoking all
 * of their sessions or resetting their password therefore left their borrowed
 * session alive, acting with the target's authority and invisible on the
 * admin's own Sessions tab.
 *
 * So every containment path calls this after the vendor call succeeds: the
 * admin wrappers in `src/lib/admin/auth-admin.server.ts` (ban, which the
 * soft-delete sagas reuse; revoke-all; set-password) and the password-reset
 * hook in `src/lib/auth.ts`. The session row's
 * `impersonatedBy` is the only link from an admin to a borrowed session, and
 * Better Auth has no API that deletes by it, so this is the one definition.
 *
 * The delete goes through Better Auth's own adapter (not Kysely, which types
 * the `session` table read-only on purpose), so the model and field mapping
 * are the vendor's. It deletes rather than expires: this app keeps sessions
 * in the database only (no `secondaryStorage`), which is exactly the storage
 * `adapter.deleteMany` addresses.
 *
 * Throws on failure. Callers decide whether a failure fails their action: the
 * admin wrappers let it propagate so the route reports the containment as
 * failed and the operator retries (every caller is idempotent); the reset
 * hook, which cannot un-reset a password, catches and logs.
 *
 * `context` is injectable for the behavioural tests; production callers omit
 * it and get the app's instance.
 *
 * @returns the number of sessions deleted.
 */
export async function revokeSessionsImpersonatedBy(
  impersonatorBetterAuthUserId: string,
  context?: Pick<AuthContext, "adapter">,
): Promise<number> {
  // An empty id would match nothing today, but a bug upstream must never be
  // one adapter quirk away from a sweeping delete.
  if (!impersonatorBetterAuthUserId) return 0;

  // Lazy, like `isBetterAuthUserBanned`: keeps the Better Auth instance (and
  // the pg pool it opens at module load) out of the static import graph of
  // every admin route, and lets `auth.ts` call this from inside its own
  // configuration without an import cycle.
  const ctx = context ?? (await (await import("@/lib/auth")).auth.$context);
  return ctx.adapter.deleteMany({
    model: "session",
    where: [{ field: "impersonatedBy", value: impersonatorBetterAuthUserId }],
  });
}
