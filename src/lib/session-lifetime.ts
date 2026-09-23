/**
 * Absolute session lifetime (review #200, ASVS V3 "absolute timeout").
 *
 * Better Auth's `session.expiresIn` / `updateAge` give a ROLLING window: an
 * 8-hour session that is touched every 15 minutes is refreshed forever, so a
 * stolen cookie that keeps being used never ages out on its own. An absolute
 * lifetime caps the total age of a session measured from its CREATION,
 * regardless of activity.
 *
 * Default behaviour is UNCHANGED: `SESSION_ABSOLUTE_LIFETIME_HOURS` is unset
 * out of the box, which means "no absolute cap" — exactly what shipped before
 * this knob existed. An operator opts in by setting a number of hours
 * (docs/configuration.md), after which every session-reading path
 * (`getCurrentSession`, and therefore every browser guard, server action and
 * `/api/v1` cookie caller) treats the session as gone and the user signs in
 * again.
 *
 * Pure and dependency-free so the rule can be unit-tested at the boundaries
 * without standing up Better Auth.
 */

/** The single field of a session row this rule reads. */
export interface SessionAgeInput {
  createdAt?: Date | string | number | null;
}

/**
 * True when the session was created longer ago than the configured absolute
 * lifetime and must therefore be refused.
 *
 * Returns `false` — i.e. "keep the session" — when:
 *   - `absoluteLifetimeHours` is undefined/null (the shipped default: no cap),
 *     or is not a positive finite number;
 *   - the row carries no usable `createdAt`. A session whose creation time we
 *     cannot read is left to the rolling expiry rather than being killed on a
 *     guess; the env schema and Better Auth both guarantee the field in
 *     practice, so this is a belt-and-braces branch, not a policy.
 */
export function isSessionPastAbsoluteLifetime(
  session: SessionAgeInput | null | undefined,
  absoluteLifetimeHours: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (
    absoluteLifetimeHours === null ||
    absoluteLifetimeHours === undefined ||
    !Number.isFinite(absoluteLifetimeHours) ||
    absoluteLifetimeHours <= 0
  ) {
    return false;
  }

  const createdAt = session?.createdAt;
  if (createdAt === null || createdAt === undefined) return false;

  const createdMs = (createdAt instanceof Date ? createdAt : new Date(createdAt)).getTime();
  if (Number.isNaN(createdMs)) return false;

  return nowMs - createdMs >= absoluteLifetimeHours * 60 * 60 * 1000;
}

/**
 * The longest an IMPERSONATION session may live, measured from its creation
 * (F-08). Fixed, not an operator knob: it is the support window the product
 * promises, and nothing legitimate needs a borrowed identity for longer.
 *
 * Better Auth is told the same number (`impersonationSessionDuration` in
 * `ADMIN_PLUGIN_OPTIONS`), but there it is only the row's INITIAL `expiresAt`.
 * The plugin skips the rolling refresh only while the signed `dont_remember`
 * cookie rides along; a holder who drops that cookie and calls `/get-session`
 * gets the row pushed to now + 8 h, every 15 minutes, indefinitely. So the
 * cap that actually holds is {@link isImpersonationSessionPastMaxAge}, applied
 * at the app's session chokepoint (`getCurrentSession`).
 */
export const IMPERSONATION_SESSION_MAX_AGE_SECONDS = 60 * 60;

/**
 * True when an impersonation session is older than
 * {@link IMPERSONATION_SESSION_MAX_AGE_SECONDS} and must be refused.
 *
 * Unlike {@link isSessionPastAbsoluteLifetime} this FAILS CLOSED: a borrowed
 * session whose creation time cannot be read is treated as over age. The
 * operator cap is opt-in and defaults to "keep"; this one is a security bound
 * on a privileged identity, so "unknown age" must not mean "unbounded".
 */
export function isImpersonationSessionPastMaxAge(
  session: SessionAgeInput | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const createdAt = session?.createdAt;
  if (createdAt === null || createdAt === undefined) return true;

  const createdMs = (createdAt instanceof Date ? createdAt : new Date(createdAt)).getTime();
  if (Number.isNaN(createdMs)) return true;

  return nowMs - createdMs >= IMPERSONATION_SESSION_MAX_AGE_SECONDS * 1000;
}
