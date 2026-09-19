import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import {
  ADMIN_PLUGIN_OPTIONS,
  IMPERSONATION_CLOSED_PATHS,
  isAdminPluginPath,
  isImpersonationClosedPath,
  rejectClosedAuthEndpoints,
} from "@/lib/auth-admin-surface";

/**
 * Review 2026-09-04 #3 — the Better Auth admin plugin's raw HTTP surface
 * (`/api/auth/admin/*`) must be closed while the app's own server-side
 * `auth.api.*` calls keep working.
 *
 * BEHAVIORAL: a real `betterAuth` instance on the memory adapter, configured
 * like src/lib/auth.ts (same `hooks.before` and `admin()` options), driven
 * through the same `auth.handler` the Next catch-all route mounts. Pins:
 *
 *   1. A session holding the Better Auth `admin` role gets 404 from
 *      `POST /admin/impersonate-user`, `GET /admin/list-users` and
 *      `POST /admin/set-user-password` — and the handler never ran (no side
 *      effect). A control instance WITHOUT the hook serves the same requests
 *      (200), so the 404 is provably ours and not a routing typo.
 *   2. Non-admin HTTP endpoints (`/sign-in/email`, `/get-session`) are
 *      untouched.
 *   3. Server-side `auth.api.*` calls with headers but no `request` — the
 *      exact shape `src/lib/admin/auth-admin.server.ts` uses for the app's
 *      impersonate / ban / set-password / list-sessions / create-user routes —
 *      still succeed, including stop-impersonating.
 *   4. `allowImpersonatingAdmins: true` is load-bearing: a superadmin
 *      impersonating an org admin (who holds the Better Auth `admin` role by
 *      design) only works with the flag on.
 *
 * WIRING: src/lib/auth.ts must actually install the hook and the shared
 * options, so the live config cannot drift from what is exercised here.
 */

/**
 * The IMP-3 refusal writes an audit row before it throws. Stubbed so the real
 * module — and the database handle it imports — stays out of this suite, and
 * so the row itself can be asserted.
 */
const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

const BASE_URL = "http://localhost:3000";
const PASSWORD = "ci-only-admin-surface-password-not-for-production";

function makeAuth(opts: { guarded: boolean; allowImpersonatingAdmins?: boolean }) {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    // Allow-listed dummy (see .gitleaks.toml) — a high-entropy literal here trips gitleaks generic-api-key.
    secret: "test-secret-test-secret-test-secret",
    baseURL: BASE_URL,
    emailAndPassword: { enabled: true },
    ...(opts.guarded ? { hooks: { before: rejectClosedAuthEndpoints } } : {}),
    plugins: [
      admin({
        ...ADMIN_PLUGIN_OPTIONS,
        ...(opts.allowImpersonatingAdmins === undefined
          ? {}
          : { allowImpersonatingAdmins: opts.allowImpersonatingAdmins }),
      }),
    ],
  });
}

type TestAuth = ReturnType<typeof makeAuth>;

/** The admin plugin adds `impersonatedBy` to sessions; the base type lacks it. */
function impersonatedBy(session: unknown): string | null | undefined {
  return (session as { impersonatedBy?: string | null }).impersonatedBy;
}

/**
 * Build a `cookie` request header from a response's `set-cookie` headers.
 * Later cookies win and cleared ones (`name=`, Max-Age=0) are dropped — the
 * impersonate flow clears the old session cookie before setting the new one.
 */
function cookieHeaderFrom(headers: Headers): string {
  const jar = new Map<string, string>();
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Create a verified email/password user and (optionally) promote its BA role. */
async function seedUser(auth: TestAuth, email: string, role: "admin" | "user") {
  const ctx = await auth.$context;
  const res = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: email },
  });
  const id = res.user.id;
  await ctx.internalAdapter.updateUser(id, { role, emailVerified: true });
  return id;
}

/** Sign in over HTTP (the real router) and return the session cookie header. */
async function signInOverHttp(auth: TestAuth, email: string): Promise<string> {
  const res = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const cookie = cookieHeaderFrom(res.headers);
  expect(cookie).toContain("session_token=");
  return cookie;
}

function httpPost(auth: TestAuth, route: string, cookie: string, body: unknown) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, cookie },
      body: JSON.stringify(body),
    }),
  );
}

function httpGet(auth: TestAuth, route: string, cookie: string) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${route}`, { method: "GET", headers: { cookie } }),
  );
}

async function setup(opts: { guarded: boolean; allowImpersonatingAdmins?: boolean }) {
  const auth = makeAuth(opts);
  const adminId = await seedUser(auth, "ba-admin@example.com", "admin");
  const superId = await seedUser(auth, "superadmin@example.com", "admin");
  const memberId = await seedUser(auth, "member@example.com", "user");
  const adminCookie = await signInOverHttp(auth, "ba-admin@example.com");
  return {
    auth,
    adminId,
    superId,
    memberId,
    adminCookie,
    headers: new Headers({ cookie: adminCookie }),
  };
}

describe("Better Auth admin plugin raw HTTP surface is closed (review #3)", () => {
  it("404s POST /admin/impersonate-user for a BA-admin session and creates no session", async () => {
    const { auth, superId, adminCookie } = await setup({ guarded: true });
    const ctx = await auth.$context;

    const res = await httpPost(auth, "/admin/impersonate-user", adminCookie, { userId: superId });

    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The handler never ran: no impersonation session exists for the target
    // (sign-up seeded one ordinary session for it; it must be the only one).
    const sessions = await ctx.internalAdapter.listSessions(superId);
    expect(sessions.filter((s) => impersonatedBy(s))).toHaveLength(0);
  });

  it("404s GET /admin/list-users for a BA-admin session (no cross-tenant enumeration)", async () => {
    const { auth, adminCookie } = await setup({ guarded: true });

    const res = await httpGet(auth, "/admin/list-users?limit=100", adminCookie);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("superadmin@example.com");
  });

  it("404s POST /admin/set-user-password for a BA-admin session and leaves the password intact", async () => {
    const { auth, superId, adminCookie } = await setup({ guarded: true });

    const res = await httpPost(auth, "/admin/set-user-password", adminCookie, {
      userId: superId,
      newPassword: "attacker-chosen-password-1",
    });

    expect(res.status).toBe(404);
    // The target can still sign in with the original password → the handler never ran.
    await signInOverHttp(auth, "superadmin@example.com");
  });

  it("404s every other admin-plugin endpoint too (set-role, remove-user, ban, sessions, create)", async () => {
    const { auth, memberId, adminCookie } = await setup({ guarded: true });
    const posts: Array<[string, unknown]> = [
      ["/admin/set-role", { userId: memberId, role: "admin" }],
      ["/admin/remove-user", { userId: memberId }],
      ["/admin/ban-user", { userId: memberId }],
      ["/admin/unban-user", { userId: memberId }],
      ["/admin/list-user-sessions", { userId: memberId }],
      ["/admin/revoke-user-sessions", { userId: memberId }],
      ["/admin/update-user", { userId: memberId, data: { name: "x" } }],
      ["/admin/create-user", { email: "new@example.com", password: PASSWORD, name: "n" }],
      ["/admin/has-permission", { permissions: { user: ["list"] } }],
      ["/admin/stop-impersonating", {}],
    ];
    for (const [route, body] of posts) {
      const res = await httpPost(auth, route, adminCookie, body);
      expect(res.status, route).toBe(404);
    }
    const get = await httpGet(auth, `/admin/get-user?id=${memberId}`, adminCookie);
    expect(get.status).toBe(404);
  });

  it("CONTROL: without the hook the same requests succeed — the 404 is the guard, not a typo", async () => {
    const { auth, superId, adminCookie } = await setup({ guarded: false });

    const list = await httpGet(auth, "/admin/list-users?limit=100", adminCookie);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("superadmin@example.com");

    const impersonate = await httpPost(auth, "/admin/impersonate-user", adminCookie, {
      userId: superId,
    });
    expect(impersonate.status).toBe(200);
  });

  it("leaves non-admin HTTP endpoints untouched (sign-in above, get-session here)", async () => {
    const { auth, adminId, adminCookie } = await setup({ guarded: true });

    const res = await httpGet(auth, "/get-session", adminCookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe(adminId);
  });
});

describe("the app's server-side auth.api.* admin calls still work (headers, no request)", () => {
  it("impersonateUser → session carries impersonatedBy; stopImpersonating restores the actor", async () => {
    const { auth, adminId, memberId, headers } = await setup({ guarded: true });

    const started = await auth.api.impersonateUser({
      body: { userId: memberId },
      headers,
      returnHeaders: true,
    });
    expect(impersonatedBy(started.response.session)).toBe(adminId);
    expect(started.response.user.id).toBe(memberId);

    const impersonatedCookie = cookieHeaderFrom(started.headers);
    const stopped = await auth.api.stopImpersonating({
      headers: new Headers({ cookie: impersonatedCookie }),
    });
    expect(stopped.user.id).toBe(adminId);
  });

  it("setUserPassword, banUser, listUserSessions, createUser, listUsers succeed", async () => {
    const { auth, memberId, headers } = await setup({ guarded: true });

    const pw = await auth.api.setUserPassword({
      body: { userId: memberId, newPassword: "rotated-by-admin-console-1" },
      headers,
    });
    expect(pw.status).toBe(true);

    const banned = await auth.api.banUser({ body: { userId: memberId, banReason: "t" }, headers });
    expect(banned.user.banned).toBe(true);

    const sessions = await auth.api.listUserSessions({ body: { userId: memberId }, headers });
    expect(Array.isArray(sessions.sessions)).toBe(true);

    const created = await auth.api.createUser({
      body: { email: "created@example.com", password: PASSWORD, name: "Created" },
      headers,
    });
    expect(created.user.email).toBe("created@example.com");

    const list = await auth.api.listUsers({ query: { limit: 10 }, headers });
    expect(list.total).toBeGreaterThanOrEqual(4);
  });

  it("refuses the same server-side call from a NON-admin session (plugin authz still applies)", async () => {
    const { auth, memberId } = await setup({ guarded: true });
    const memberCookie = await signInOverHttp(auth, "member@example.com");

    await expect(
      auth.api.listUsers({ query: { limit: 10 }, headers: new Headers({ cookie: memberCookie }) }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    await expect(
      auth.api.impersonateUser({
        body: { userId: memberId },
        headers: new Headers({ cookie: memberCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });
});

describe("allowImpersonatingAdmins decision (kept true — the app route depends on it)", () => {
  it("with the shared options a superadmin CAN impersonate an org admin holding the BA admin role", async () => {
    const { auth, adminId, superId, headers } = await setup({ guarded: true });

    const res = await auth.api.impersonateUser({ body: { userId: superId }, headers });

    expect(impersonatedBy(res.session)).toBe(adminId);
    expect(res.user.id).toBe(superId);
  });

  it("with the flag OFF Better Auth refuses that legitimate support action (why it stays on)", async () => {
    const { auth, superId, headers } = await setup({
      guarded: true,
      allowImpersonatingAdmins: false,
    });

    await expect(
      auth.api.impersonateUser({ body: { userId: superId }, headers }),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
  });

  it("pins the shared option value", () => {
    expect(ADMIN_PLUGIN_OPTIONS.allowImpersonatingAdmins).toBe(true);
  });
});

/**
 * IMP-3 — Better Auth's OWN self-service endpoints are closed to an
 * IMPERSONATED session.
 *
 * IMP-1 made the app's `/api/account/*` and `/api/v1/me/*` guard refuse an
 * impersonated session by default, but self-service SESSION MANAGEMENT never
 * went through that guard: the account panel calls `authClient.listSessions()`
 * / `revokeSession()` / `revokeOtherSessions()`, which land on the catch-all
 * and resolve "the current user" as the BORROWED one. So an admin holding only
 * `admin.users.impersonate` could enumerate the target's sessions (IP,
 * user-agent, every tenant) and revoke them — capabilities otherwise gated by
 * `admin.users.sessions` — with the resulting rows attributed to the target.
 *
 * Driven through the real `auth.handler` with a REAL impersonated session
 * (started via the server-side `auth.api.impersonateUser`, which the hook lets
 * through), so the marker under test is Better Auth's own `impersonatedBy`.
 */
describe("IMP-3: an impersonated session cannot reach Better Auth self-service", () => {
  beforeEach(() => auditMock.mockReset());

  /** Starts impersonation server-side and returns the borrowed session cookie. */
  async function borrowSession(auth: TestAuth, headers: Headers, targetId: string) {
    const started = await auth.api.impersonateUser({
      body: { userId: targetId },
      headers,
      returnHeaders: true,
    });
    expect(started.response.user.id).toBe(targetId);
    return cookieHeaderFrom(started.headers);
  }

  /** Every closed path, with the request shape the account panel would send. */
  function callClosedPath(auth: TestAuth, route: string, cookie: string) {
    if (route === "/list-sessions") return httpGet(auth, route, cookie);
    if (route === "/revoke-session") return httpPost(auth, route, cookie, { token: "whatever" });
    if (route === "/update-user") return httpPost(auth, route, cookie, { name: "renamed" });
    return httpPost(auth, route, cookie, {});
  }

  it("403s every closed path, and the admin-plugin 404 still applies alongside it", async () => {
    const { auth, memberId, headers } = await setup({ guarded: true });
    const borrowed = await borrowSession(auth, headers, memberId);

    for (const route of IMPERSONATION_CLOSED_PATHS) {
      const res = await callClosedPath(auth, route, borrowed);
      expect(res.status, route).toBe(403);
    }
    // Composed, not replaced: wiring one policy would silently drop the other.
    expect((await httpGet(auth, "/admin/list-users?limit=100", borrowed)).status).toBe(404);
  });

  it("revokes NOTHING — the borrowed user's real sessions survive the attempt", async () => {
    const { auth, memberId, headers } = await setup({ guarded: true });
    const ctx = await auth.$context;
    // A real device of the target's, alongside the borrowed session.
    await signInOverHttp(auth, "member@example.com");
    const borrowed = await borrowSession(auth, headers, memberId);
    const before = (await ctx.internalAdapter.listSessions(memberId)).filter(
      (session) => !impersonatedBy(session),
    );
    expect(before.length).toBeGreaterThan(0);

    expect((await httpPost(auth, "/revoke-other-sessions", borrowed, {})).status).toBe(403);
    expect((await httpPost(auth, "/revoke-sessions", borrowed, {})).status).toBe(403);

    const after = (await ctx.internalAdapter.listSessions(memberId)).filter(
      (session) => !impersonatedBy(session),
    );
    expect(after.map((session) => session.id).sort()).toEqual(
      before.map((session) => session.id).sort(),
    );
  });

  it("enumerates nothing — the refusal body carries no session metadata", async () => {
    const { auth, memberId, headers } = await setup({ guarded: true });
    const borrowed = await borrowSession(auth, headers, memberId);

    const res = await httpGet(auth, "/list-sessions", borrowed);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("userAgent");
  });

  it("audits the refusal against the IMPERSONATOR, naming the borrowed identity", async () => {
    const { auth, adminId, memberId, headers } = await setup({ guarded: true });
    const borrowed = await borrowSession(auth, headers, memberId);

    await httpPost(auth, "/revoke-other-sessions", borrowed, {});

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "account.impersonated_access.denied",
        outcome: "denied",
        reason: "forbidden_while_impersonating",
        // The human behind the session, never the identity they borrowed —
        // the whole point is that the trail names who actually did it.
        actorBetterAuthUserId: adminId,
        metadata: expect.objectContaining({
          impersonatedBetterAuthUserId: memberId,
          path: "/revoke-other-sessions",
        }),
      }),
    );
  });

  it("CONTROL: the session's OWN owner still reaches every closed path (200, unaudited)", async () => {
    // Proves the 403s above are the impersonation marker biting and not a
    // blanket closure — self-service must keep working for the actual user.
    const { auth } = await setup({ guarded: true });

    for (const route of IMPERSONATION_CLOSED_PATHS) {
      // A FRESH session per route: `/revoke-sessions` destroys every session
      // the caller holds, including the one making the call, so a shared
      // cookie would 401 the rest of the loop for the wrong reason.
      const cookie = await signInOverHttp(auth, "ba-admin@example.com");
      const res = await callClosedPath(auth, route, cookie);
      expect(res.status, route).toBe(200);
    }
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("CONTROL: without the hook the impersonated session succeeds — the 403 is ours", async () => {
    const { auth, memberId, headers } = await setup({ guarded: false });
    const borrowed = await borrowSession(auth, headers, memberId);

    expect((await httpGet(auth, "/list-sessions", borrowed)).status).toBe(200);
    expect((await httpPost(auth, "/revoke-other-sessions", borrowed, {})).status).toBe(200);
  });

  it("leaves the impersonated session its way out: /get-session and /sign-out stay open", async () => {
    // A borrowed session that cannot read itself renders no shell, and one that
    // cannot sign out strands the admin — the failure mode this whole review is
    // about. Both must stay reachable.
    const { auth, memberId, headers } = await setup({ guarded: true });
    const borrowed = await borrowSession(auth, headers, memberId);

    const me = await httpGet(auth, "/get-session", borrowed);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(memberId);
    expect((await httpPost(auth, "/sign-out", borrowed, {})).status).toBe(200);
  });

  it("lets the app's own server-side updateUser through (PATCH /api/account/profile)", async () => {
    // `/update-user` is closed over HTTP, but `PATCH /api/account/profile`
    // deliberately admits impersonation and reaches Better Auth with headers
    // and no `request` — that support flow must be untouched.
    const { auth, memberId, headers } = await setup({ guarded: true });
    const borrowed = await borrowSession(auth, headers, memberId);

    const updated = await auth.api.updateUser({
      body: { name: "Set by the support admin" },
      headers: new Headers({ cookie: borrowed }),
    });

    expect(updated.status).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("wiring: src/lib/auth.ts installs the guard and the shared plugin options", () => {
  const authSource = readFileSync(path.resolve(__dirname, "../../src/lib/auth.ts"), "utf8");

  it("registers rejectClosedAuthEndpoints as the global hooks.before", () => {
    // The composed middleware, not either policy on its own — Better Auth takes
    // exactly one `before` hook, so wiring a single policy here would silently
    // drop the other (IMP-3).
    expect(authSource).toMatch(/hooks:\s*\{\s*before:\s*rejectClosedAuthEndpoints\s*\}/);
  });

  it("passes ADMIN_PLUGIN_OPTIONS to admin() and never inlines allowImpersonatingAdmins", () => {
    expect(authSource).toMatch(/admin\(ADMIN_PLUGIN_OPTIONS\)/);
    expect(authSource).not.toMatch(/allowImpersonatingAdmins:/);
  });

  it("isImpersonationClosedPath matches the closed list exactly", () => {
    // Exact paths, not a prefix: `/list-sessions` must not drag in some
    // `/list-sessions-*` a future plugin mounts, and the two endpoints the
    // borrowed session needs to render and to get out must stay OFF the list.
    expect(isImpersonationClosedPath("/revoke-other-sessions")).toBe(true);
    expect(isImpersonationClosedPath("/list-sessions")).toBe(true);
    expect(isImpersonationClosedPath("/list-sessions-extra")).toBe(false);
    expect(isImpersonationClosedPath("/get-session")).toBe(false);
    expect(isImpersonationClosedPath("/sign-out")).toBe(false);
    expect(isImpersonationClosedPath(undefined)).toBe(false);
  });

  it("isAdminPluginPath matches only the plugin prefix", () => {
    expect(isAdminPluginPath("/admin/impersonate-user")).toBe(true);
    expect(isAdminPluginPath("/admin/list-users")).toBe(true);
    expect(isAdminPluginPath("/sign-in/email")).toBe(false);
    expect(isAdminPluginPath("/administrator")).toBe(false);
    expect(isAdminPluginPath(undefined)).toBe(false);
  });
});
