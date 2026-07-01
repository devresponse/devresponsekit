import "server-only";
import { headers as nextHeaders } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Server-side wrappers around the Better Auth `admin()` plugin
 * (docs/admin-manager.md §4 + §5.3). Centralizing these calls:
 *
 *   - Hides the `auth.api.*` shape behind a small, documented surface so
 *     route handlers stay declarative.
 *   - Forwards the incoming request's headers to Better Auth so cookie /
 *     IP / user-agent context is preserved (impersonation in particular
 *     refuses to operate without a valid actor session).
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

function asActorHeaders(input?: Headers | { headers: Headers }): Headers | undefined {
  if (!input) return undefined;
  return input instanceof Headers ? input : input.headers;
}

async function actorHeaders(input?: Headers | { headers: Headers }): Promise<Headers> {
  const provided = asActorHeaders(input);
  if (provided) return provided;
  // Fall back to the ambient request headers for RSC callers that did
  // not pass an explicit handle. `next/headers()` is async in Next 15+.
  return await nextHeaders();
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
      // created pre-verified: the caller is a trusted admin / API credential
      // that vouches for the address, so they bypass the self-sign-up email
      // verification gate (AUTH-4). Public self-registration still verifies.
      // A caller may override by passing `data.emailVerified`.
      data: { emailVerified: true, ...params.data },
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
}

/**
 * Force-sets a user's password. The password is forwarded to Better
 * Auth and never logged or echoed by this helper or its call-sites.
 */
export async function setBetterAuthUserPassword(
  params: SetUserPasswordParams,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.setUserPassword({
    body: { userId: params.userId, newPassword: params.newPassword },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.setUserPassword>[0]);
}

export interface BanUserParams {
  userId: string;
  banReason?: string;
  /** Seconds from now until the ban expires; omit for indefinite. */
  banExpiresIn?: number;
}

export async function banBetterAuthUser(
  params: BanUserParams,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.banUser({
    body: {
      userId: params.userId,
      banReason: params.banReason,
      banExpiresIn: params.banExpiresIn,
    },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.banUser>[0]);
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

export async function revokeAllBetterAuthUserSessions(
  userId: string,
  actor?: Headers | { headers: Headers },
) {
  return auth.api.revokeUserSessions({
    body: { userId },
    headers: await actorHeaders(actor),
  } as Parameters<typeof auth.api.revokeUserSessions>[0]);
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
 * (plan §4 / §5.2). The actor's request headers are forwarded so Better
 * Auth's CSRF / origin checks pass.
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
