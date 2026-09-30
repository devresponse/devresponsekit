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
 * (docs/configuration.md), after which every session-reading path treats the
 * session as gone and the user signs in again: `getCurrentSession` (and
 * therefore every browser guard, server action and `/api/v1` cookie caller),
 * and since F-54 Better Auth's own `/api/auth/*` endpoints, through the
 * `hooks.before` in `auth-admin-surface.ts` ({@link isSessionPastLifetime}).
 *
 * The bound on a session an SSO handoff opened on a consumer is NOT opt-in
 * (F-82): such a session ends `SSO_SESSION_LIFETIME_HOURS` (default 8) after
 * the handoff whatever its activity, so a user blocked on the primary, or whose
 * app was disabled there, goes back through a launch that re-checks both
 * ({@link isSsoSessionPastLifetime}).
 *
 * Pure (its one import is the equally pure impersonation-marker reader) so the
 * rule can be unit-tested at the boundaries without standing up Better Auth.
 * The satellite forks copy this file with `auth-sso-session.ts`, which mints
 * the tokens {@link isSsoHandoffSession} recognises.
 */
import { readImpersonatorId } from "@/lib/impersonation";

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
 * at the app's session chokepoint (`getCurrentSession`) and, since F-54, on
 * `/api/auth/*` too, so `/get-session` no longer extends a borrowed session
 * past it.
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

/**
 * How long a session opened by an SSO handoff may live, in hours from the
 * handoff (F-82). The env schema defaults `SSO_SESSION_LIFETIME_HOURS` to it,
 * and {@link isSsoSessionPastLifetime} falls back to it, so a fork that ports
 * this file without the variable still gets the bound.
 *
 * Eight hours is the revocation lag the satellite docs always promised for
 * Options A and B. It did not hold: the handoff opened an ordinary rolling
 * session, refreshed every 15 minutes of use, so a user blocked on the primary,
 * or whose app the operator disabled, kept a separate-store satellite session
 * for as long as they kept using it. The bound makes the next launch, which
 * re-checks the app and the user on the primary, happen at least this often.
 */
export const DEFAULT_SSO_SESSION_LIFETIME_HOURS = 8;

/**
 * The first characters of every session token `createSsoSession` mints
 * (`auth-sso-session.ts`), and of no other: Better Auth's own tokens are 32
 * letters and digits, so none carries a dot, let alone this prefix (F-82). The
 * token is the one field of the vendor's `session` row the app can set without
 * a schema change, and it never changes after creation (a refresh moves only
 * `expiresAt`), so use cannot shed the mark.
 */
export const SSO_SESSION_TOKEN_PREFIX = "sso.";

/**
 * The token prefix of the sessions a handoff for `applicationId` opens:
 * `sso.<application id in lowercase hex>.` (F-82). Hex, because an application
 * id may carry `.` and `_` (`acme.crm`, `a_b`): written plainly, `sso.acme.`
 * would also be a prefix of `acme.crm`'s tokens, and `_` is a `LIKE` wildcard
 * in the `starts_with` match that ends an application's sessions
 * (`endSsoHandoffsOfApplication`). Hex digits are neither, and the closing dot
 * ends the id.
 */
export function ssoSessionTokenPrefix(applicationId: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(applicationId)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${SSO_SESSION_TOKEN_PREFIX}${hex}.`;
}

/** True when the session row was opened by an SSO handoff ({@link SSO_SESSION_TOKEN_PREFIX}). */
export function isSsoHandoffSession(session: { token?: unknown } | null | undefined): boolean {
  return typeof session?.token === "string" && session.token.startsWith(SSO_SESSION_TOKEN_PREFIX);
}

/**
 * True when a session opened by an SSO handoff is `lifetimeHours` old or older
 * (F-82). A missing or non-positive `lifetimeHours` means
 * {@link DEFAULT_SSO_SESSION_LIFETIME_HOURS}, never "no cap". Like the
 * impersonation cap, and unlike the opt-in operator cap, it FAILS CLOSED on a
 * creation time it cannot read: the bound exists so that such a session
 * cannot live forever.
 */
export function isSsoSessionPastLifetime(
  session: SessionAgeInput | null | undefined,
  lifetimeHours: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const hours =
    typeof lifetimeHours === "number" && Number.isFinite(lifetimeHours) && lifetimeHours > 0
      ? lifetimeHours
      : DEFAULT_SSO_SESSION_LIFETIME_HOURS;

  const createdAt = session?.createdAt;
  if (createdAt === null || createdAt === undefined) return true;

  const createdMs = (createdAt instanceof Date ? createdAt : new Date(createdAt)).getTime();
  if (Number.isNaN(createdMs)) return true;

  return nowMs - createdMs >= hours * 60 * 60 * 1000;
}

/** The operator settings {@link isSessionPastLifetime} reads, as `getServerEnv()` names them. */
export interface SessionLifetimeSettings {
  SESSION_ABSOLUTE_LIFETIME_HOURS?: number | null;
  SSO_SESSION_LIFETIME_HOURS?: number | null;
}

/**
 * True when a resolved session (`{ session, user }`, as Better Auth returns
 * it) has outlived any bound above: the operator's absolute lifetime, the
 * one-hour cap on an impersonation session, or the lifetime of a session an
 * SSO handoff opened (F-82).
 *
 * The ONE rule both enforcement points apply (F-54): `getCurrentSession` for
 * everything the app itself serves, and the Better Auth `hooks.before`
 * (`rejectClosedAuthEndpoints`) for the vendor's own `/api/auth/*` endpoints,
 * which never pass through the app's guards and would otherwise keep honouring
 * and refreshing a session the app has already declared over. Both pass
 * `getServerEnv()` as `settings`.
 */
export function isSessionPastLifetime(
  // `impersonatedBy` (either casing) is the admin plugin's marker; see `readImpersonatorId`.
  // `token` carries the handoff mark; see `isSsoHandoffSession`.
  session: {
    session: SessionAgeInput & {
      token?: unknown;
      impersonatedBy?: unknown;
      impersonated_by?: unknown;
    };
  },
  settings: SessionLifetimeSettings,
  nowMs: number = Date.now(),
): boolean {
  return (
    isSessionPastAbsoluteLifetime(
      session.session,
      settings.SESSION_ABSOLUTE_LIFETIME_HOURS,
      nowMs,
    ) ||
    (readImpersonatorId(session) !== null &&
      isImpersonationSessionPastMaxAge(session.session, nowMs)) ||
    (isSsoHandoffSession(session.session) &&
      isSsoSessionPastLifetime(session.session, settings.SSO_SESSION_LIFETIME_HOURS, nowMs))
  );
}
