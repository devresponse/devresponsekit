/**
 * Pure reader for the impersonation marker on a Better Auth session.
 *
 * Better Auth's admin plugin stamps `impersonatedBy` onto the session row
 * when an admin starts impersonating; different plugin versions camel- or
 * snake-case the field, so both shapes are accepted. Kept free of
 * `server-only` / Next imports so BOTH the session guard (`auth-guard.ts`)
 * and the unified caller resolver (`resolve-caller.server.ts`) can share
 * one definition without dragging the auth instance into the resolver's
 * import graph (review #28: the account guard now surfaces the marker so a
 * consumer can refuse an impersonated session without a second session
 * lookup).
 */
export function readImpersonatorId(session: unknown): string | null {
  if (!session || typeof session !== "object") return null;
  const sess = (session as { session?: Record<string, unknown> }).session;
  const value = sess?.impersonatedBy ?? sess?.impersonated_by ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}
