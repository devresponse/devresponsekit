import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { readImpersonatorId } from "@/lib/impersonation";

/**
 * Which Better Auth HTTP endpoints this app closes, and why.
 *
 * Two policies live here because Better Auth accepts exactly ONE
 * `hooks.before` middleware, and both are about the same thing: the catch-all
 * `/api/auth/[...all]` mounts the vendor's endpoints with no app-level guard,
 * so anything the app does not want reachable has to be refused here. They are
 * composed in {@link rejectClosedAuthEndpoints} at the bottom of the file —
 * the admin plugin's whole surface (review 2026-09-04 #3, below) and the
 * self-service endpoints an IMPERSONATED session must not reach
 * (IMP-3, see {@link IMPERSONATION_CLOSED_PATHS}).
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
 * Better Auth SELF-SERVICE endpoints closed to an IMPERSONATED session (IMP-3).
 *
 * IMP-1 closed the app's own self-service surface by making `/api/account/*`
 * and `/api/v1/me/*` refuse an impersonated session BY DEFAULT — but session
 * management never went through that guard. `_sessions-panel.tsx` calls
 * `authClient.listSessions()`, `authClient.revokeSession({ token })` and
 * `authClient.revokeOtherSessions()`, which land on Better Auth's catch-all
 * `/api/auth/[...all]`, a route that by design applies no app-level checks;
 * the admin-plugin refusal above closes only `/admin/*`. Better Auth then
 * resolves "the current user" as the BORROWED one, so an impersonating admin
 * could:
 *
 *   - enumerate every session the target holds, with IP and user-agent, across
 *     every tenant — normally gated by `admin.users.sessions` on
 *     `/api/administrator/users/[id]/sessions`;
 *   - revoke any or all of them. `revoke-other-sessions` is the sharp one: it
 *     kills the target's real devices and leaves the impersonation session
 *     itself alive.
 *
 * Both are acquired by an admin holding only `admin.users.impersonate`, and
 * the rows they produce are attributed to the borrowed user, so the audit
 * trail does not name who actually did it. That is precisely the "sibling
 * route left unguarded" shape `AccountAccessOptions` was built to prevent for
 * the app's own routes; this is the same default for the vendor's.
 *
 * `/update-user` is included although the app's own `PATCH /api/account/profile`
 * deliberately ALLOWS impersonation: that route reaches Better Auth through a
 * server-side `auth.api.updateUser` call (headers, no `request`), which this
 * guard lets through, so the support flow is untouched while the direct,
 * unaudited HTTP channel to the same write is closed.
 *
 * Endpoints NOT listed are reachable while impersonating on purpose:
 * `/get-session` and `/sign-out` must keep working (the impersonated shell
 * renders from the first and the admin needs a way out), and
 * `/change-password` requires the current password, which the admin does not
 * have.
 */
export const IMPERSONATION_CLOSED_PATHS: readonly string[] = [
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/update-user",
];

/** True for an endpoint path closed to impersonated sessions (IMP-3). */
export function isImpersonationClosedPath(path: string | undefined): boolean {
  return typeof path === "string" && IMPERSONATION_CLOSED_PATHS.includes(path);
}

/**
 * The app's single `hooks.before` middleware — Better Auth takes one, and both
 * surface policies above are expressed here so neither can be installed
 * without the other.
 *
 * Every check is conditioned on `ctx.request`, i.e. on the call arriving over
 * HTTP: the app's own server-side `auth.api.*` calls pass headers and never a
 * `request`, and they have already been through the guarded
 * `/api/administrator/*` routes.
 *
 *   1. Admin plugin (review 2026-09-04 #3) — 404, so the surface is
 *      indistinguishable from an unmounted route.
 *   2. Self-service under impersonation (IMP-3) — 403, audited against the
 *      IMPERSONATOR. 403 rather than 404 because these endpoints genuinely
 *      exist for the session's own owner; hiding them would be a lie the
 *      account panel's error state contradicts anyway.
 *
 * The session is read with `disableCookieCache` so the refusal is decided on
 * the authoritative session row rather than a cached copy, and it is read ONLY
 * for a path in the closed list, so no other endpoint pays for it.
 */
export const rejectClosedAuthEndpoints = createAuthMiddleware(async (ctx) => {
  if (!ctx.request) return;

  if (isAdminPluginPath(ctx.path)) {
    throw new APIError("NOT_FOUND");
  }

  if (!isImpersonationClosedPath(ctx.path)) return;

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
  if (!impersonatorId) return;

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
