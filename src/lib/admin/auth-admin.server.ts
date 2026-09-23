import "server-only";
import { headers as nextHeaders } from "next/headers";
import { revokeBearerCredentialsOf } from "@/lib/api-auth/credential-eviction.server";
import { auth } from "@/lib/auth";
import { EMAIL_VERIFICATION_WAIVED_FIELD } from "@/lib/auth-verification-waiver";
import { withTrustedClientIp } from "@/lib/client-ip";
import { revokeSessionsImpersonatedBy } from "@/lib/impersonation-sessions.server";

/**
 * Server-side wrappers around the Better Auth `admin()` plugin
 * (docs/admin-manager.md §4 + §5.3). Centralizing these calls:
 *
 *   - Hides the `auth.api.*` shape behind a small, documented surface so
 *     route handlers stay declarative.
 *   - Forwards the incoming request's headers to Better Auth so cookie /
 *     IP / user-agent context is preserved (impersonation in particular
 *     refuses to operate without a valid actor session). The forwarded copy
 *     ALWAYS carries the trusted client-IP header (`withTrustedClientIp`,
 *     review #35): `/api/administrator/*` is outside the proxy matcher, so
 *     the header Better Auth reads for `session.ipAddress` (impersonation
 *     creates a session) is derived HERE from the trusted hop — an actor
 *     cannot inject it, and the ambient `next/headers()` store is stamped
 *     the same way.
 *   - Lets us add cross-cutting behaviour later (rate-limit hooks,
 *     telemetry) in one place.
 *
 * These helpers accept the actor's `Headers` explicitly rather than
 * pulling from `next/headers()` themselves so they remain usable from
 * non-RSC contexts (route handlers, scripts).
 *
 * Note on typing: Better Auth's admin plugin types are exposed through
 * `auth.api` but its full shape changes between minor versions. We use
 * `await`-style call signatures that match the documented public API
 * without re-declaring them, and let TypeScript infer return types from
 * the live `auth.api` module.
 */

/*
 * F-08 — CONTAINMENT REACHES THE SESSIONS A USER OPENED AS SOMEONE ELSE.
 *
 * Better Auth ends "a user's sessions" by `userId`, and an impersonation
 * session carries the TARGET's id there (the admin behind it is only in
 * `impersonatedBy`). So banning, soft-deleting, revoking every session of, or
 * setting the password of a compromised admin left the session they were
 * driving as someone else alive — with that person's authority, and, for a
 * superadmin, with no tenant confinement. Each wrapper below that is a
 * containment action therefore also ends those borrowed sessions, AFTER the
 * vendor call succeeded (a refused ban must not sign anyone out).
 *
 * A failure propagates: the route then reports the action as failed (502 +
 * failure audit) and the operator retries. Every one of these actions is
 * idempotent, and reporting success while the borrowed session lives on is
 * the defect itself. For a ban, the impersonation reach check
 * (`listImpersonationReachableOrgIds`) fails closed on its own as well.
 */

function asActorHeaders(input?: Headers | { headers: Headers }): Headers | undefined {
  if (!input) return undefined;
  return input instanceof Headers ? input : input.headers;
}

async function actorHeaders(input?: Headers | { headers: Headers }): Promise<Headers> {
  // Fall back to the ambient request headers for RSC callers that did
  // not pass an explicit handle. `next/headers()` is async in Next 15+.
  const source = asActorHeaders(input) ?? (await nextHeaders());
  // A stamped COPY: the trusted client IP is (re)derived from the forwarded
  // chain, never taken from the caller (review #35).
  return withTrustedClientIp(source);
}

/* -------------------------------------------------------------------------- */
/*  Users                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateUserParams {
  email: string;
  password: string;
  name?: string;
  role?: "admin" | "user";
  data?: Record<string, unknown>;
  /**
   * F-03 — whether the address is WITHOUT mailbox proof. Defaults to `true`
   * (fail closed). Callers pass `false` only when the creator is trusted to
   * vouch for any address platform-wide (cross-org reach); an org admin's
   * say-so is not proof, and the marker keeps such an identity from being
   * linked to the real owner's Google or Microsoft sign-in until the mailbox
   * is proven (a password reset).
   */
  emailUnproven?: boolean;
}

export async function createBetterAuthUser(
  params: CreateUserParams,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.createUser({
    body: {
      email: params.email,
      password: params.password,
      name: params.name ?? params.email,
      role: params.role,
      // Programmatically-provisioned users (admin console + machine API) are
      // created pre-verified so they can sign in without the self-sign-up
      // email verification round trip (AUTH-4). Public self-registration
      // still verifies. A caller may override by passing `data.emailVerified`.
      // Unless the creator has cross-org reach, the pre-verification is also
      // marked as having no mailbox proof (F-03), which refuses provider
      // linking into the account until the owner proves the mailbox.
      data: {
        emailVerified: true,
        [EMAIL_VERIFICATION_WAIVED_FIELD]: params.emailUnproven ?? true,
        ...params.data,
      },
    },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.createUser>[0]);
}

export interface UpdateUserParams {
  userId: string;
  data: Record<string, unknown>;
}

export async function updateBetterAuthUser(
  params: UpdateUserParams,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.updateUser({
    body: { userId: params.userId, data: params.data },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.updateUser>[0]);
}

export interface SetUserRoleParams {
  userId: string;
  role: "admin" | "user";
}

export async function setBetterAuthUserRole(
  params: SetUserRoleParams,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.setRole({
    body: { userId: params.userId, role: params.role },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.setRole>[0]);
}

export interface SetUserPasswordParams {
  userId: string;
  newPassword: string;
  /**
   * The administrator setting it (F-10). The user's bearer credentials are
   * revoked in their name: `appUserId` goes to `revoked_by` (null falls back
   * to the user), `betterAuthUserId` is the audit actor, and `requestId`
   * correlates those rows with the route's own.
   */
  setBy: { betterAuthUserId: string; appUserId: string | null; requestId?: string | null };
}

/**
 * Force-sets a user's password. The password is forwarded to Better
 * Auth and never logged or echoed by this helper or its call-sites.
 *
 * Replacing a password is how an operator responds to a compromise, and the
 * route cannot tell that case from a routine one. So after Better Auth accepts
 * the new password, this ends everything that authenticated with the old one:
 *
 *   - every session of the user's own (F-10). Better Auth's `setUserPassword`
 *     deletes none, so a browser already signed in as the user, possibly an
 *     attacker's, used to keep its authority;
 *   - the sessions the user opened as someone else (F-08). Both steps go
 *     through {@link revokeAllBetterAuthUserSessions}, the same containment as
 *     "revoke all sessions";
 *   - every API key the user owns and every OAuth client that acts as them
 *     (F-10), the same cut-off as a completed password reset
 *     (`revokeBearerCredentialsOf`). A key minted with a stolen cookie would
 *     otherwise outlive the new password. The sessions go FIRST, so a key
 *     being minted by one of them at that moment is refused by the issuance
 *     fence (`issuance-fence.server.ts`) instead of outliving the cut-off.
 *
 * A failure at any step propagates, so the route reports the action as failed
 * and the operator retries. Every step is idempotent.
 */
export async function setBetterAuthUserPassword(
  params: SetUserPasswordParams,
  actor?: Headers | { headers: Headers },
) {
  const result = await auth.api.setUserPassword({
    body: { userId: params.userId, newPassword: params.newPassword },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.setUserPassword>[0]);
  await revokeAllBetterAuthUserSessions(params.userId, actor);
  await revokeBearerCredentialsOf({
    betterAuthUserId: params.userId,
    trigger: "password_set",
    actorBetterAuthUserId: params.setBy.betterAuthUserId,
    revokedByAppUserId: params.setBy.appUserId,
    // The route's own request, not the stamped copy: F-07 attribution is
    // keyed on the original `Headers` object.
    request: { headers: asActorHeaders(actor) ?? (await nextHeaders()) },
    requestId: params.setBy.requestId,
  });
  return result;
}

export interface BanUserParams {
  userId: string;
  banReason?: string;
  /** Seconds from now until the ban expires; omit for indefinite. */
  banExpiresIn?: number;
}

/**
 * Bans a user in Better Auth, which deletes their own sessions, and ends the
 * sessions they opened as someone else (F-08). Used by `POST …/ban`, the
 * soft-delete of `DELETE /users/[id]` and both through `POST /users/bulk`.
 */
export async function banBetterAuthUser(
  params: BanUserParams,
  actor?: Headers | { headers: Headers },
) {
  const result = await auth.api.banUser({
    body: {
      userId: params.userId,
      banReason: params.banReason,
      banExpiresIn: params.banExpiresIn,
    },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.banUser>[0]);
  await revokeSessionsImpersonatedBy(params.userId);
  return result;
}

export async function unbanBetterAuthUser(userId: string, actor?: Headers | { headers: Headers }) {
  return auth.api.unbanUser({
    body: { userId },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.unbanUser>[0]);
}

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                  */
/* -------------------------------------------------------------------------- */

export async function listBetterAuthUserSessions(
  userId: string,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.listUserSessions({
    body: { userId },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.listUserSessions>[0]);
}

export async function revokeBetterAuthUserSession(
  sessionToken: string,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.revokeUserSession({
    body: { sessionToken },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.revokeUserSession>[0]);
}

/**
 * "Sign out everywhere": every session of the user, including the ones they
 * opened as someone else (F-08) — otherwise the operator containing a
 * compromised admin ends everything but the session doing the damage.
 */
export async function revokeAllBetterAuthUserSessions(
  userId: string,
  actor?: Headers | { headers: Headers },
) {
  const result = await auth.api.revokeUserSessions({
    body: { userId },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.revokeUserSessions>[0]);
  await revokeSessionsImpersonatedBy(userId);
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Impersonation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Begins an impersonation session: Better Auth issues a new session
 * cookie for the target user while remembering the original actor in
 * `session.impersonatedBy` so {@link stopBetterAuthImpersonating} can
 * restore the actor's session.
 *
 * Caller MUST gate this behind `admin.users.impersonate` and the
 * UI MUST require a double-confirm — see docs/admin-manager.md §19
 * Phase 7. Audit on both success and failure.
 */
export async function impersonateBetterAuthUser(
  userId: string,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.impersonateUser({
    body: { userId },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.impersonateUser>[0]);
}

/**
 * Ends an active impersonation session and restores the original
 * actor's session. Safe to call when no impersonation is active —
 * Better Auth returns a no-op error which callers may surface to the
 * UI as "nothing to do".
 */
export async function stopBetterAuthImpersonating(actor?: Headers | { headers: Headers }) {
  return auth.api.stopImpersonating({
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.stopImpersonating>[0]);
}

/* -------------------------------------------------------------------------- */
/*  Password reset                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Triggers Better Auth's password-reset email flow for the given email.
 * Used by the "Send reset email" mode of the set-password endpoint
 * (docs/admin-manager.md §8.1). The actor's request headers are forwarded
 * so Better Auth's CSRF / origin checks pass.
 */
export async function sendBetterAuthPasswordResetEmail(
  email: string,
  redirectTo?: string,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.requestPasswordReset({
    body: { email, redirectTo },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.requestPasswordReset>[0]);
}
