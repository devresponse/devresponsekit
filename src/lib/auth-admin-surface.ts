import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { readImpersonatorId } from "@/lib/impersonation";

/**
 * Which Better Auth HTTP endpoints this app closes, and why.
 *
 * The catch-all `/api/auth/[...all]` mounts the vendor's endpoints with no
 * app-level guard, so anything the app does not want reachable has to be
 * refused here. Three policies:
 *
 *   - the admin plugin's whole surface (review 2026-09-04 #3, below);
 *   - vendor endpoints the app never uses, closed for everyone (F-06,
 *     {@link AUTH_DISABLED_PATHS}, passed as Better Auth's `disabledPaths`);
 *   - an IMPERSONATED session reaches nothing but the endpoints the borrowed
 *     shell needs (IMP-3, deny-by-default since F-06 — see
 *     {@link IMPERSONATION_ALLOWED_PATHS}).
 *
 * The first and the last are composed in {@link rejectClosedAuthEndpoints} at
 * the bottom of the file, because Better Auth accepts exactly ONE
 * `hooks.before` middleware. Every endpoint the vendor mounts is classified
 * against these lists by
 * tests/security/better-auth-endpoint-classification.test.ts, so a Better Auth
 * upgrade that adds one fails CI until someone decides where it belongs.
 *
 * ---
 *
 * Better Auth `admin()` plugin surface policy (review 2026-09-04 #3).
 *
 * Every admin-plugin endpoint (`/admin/list-users`, `/admin/set-user-password`,
 * `/admin/impersonate-user`, `/admin/set-role`, `/admin/remove-user`, ...) is
 * mounted on the public catch-all `/api/auth/[...all]` and, upstream, is gated
 * ONLY by the Better Auth `role=admin` flag: no app permission catalog, no
 * ADR-0001 org scoping, no privilege-escalation guard, no rate limit and no
 * app audit row. The application never uses that raw HTTP surface — the admin
 * console reaches the plugin exclusively through server-side `auth.api.*`
 * calls (`src/lib/admin/auth-admin.server.ts`) made by the guarded
 * `/api/administrator/users/[id]/*` routes, which layer all of the above on
 * top. But because those app routes forward the ACTOR's own session, an org
 * admin must hold the Better Auth `admin` role for the console to work at
 * all, and that same role would let them call the raw endpoints directly
 * (cross-tenant user enumeration, password reset or impersonation of a
 * superadmin). So the raw surface is closed here.
 *
 * Mechanism: a global `hooks.before` middleware. Better Auth runs the same
 * hook pipeline for HTTP traffic and for `auth.api.*` calls; the two are told
 * apart by `ctx.request`, which better-call's router sets from the incoming
 * `Request` and which a server-side `auth.api.*` call (headers + body, no
 * `request`) never carries. Rejecting with 404 (not 403) matches the
 * "404, not 403" posture of docs/admin-manager.md §6.2 and makes the surface
 * indistinguishable from an unmounted route.
 *
 * Invariant for callers: NEVER pass `request` to an `auth.api.*` admin call —
 * forward `headers` only (as `auth-admin.server.ts` does), or the guard will
 * treat the call as HTTP and refuse it.
 */
export const ADMIN_PLUGIN_ROUTE_PREFIX = "/admin/";

/** True for any endpoint path that belongs to the Better Auth admin plugin. */
export function isAdminPluginPath(path: string | undefined): boolean {
  return typeof path === "string" && path.startsWith(ADMIN_PLUGIN_ROUTE_PREFIX);
}

/**
 * Better Auth endpoints closed to EVERYONE over HTTP (F-06).
 *
 * Passed to Better Auth as `disabledPaths`, which its router answers with 404
 * in `onRequest`, before any hook or handler runs — the same "unmounted"
 * posture as the admin-plugin surface above. Each entry is vendor surface the
 * app never calls over HTTP (no `authClient` call, form or emailed link in
 * `src/` lands on it) that exposes or mutates identity state the app otherwise
 * guards:
 *
 *   - `/list-accounts`, `/get-access-token`, `/refresh-token`, `/account-info`
 *     enumerate the caller's provider accounts and hand back the stored
 *     provider OAuth tokens. A GitHub token does not expire; Google and
 *     Microsoft access tokens are good for an hour. The app never uses them.
 *   - `/link-social` and `/unlink-account` attach or strip a login method. The
 *     app has no account-linking UI; implicit linking at social sign-in runs
 *     on `/callback/:id` and is unaffected.
 *   - `/verify-password` is a yes/no oracle on the password hash for anyone
 *     holding a session cookie, with only the default limiter budget.
 *   - `/update-user` and `/update-session` write the user and session rows
 *     directly. The app's only user write is `PATCH /api/account/profile`,
 *     which validates the input and reaches Better Auth through a server-side
 *     `auth.api.updateUser` call. `disabledPaths` is consulted by the HTTP
 *     router only, so that call is untouched.
 *   - `/revoke-sessions` ends every session including the caller's; the
 *     account panel revokes one session or the OTHERS, never all.
 *   - `/change-email`, `/delete-user` and `/delete-user/callback` belong to
 *     features the configuration leaves off (`user.changeEmail`,
 *     `user.deleteUser`); a 404 makes them read as unmounted.
 *
 * A 404 here is not audited: `onRequest` runs before any hook sees the
 * session. That is acceptable because the answer is the same for everyone.
 * The impersonation rule below does not depend on this list, so re-enabling an
 * entry still leaves it refused (and audited) for an impersonated session.
 * Re-enabling one is a deliberate change: drop it here and move it to the
 * reviewed "open" list in
 * tests/security/better-auth-endpoint-classification.test.ts.
 */
export const AUTH_DISABLED_PATHS: readonly string[] = [
  "/list-accounts",
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  "/link-social",
  "/unlink-account",
  "/verify-password",
  "/update-user",
  "/update-session",
  "/revoke-sessions",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
];

/**
 * The ONLY Better Auth endpoints an IMPERSONATED session may reach over HTTP
 * (IMP-3; an allow-list since F-06).
 *
 * IMP-1 made the app's own `/api/account/*` and `/api/v1/me/*` routes refuse
 * an impersonated session by default, but Better Auth's endpoints never pass
 * through that guard. They are mounted on the catch-all, which applies no
 * app-level checks, and they resolve "the current user" as the BORROWED one.
 * IMP-3 closed five of them: session listing and revocation, which the account
 * panel calls and through which an admin holding only `admin.users.impersonate`
 * could enumerate the target's sessions across every tenant and kill their
 * real devices, plus `/update-user`.
 *
 * A deny-list of five was the wrong shape (F-06). Everything it did not name
 * stayed open to the impersonator and was attributed to the target:
 * `/list-accounts` then `/get-access-token` returned the target's provider
 * tokens, `/unlink-account` stripped a login, and `/verify-password` and
 * `/change-password` answered password guesses. Every Better Auth upgrade can
 * add another. So the rule is now an allow-list: while the session is
 * impersonated, an HTTP request to any Better Auth endpoint not named here is
 * refused.
 *
 * These are the endpoints the borrowed shell genuinely uses:
 *
 *   - `/get-session` is read by the account panel to mark the current session.
 *     Server components read the session through `auth.api.getSession`
 *     (headers, no `request`), which this guard never sees.
 *   - `/sign-out` must stay open so the admin always has a way out. The
 *     banner's "Stop impersonating" button does not need an entry: it calls
 *     `DELETE /api/administrator/users/[id]/impersonate`, which reaches
 *     `auth.api.stopImpersonating` server-side.
 */
export const IMPERSONATION_ALLOWED_PATHS: readonly string[] = ["/get-session", "/sign-out"];

/** True for an endpoint an impersonated session may reach (IMP-3 / F-06). */
export function isImpersonationAllowedPath(path: string | undefined): boolean {
  return typeof path === "string" && IMPERSONATION_ALLOWED_PATHS.includes(path);
}

/**
 * The app's single `hooks.before` middleware. Better Auth takes one, so both
 * hook-enforced policies above live here and neither can be installed without
 * the other.
 *
 * Every check is conditioned on `ctx.request`, i.e. on the call arriving over
 * HTTP: the app's own server-side `auth.api.*` calls pass headers and never a
 * `request`, and they have already been through the guarded
 * `/api/administrator/*` and `/api/account/*` routes. `ctx.path` is the
 * endpoint's route PATTERN (`/callback/:id`, not `/callback/github`), because
 * Better Auth dispatches every call with the endpoint's own path, so the
 * allow-list names endpoints, not URL spellings.
 *
 *   1. Admin plugin (review 2026-09-04 #3): 404, so the surface is
 *      indistinguishable from an unmounted route.
 *   2. Anything outside {@link IMPERSONATION_ALLOWED_PATHS} under impersonation
 *      (IMP-3, F-06): 403, audited against the IMPERSONATOR. 403 rather than
 *      404 because these endpoints genuinely exist for the session's own
 *      owner; hiding them would be a lie the account panel's error state
 *      contradicts anyway.
 *
 * The session is read with `disableCookieCache` so the refusal is decided on
 * the authoritative session row rather than a cached copy. It is read only for
 * a path outside the allow-list, so `/get-session`, the one endpoint the shell
 * calls routinely, never pays for it. A request without a session cookie
 * resolves to "no session" without a database read.
 */
export const rejectClosedAuthEndpoints = createAuthMiddleware(async (ctx) => {
  if (!ctx.request) return;

  if (isAdminPluginPath(ctx.path)) {
    throw new APIError("NOT_FOUND");
  }

  if (isImpersonationAllowedPath(ctx.path)) return;

  const session = await getSessionFromCtx(ctx, {
    // Authoritative row, not a cached copy — this is a security decision.
    disableCookieCache: true,
    // A guard must not have side effects: the endpoint's own session middleware
    // runs right after this and does the rolling-expiry refresh itself, so
    // refreshing here would only duplicate a write (and a `set-cookie`) on a
    // request that may be about to be refused.
    disableRefresh: true,
  });
  const impersonatorId = readImpersonatorId(session);
  if (!impersonatorId) {
    // `getSessionFromCtx` memoizes its result on `ctx.context.session`, the
    // object the endpoint's own session middleware reads first. Left in place,
    // our no-refresh copy would be reused as is, and since F-06 this guard
    // reads the session on every path outside the allow-list, so sessions
    // would stop rolling forward there. Clearing it lets the endpoint read the
    // session itself.
    ctx.context.session = null;
    return;
  }

  // Imported lazily so the audit module — and the database handle it pulls in —
  // stays out of the auth instance's import graph until a refusal actually
  // happens. `appUserId` is left null on purpose: this layer sits below the
  // app's user tables and must not add a lookup to the auth hook path, so the
  // borrowed identity is named in `metadata` instead. The ACTOR is the human
  // behind the session, matching the `account.impersonated_access.denied` rows
  // the account guard writes.
  const { auditEvent } = await import("@/lib/audit.server");
  await auditEvent({
    eventType: "account.impersonated_access.denied",
    outcome: "denied",
    reason: "forbidden_while_impersonating",
    actorBetterAuthUserId: impersonatorId,
    request: { headers: ctx.request.headers },
    metadata: {
      impersonatedBetterAuthUserId: session?.user.id ?? null,
      path: ctx.path,
      surface: "better-auth",
    },
  });

  throw new APIError("FORBIDDEN", {
    message: "An impersonated session cannot perform this action.",
    code: "FORBIDDEN_WHILE_IMPERSONATING",
  });
});

/**
 * Options for the `admin()` plugin.
 *
 * `allowImpersonatingAdmins: true` — DELIBERATE, and re-evaluated after the raw
 * HTTP surface above was closed. Better Auth otherwise refuses to impersonate
 * ANY target holding the `admin` role ("You cannot impersonate admins") unless
 * the actor's access-control role grants `user:impersonate-admins`, which the
 * default `admin` role does not. Org admins hold the Better Auth `admin` role
 * by design (the console's `auth.api.*` calls need it — see above; the dev seed
 * grants it to `orgadmin@<org>`), so with the flag off a superadmin could not
 * impersonate an org admin — a legitimate support action the app-level guard
 * explicitly permits. With the HTTP surface closed, the ONLY path to
 * `impersonateUser` is `POST /api/administrator/users/[id]/impersonate`, which
 * gates on `admin.users.impersonate` AND enforces the privilege-escalation
 * guard (a non-superadmin can never assume a session carrying a permission
 * they lack). That guard is strictly finer-grained than Better Auth's blanket
 * block, so the block would only add false negatives.
 * Pinned by tests/security/better-auth-admin-http-surface.test.ts.
 */
export const ADMIN_PLUGIN_OPTIONS = { allowImpersonatingAdmins: true } as const;
