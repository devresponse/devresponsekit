import { APIError, createAuthMiddleware } from "better-auth/api";

/**
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
 * `request`) never carries. Rejecting with 404 (not 403) matches the §6.2
 * "404, not 403" posture and makes the surface indistinguishable from an
 * unmounted route.
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
 * `hooks.before` middleware: 404 every admin-plugin endpoint reached over
 * HTTP; let server-side `auth.api.*` calls (no `ctx.request`) through.
 */
export const rejectAdminPluginOverHttp = createAuthMiddleware(async (ctx) => {
  if (ctx.request && isAdminPluginPath(ctx.path)) {
    throw new APIError("NOT_FOUND");
  }
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
