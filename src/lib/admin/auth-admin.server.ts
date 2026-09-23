import "server-only";
import { headers as nextHeaders } from "next/headers";
import { APIError } from "better-auth/api";
import { revokeBearerCredentialsOf } from "@/lib/api-auth/credential-eviction.server";
import { auth } from "@/lib/auth";
import { EMAIL_VERIFICATION_WAIVED_FIELD } from "@/lib/auth-verification-waiver";
import { withTrustedClientIp } from "@/lib/client-ip";
import { revokeSessionsImpersonatedBy } from "@/lib/impersonation-sessions.server";

/**
 * Server-side wrappers around Better Auth's user administration
 * (docs/admin-manager.md §4 + §5.3). Centralizing these calls:
 *
 *   - Hides Better Auth's shapes behind a small, documented surface so
 *     route handlers stay declarative.
 *   - Keeps every write that ends a user's access in one place, so the
 *     containment steps (F-08, F-10) cannot be skipped by a new call site.
 *   - Lets us add cross-cutting behaviour later (rate-limit hooks,
 *     telemetry) in one place.
 *
 * Note on typing: the Better Auth shapes used here (`auth.api.*`, the internal
 * adapter on `auth.$context`) change between minor versions. We use the live
 * types and let TypeScript infer return types from them.
 */

/*
 * F-13 — THE APP'S GUARDS AUTHORIZE; THESE WRAPPERS ONLY EXECUTE.
 *
 * Every caller of this module is a route that has already authorized the
 * caller with the app's own guards: the permission catalog, credential scopes,
 * org scope (ADR-0001), rank (review #7) and the shared-target rule (AUTHZ-2).
 * Those guards accept API keys and JWTs as well as cookies. The wrappers used
 * to forward the caller's headers to the admin plugin's endpoints, which
 * authorize a second time against the COOKIE session they find there
 * (`adminMiddleware`: no session → 401, no Better Auth `admin` role → 403). So
 * a bearer caller passed every app check and then failed on every call: create
 * (`POST /users`, `POST /api/v1/users`, the MCP `createUser` tool), ban, unban,
 * restore, soft-delete, set-password, session list and revoke, and the bulk
 * variants, always as a 502. A cookie caller passed only because it also held
 * the vendor's coarser role; one without it failed the same way, on set-role
 * too. (Set-role never reached a bearer caller: it needs cross-org reach, and
 * every API key and JWT is bound to one org, MACHINE-2.)
 *
 * So these operations no longer ask the plugin to authorize anyone. They make
 * the same writes the vendor endpoints make, through Better Auth's own internal
 * adapter (`auth.$context`: its model and field mapping, its database hooks, its
 * secondary-storage handling), with the same side effects: a ban ends the
 * user's sessions, and a new password is hashed with Better Auth's hasher into
 * the credential account, which is created if missing. Cookie and bearer
 * callers take the same path, so the two cannot drift. The wrappers take no
 * caller credentials at all, which makes the contract structural.
 *
 * The vendor checks that were more than authorization are kept here: the
 * target must exist, the password length bounds come from Better Auth's
 * configuration, and nobody may ban themselves. The one vendor check with no
 * app twin, "who may mint the Better Auth `admin` role on create", is enforced
 * by the create routes with the role route's rule (cross-org reach, which only
 * a superadmin's cookie session has).
 *
 * `createUser` stays an endpoint call, made WITHOUT headers: the plugin treats
 * a call with no request and no headers as a trusted server call, and the
 * endpoint keeps its email normalization, duplicate check, hashing and the
 * endpoint context that `user.validateUserInfo` needs.
 *
 * Impersonation (start and stop) and the reset email still forward the
 * caller's headers to the vendor endpoints. They read or set the caller's
 * cookies, so they are cookie-session operations by nature, and the
 * impersonate route refuses a caller without that cookie session.
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
 * primary write succeeded (a refused ban must not sign anyone out).
 *
 * A failure propagates: the route then reports the action as failed (502 +
 * failure audit) and the operator retries. Every one of these actions is
 * idempotent, and reporting success while the borrowed session lives on is
 * the defect itself. For a ban, the impersonation reach check
 * (`listImpersonationReachableOrgIds`) fails closed on its own as well.
 */

/**
 * The forwarded headers for the vendor calls that still act on the caller's
 * cookies (impersonation, the reset email). A stamped COPY: `/api/administrator/*`
 * is outside the proxy matcher, so the trusted client-IP header Better Auth
 * reads for `session.ipAddress` (impersonation creates a session) is derived
 * HERE from the trusted hop and never taken from the caller (review #35). The
 * ambient `next/headers()` store, the fallback for RSC callers that pass no
 * handle, is stamped the same way.
 */
function asActorHeaders(input?: Headers | { headers: Headers }): Headers | undefined {
  if (!input) return undefined;
  return input instanceof Headers ? input : input.headers;
}

async function actorHeaders(input?: Headers | { headers: Headers }): Promise<Headers> {
  // `next/headers()` is async in Next 15+.
  const source = asActorHeaders(input) ?? (await nextHeaders());
  return withTrustedClientIp(source);
}

/** Better Auth's context: the internal adapter and the password hasher. */
async function authContext() {
  return auth.$context;
}

type AuthContext = Awaited<ReturnType<typeof authContext>>;

/**
 * The target's Better Auth row, or the vendor's own `USER_NOT_FOUND` refusal.
 * Every vendor endpoint looked the user up before writing; an update of a
 * missing row would otherwise "succeed" with nothing written.
 */
async function requireBetterAuthUser(ctx: AuthContext, userId: string) {
  const user = await ctx.internalAdapter.findUserById(userId);
  if (!user) {
    throw new APIError("NOT_FOUND", { message: "User not found", code: "USER_NOT_FOUND" });
  }
  return user;
}

/* -------------------------------------------------------------------------- */
/*  Users                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateUserParams {
  email: string;
  password: string;
  name?: string;
  /**
   * The Better Auth role. `admin` is a platform role, so the create routes
   * allow it only to a caller with cross-org reach, like `POST …/role` (F-13):
   * this call is made without headers, so the plugin no longer checks it.
   *
   * There is deliberately no free-form `data` passthrough. Without headers the
   * plugin also skips its checks on `data.role` (used when `role` is absent)
   * and on the ban fields, and the adapter writes whatever `data` holds, so a
   * passthrough would be an unguarded way to mint the role, pre-ban a user or
   * clear the F-03 marker. The wrapper builds `data` itself.
   */
  role?: "admin" | "user";
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

/**
 * Creates the Better Auth user and its credential account.
 *
 * F-13: called WITHOUT headers, which the plugin treats as a trusted server
 * call. With the caller's headers it demanded a cookie session holding the
 * Better Auth `admin` role, so every API key, JWT and MCP agent that the
 * route had authorized got a 502.
 */
export async function createBetterAuthUser(params: CreateUserParams) {
  return auth.api.createUser({
    body: {
      email: params.email,
      password: params.password,
      name: params.name ?? params.email,
      role: params.role,
      // Programmatically-provisioned users (admin console + machine API) are
      // created pre-verified so they can sign in without the self-sign-up
      // email verification round trip (AUTH-4). Public self-registration
      // still verifies. Unless the creator has cross-org reach, the
      // pre-verification is also marked as having no mailbox proof (F-03),
      // which refuses provider linking into the account until the owner
      // proves the mailbox. These two fields are ALL of `data`: nothing the
      // caller passes is spread in (see `CreateUserParams.role`).
      data: {
        emailVerified: true,
        [EMAIL_VERIFICATION_WAIVED_FIELD]: params.emailUnproven ?? true,
      },
    },
  });
}

export interface UpdateUserParams {
  userId: string;
  /**
   * Only the display name. The adapter writes whatever it is given, so the
   * type is the allow-list: role, ban and email fields have their own
   * wrappers and guards.
   */
  data: { name: string };
}

/**
 * Mirrors an admin's display-name edit to Better Auth (F-14). This used to
 * call `auth.api.updateUser`, which is the SELF-SERVICE `/update-user`
 * endpoint: it updates the caller's own session user and ignores `userId`, so
 * the edit never reached the target.
 */
export async function updateBetterAuthUser(params: UpdateUserParams) {
  const ctx = await authContext();
  await requireBetterAuthUser(ctx, params.userId);
  return ctx.internalAdapter.updateUser(params.userId, { name: params.data.name });
}

export interface SetUserRoleParams {
  userId: string;
  role: "admin" | "user";
}

export async function setBetterAuthUserRole(params: SetUserRoleParams) {
  const ctx = await authContext();
  await requireBetterAuthUser(ctx, params.userId);
  const user = await ctx.internalAdapter.updateUser(params.userId, { role: params.role });
  return { user };
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
 * Force-sets a user's password. The password is hashed with Better Auth's
 * hasher and never logged or echoed by this helper or its call-sites. Like
 * Better Auth's own endpoint, it bounds the length by Better Auth's
 * configuration and creates the credential account when the user has none
 * (a social-only user).
 *
 * Replacing a password is how an operator responds to a compromise, and the
 * route cannot tell that case from a routine one. So once the new password is
 * stored, this ends everything that authenticated with the old one:
 *
 *   - every session of the user's own (F-10). Better Auth's `setUserPassword`
 *     deleted none, so a browser already signed in as the user, possibly an
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
 *
 * `actor` is the route's request. It is not an authority (F-13); it only
 * gives the credential revocations' audit rows the request's IP, user agent
 * and F-07 attribution.
 */
export async function setBetterAuthUserPassword(
  params: SetUserPasswordParams,
  actor?: Headers | { headers: Headers },
) {
  const ctx = await authContext();
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (params.newPassword.length < minPasswordLength) {
    throw new APIError("BAD_REQUEST", {
      message: "Password too short",
      code: "PASSWORD_TOO_SHORT",
    });
  }
  if (params.newPassword.length > maxPasswordLength) {
    throw new APIError("BAD_REQUEST", { message: "Password too long", code: "PASSWORD_TOO_LONG" });
  }
  const user = await requireBetterAuthUser(ctx, params.userId);
  const hashedPassword = await ctx.password.hash(params.newPassword);
  if (await ctx.internalAdapter.findCredentialAccount(params.userId)) {
    await ctx.internalAdapter.updatePassword(params.userId, hashedPassword);
  } else {
    await ctx.internalAdapter.createAccount({
      userId: params.userId,
      providerId: "credential",
      accountId: user.id,
      password: hashedPassword,
    });
  }

  await revokeAllBetterAuthUserSessions(params.userId);
  await revokeBearerCredentialsOf({
    betterAuthUserId: params.userId,
    trigger: "password_set",
    actorBetterAuthUserId: params.setBy.betterAuthUserId,
    revokedByAppUserId: params.setBy.appUserId,
    // The route's own request, not a stamped copy: F-07 attribution is keyed
    // on the original `Headers` object.
    request: { headers: asActorHeaders(actor) ?? (await nextHeaders()) },
    requestId: params.setBy.requestId,
  });
  return { status: true };
}

export interface BanUserParams {
  userId: string;
  banReason?: string;
  /** Seconds from now until the ban expires; omit for indefinite. */
  banExpiresIn?: number;
  /**
   * The Better Auth id of the caller the route authorized (`guard.betterAuthUserId`).
   * Nobody may ban themselves: Better Auth's endpoint refused it, and a ban is
   * account-global, so it would lock the caller out of every tenant.
   */
  actorBetterAuthUserId: string;
}

/**
 * Bans a user in Better Auth, deletes their own sessions, and ends the
 * sessions they opened as someone else (F-08). Used by `POST …/ban`, the
 * soft-delete of `DELETE /users/[id]` and both through `POST /users/bulk`.
 */
export async function banBetterAuthUser(params: BanUserParams) {
  const ctx = await authContext();
  await requireBetterAuthUser(ctx, params.userId);
  if (params.userId === params.actorBetterAuthUserId) {
    throw new APIError("BAD_REQUEST", {
      message: "You cannot ban yourself",
      code: "YOU_CANNOT_BAN_YOURSELF",
    });
  }
  const user = await ctx.internalAdapter.updateUser(params.userId, {
    banned: true,
    // Better Auth's own defaults; every route passes a reason.
    banReason: params.banReason || "No reason",
    banExpires: params.banExpiresIn ? new Date(Date.now() + params.banExpiresIn * 1000) : null,
    updatedAt: new Date(),
  });
  await ctx.internalAdapter.deleteUserSessions(params.userId);
  await revokeSessionsImpersonatedBy(params.userId);
  return { user };
}

export async function unbanBetterAuthUser(userId: string) {
  const ctx = await authContext();
  await requireBetterAuthUser(ctx, userId);
  const user = await ctx.internalAdapter.updateUser(userId, {
    banned: false,
    banExpires: null,
    banReason: null,
    updatedAt: new Date(),
  });
  return { user };
}

/* -------------------------------------------------------------------------- */
/*  Sessions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The user's session rows, `token` included: the routes resolve a revoke by
 * id to its token with them and project everything else away before it
 * leaves the server (`session-item.ts`, review #67/#194).
 */
export async function listBetterAuthUserSessions(userId: string) {
  const ctx = await authContext();
  return { sessions: await ctx.internalAdapter.listSessions(userId) };
}

export async function revokeBetterAuthUserSession(sessionToken: string) {
  const ctx = await authContext();
  await ctx.internalAdapter.deleteSession(sessionToken);
  return { success: true };
}

/**
 * "Sign out everywhere": every session of the user, including the ones they
 * opened as someone else (F-08) — otherwise the operator containing a
 * compromised admin ends everything but the session doing the damage.
 */
export async function revokeAllBetterAuthUserSessions(userId: string) {
  const ctx = await authContext();
  await ctx.internalAdapter.deleteUserSessions(userId);
  await revokeSessionsImpersonatedBy(userId);
  return { success: true };
}

/* -------------------------------------------------------------------------- */
/*  Impersonation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Begins an impersonation session: Better Auth issues a new session
 * cookie for the target user while remembering the original actor in
 * `session.impersonatedBy` so {@link stopBetterAuthImpersonating} can
 * restore the actor's session. It acts on the actor's own cookie session,
 * which the route has checked is the principal its guards evaluated (F-02).
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
  });
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
  });
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
  });
}
