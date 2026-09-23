import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-13 — BETTER AUTH-BACKED ADMIN ACTIONS WORK FOR EVERY CALLER THE APP'S
 * GUARDS ADMIT.
 *
 * The admin wrappers (`src/lib/admin/auth-admin.server.ts`) used to forward
 * the caller's headers to the admin plugin's endpoints, which authorize the
 * COOKIE session they find there. A bearer caller (API key, JWT, the MCP
 * `createUser` tool) passed every app guard and then got 401 from the plugin,
 * which the routes report as 502: create, ban, unban, restore, soft-delete,
 * set-password, session list and revoke, every time. So did a cookie caller
 * without the Better Auth `admin` role, on set-role too. (The role route never
 * admits a bearer caller: it needs cross-org reach and every API key and JWT is
 * org-bound, MACHINE-2. Its wrapper still runs for all three callers below,
 * because it takes no caller credentials.) Every route test mocks the wrapper
 * module, so CI never saw it.
 *
 * BEHAVIOURAL: the REAL `auth` instance from src/lib/auth.ts (its admin plugin,
 * its hooks, its `validateUserInfo`) on Better Auth's memory adapter, driven
 * through the REAL wrappers. Each wrapper runs for three callers, with the
 * ambient request (`next/headers()`, what the route handler sees) set to
 * theirs:
 *
 *   - a bearer caller: an `Authorization` header and no cookie;
 *   - the cookie session of a Better Auth admin (the path that always worked,
 *     so it must keep working);
 *   - the cookie session of a console admin WITHOUT the Better Auth role
 *     (their authority is the app's; the plugin refused them too).
 *
 * Every case asserts the write itself in the store, not a resolved promise.
 */

vi.mock("@/lib/email/send.server", () => ({ sendAppEmail: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));

const revokeBearerCredentialsMock = vi.fn();
vi.mock("@/lib/api-auth/credential-eviction.server", () => ({
  revokeBearerCredentialsOf: (...a: unknown[]) => revokeBearerCredentialsMock(...a),
}));

vi.mock("@/lib/auth-login-audit.server", () => ({ recordSessionLogin: vi.fn() }));
// Sign-up provisioning and its policy lookups are the app's, not under test.
vi.mock("@/lib/auth-signup-provisioning", () => ({ shouldProvisionSelfSignup: () => false }));

// Plugins that need a Next.js request scope are stubbed; the admin plugin is
// real — its refusal is the defect under test.
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));
vi.mock("@/lib/auth-sso-session", () => ({ ssoSession: () => ({ id: "sso-session" }) }));

const ambient = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => ambient.headers,
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/db/database", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  // The session hook's `app_users` lookup: an existing, active account, so a
  // sign-in neither provisions nor re-evaluates anything.
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: () => Promise.resolve({ id: "app-user", status: "active" }),
  };
  return {
    pgPool: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    db: { selectFrom: () => chain },
  };
});

const PASSWORD = "ci-only-f13-admin-wrapper-password-not-for-production";
const NEW_PASSWORD = "ci-only-f13-replacement-password-not-for-production";

async function loadAuth() {
  const { auth } = await import("@/lib/auth");
  return auth;
}
type Auth = Awaited<ReturnType<typeof loadAuth>>;

async function wrappers() {
  return import("@/lib/admin/auth-admin.server");
}

/** `cookie` request header from a response's `set-cookie` headers. */
function cookieHeaderFrom(headers: Headers): string {
  const jar = new Map<string, string>();
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    const value = pair.slice(eq + 1);
    if (value) jar.set(pair.slice(0, eq), value);
    else jar.delete(pair.slice(0, eq));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function seedUser(auth: Auth, email: string, role: "admin" | "user"): Promise<string> {
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(res.user.id, { role, emailVerified: true });
  return res.user.id;
}

async function signIn(auth: Auth, email: string, password = PASSWORD): Promise<Headers> {
  const res = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  return new Headers({ cookie: cookieHeaderFrom(res.headers) });
}

let worlds = 0;

/**
 * The operators (a Better Auth admin, a console admin without that role) and
 * T, the user they administer, signed in on their own device. The mocked
 * memory database outlives `vi.resetModules()`, so every world gets its own
 * addresses.
 */
async function world() {
  const auth = await loadAuth();
  const n = ++worlds;
  const emails = {
    baAdmin: `ba-admin-${n}@example.com`,
    consoleAdmin: `console-admin-${n}@example.com`,
    target: `target-${n}@example.com`,
  };
  const baAdmin = await seedUser(auth, emails.baAdmin, "admin");
  const consoleAdmin = await seedUser(auth, emails.consoleAdmin, "user");
  const target = await seedUser(auth, emails.target, "user");
  const callers = {
    bearer: {
      actorId: consoleAdmin,
      headers: new Headers({ authorization: `Bearer drk_f13_${n}_not_a_real_key` }),
    },
    baAdminCookie: { actorId: baAdmin, headers: await signIn(auth, emails.baAdmin) },
    consoleAdminCookie: {
      actorId: consoleAdmin,
      headers: await signIn(auth, emails.consoleAdmin),
    },
  };
  const targetOwn = await signIn(auth, emails.target);
  const ctx = await auth.$context;
  return { auth, ctx, n, emails, baAdmin, consoleAdmin, target, callers, targetOwn };
}
type World = Awaited<ReturnType<typeof world>>;
type CallerKey = keyof World["callers"];

/** The stored Better Auth user row, with the admin plugin's fields (`role`, `banned`, …). */
async function userRow(w: World, id: string): Promise<Record<string, unknown> | null> {
  return w.ctx.internalAdapter.findUserById(id);
}

beforeEach(() => {
  vi.resetModules();
  revokeBearerCredentialsMock.mockReset().mockResolvedValue({ apiKeyIds: [], oauthClientIds: [] });
  ambient.headers = new Headers();
});
afterEach(() => vi.resetModules());

describe("THE GAP: the plugin's own endpoints refuse a caller without an admin cookie", () => {
  it("a bearer request gets 401 from banUser, whatever the app's guards decided", async () => {
    // Why the wrappers must not route through these endpoints: this is the
    // vendor call the ban route used to make, with a bearer caller's headers.
    const w = await world();

    await expect(
      w.auth.api.banUser({ body: { userId: w.target }, headers: w.callers.bearer.headers }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect((await userRow(w, w.target))?.banned).not.toBe(true);
  });
});

const CALLERS: ReadonlyArray<{ label: string; key: CallerKey }> = [
  { label: "a bearer caller (API key, JWT, MCP tool) with no cookie", key: "bearer" },
  { label: "the cookie session of a Better Auth admin", key: "baAdminCookie" },
  { label: "the cookie session of a console admin without that role", key: "consoleAdminCookie" },
];

describe.each(CALLERS)("F-13: every wrapper works for $label", ({ key }) => {
  /** A fresh world with the ambient request set to this caller's. */
  async function as() {
    const w = await world();
    const caller = w.callers[key];
    ambient.headers = caller.headers;
    return { w, caller, M: await wrappers() };
  }

  it("createBetterAuthUser creates a verified user who signs in with that password (POST /users, POST /api/v1/users, MCP createUser)", async () => {
    const { w, M } = await as();
    const email = `created-${w.n}@example.com`;

    const res = await M.createBetterAuthUser({ email, password: PASSWORD, name: "Created" });

    const row = await userRow(w, res.user.id);
    expect(row).toMatchObject({ email, name: "Created", emailVerified: true, role: "user" });
    // F-03's marker survives the headerless call.
    expect(row?.emailVerificationWaived).toBe(true);
    await expect(
      w.auth.api.signInEmail({ body: { email, password: PASSWORD } }),
    ).resolves.toMatchObject({ user: { id: res.user.id } });
  });

  it("updateBetterAuthUser renames the TARGET, and only the target (F-14)", async () => {
    const { w, M } = await as();

    await M.updateBetterAuthUser({ userId: w.target, data: { name: "Renamed by an admin" } });

    expect((await w.ctx.internalAdapter.findUserById(w.target))?.name).toBe("Renamed by an admin");
    // The self-service endpoint the wrapper used to call acts on the SESSION's
    // user; nobody else may be renamed.
    expect((await w.ctx.internalAdapter.findUserById(w.baAdmin))?.name).toBe(w.emails.baAdmin);
    expect((await w.ctx.internalAdapter.findUserById(w.consoleAdmin))?.name).toBe(
      w.emails.consoleAdmin,
    );
  });

  it("setBetterAuthUserRole sets the target's Better Auth role", async () => {
    const { w, M } = await as();

    await M.setBetterAuthUserRole({ userId: w.target, role: "admin" });

    expect((await userRow(w, w.target))?.role).toBe("admin");
  });

  it("banBetterAuthUser bans the target and signs them out; unbanBetterAuthUser lets them back (ban, unban, soft-delete, restore, bulk)", async () => {
    const { w, caller, M } = await as();
    const before = Date.now();

    await M.banBetterAuthUser({
      userId: w.target,
      banReason: "compromised",
      banExpiresIn: 3600,
      actorBetterAuthUserId: caller.actorId,
    });

    const banned = (await userRow(w, w.target))!;
    expect(banned).toMatchObject({ banned: true, banReason: "compromised" });
    expect((banned.banExpires as Date).getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(await w.auth.api.getSession({ headers: w.targetOwn })).toBeNull();
    await expect(
      w.auth.api.signInEmail({ body: { email: w.emails.target, password: PASSWORD } }),
    ).rejects.toThrow();

    await M.unbanBetterAuthUser(w.target);

    expect(await w.ctx.internalAdapter.findUserById(w.target)).toMatchObject({
      banned: false,
      banReason: null,
      banExpires: null,
    });
    await expect(
      w.auth.api.signInEmail({ body: { email: w.emails.target, password: PASSWORD } }),
    ).resolves.toMatchObject({ user: { id: w.target } });
  });

  it("the session wrappers list, revoke one and revoke all of the target's sessions", async () => {
    const { w, M } = await as();
    const second = await signIn(w.auth, w.emails.target);

    const listed = await M.listBetterAuthUserSessions(w.target);
    expect(listed.sessions).toHaveLength(2);
    // The rows carry the token the `[sessionId]` route resolves ids to.
    const [first] = listed.sessions;
    expect(first?.token).toEqual(expect.any(String));

    await M.revokeBetterAuthUserSession(first!.token);
    expect((await M.listBetterAuthUserSessions(w.target)).sessions.map((s) => s.id)).toEqual(
      listed.sessions.filter((s) => s.id !== first!.id).map((s) => s.id),
    );

    await M.revokeAllBetterAuthUserSessions(w.target);
    expect((await M.listBetterAuthUserSessions(w.target)).sessions).toEqual([]);
    expect(await w.auth.api.getSession({ headers: w.targetOwn })).toBeNull();
    expect(await w.auth.api.getSession({ headers: second })).toBeNull();
  });

  it("setBetterAuthUserPassword replaces the password and signs the target out everywhere", async () => {
    const { w, caller, M } = await as();

    await M.setBetterAuthUserPassword(
      {
        userId: w.target,
        newPassword: NEW_PASSWORD,
        setBy: { betterAuthUserId: caller.actorId, appUserId: "app-actor" },
      },
      caller.headers,
    );

    await expect(
      w.auth.api.signInEmail({ body: { email: w.emails.target, password: NEW_PASSWORD } }),
    ).resolves.toMatchObject({ user: { id: w.target } });
    await expect(
      w.auth.api.signInEmail({ body: { email: w.emails.target, password: PASSWORD } }),
    ).rejects.toThrow();
    expect(await w.auth.api.getSession({ headers: w.targetOwn })).toBeNull();
    // F-10 still runs, in the operator's name, against the route's request.
    expect(revokeBearerCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: w.target,
        trigger: "password_set",
        actorBetterAuthUserId: caller.actorId,
        request: { headers: caller.headers },
      }),
    );
  });

  it("no wrapper touches the caller's own session", async () => {
    const { w, caller, M } = await as();

    await M.banBetterAuthUser({ userId: w.target, actorBetterAuthUserId: caller.actorId });
    await M.revokeAllBetterAuthUserSessions(w.target);

    if (key !== "bearer") {
      expect(await w.auth.api.getSession({ headers: caller.headers })).not.toBeNull();
    }
    const others = [w.baAdmin, w.consoleAdmin];
    for (const id of others) {
      expect(await w.ctx.internalAdapter.listSessions(id)).toHaveLength(1);
    }
  });
});

describe("F-13: the vendor checks that were more than authorization are kept", () => {
  it("nobody may ban themselves, bearer or cookie: refused before anything is written", async () => {
    const w = await world();
    const M = await wrappers();
    ambient.headers = w.callers.bearer.headers;

    await expect(
      M.banBetterAuthUser({ userId: w.target, actorBetterAuthUserId: w.target }),
    ).rejects.toThrow("You cannot ban yourself");

    expect((await userRow(w, w.target))?.banned).not.toBe(true);
    expect(await w.auth.api.getSession({ headers: w.targetOwn })).not.toBeNull();
  });

  it("a missing target is refused (USER_NOT_FOUND) and nothing is written", async () => {
    const w = await world();
    const M = await wrappers();
    const missing = "no-such-better-auth-user";

    for (const write of [
      () => M.banBetterAuthUser({ userId: missing, actorBetterAuthUserId: w.baAdmin }),
      () => M.unbanBetterAuthUser(missing),
      () => M.setBetterAuthUserRole({ userId: missing, role: "admin" }),
      () => M.updateBetterAuthUser({ userId: missing, data: { name: "x" } }),
      () =>
        M.setBetterAuthUserPassword({
          userId: missing,
          newPassword: NEW_PASSWORD,
          setBy: { betterAuthUserId: w.baAdmin, appUserId: null },
        }),
    ]) {
      await expect(write()).rejects.toThrow("User not found");
    }
    expect(await w.ctx.internalAdapter.findUserById(missing)).toBeNull();
    expect(revokeBearerCredentialsMock).not.toHaveBeenCalled();
  });

  it("a password outside Better Auth's bounds is refused and nobody is signed out", async () => {
    const w = await world();
    const M = await wrappers();
    const setBy = { betterAuthUserId: w.baAdmin, appUserId: null };

    await expect(
      M.setBetterAuthUserPassword({ userId: w.target, newPassword: "short", setBy }),
    ).rejects.toThrow("Password too short");
    await expect(
      M.setBetterAuthUserPassword({ userId: w.target, newPassword: "x".repeat(200), setBy }),
    ).rejects.toThrow("Password too long");

    expect(await w.auth.api.getSession({ headers: w.targetOwn })).not.toBeNull();
    await expect(
      w.auth.api.signInEmail({ body: { email: w.emails.target, password: PASSWORD } }),
    ).resolves.toBeTruthy();
  });

  it("a user with no password (social-only) gets a credential account", async () => {
    const w = await world();
    const M = await wrappers();
    // No password: the plugin creates the user without a credential account.
    const email = `social-only-${w.n}@example.com`;
    const { user } = await w.auth.api.createUser({ body: { email, name: email } });
    expect(await w.ctx.internalAdapter.findCredentialAccount(user.id)).toBeNull();
    await w.ctx.internalAdapter.updateUser(user.id, { emailVerified: true });

    await M.setBetterAuthUserPassword({
      userId: user.id,
      newPassword: NEW_PASSWORD,
      setBy: { betterAuthUserId: w.baAdmin, appUserId: null },
    });

    await expect(
      w.auth.api.signInEmail({ body: { email, password: NEW_PASSWORD } }),
    ).resolves.toMatchObject({ user: { id: user.id } });
  });

  it("createBetterAuthUser still refuses an address that already exists", async () => {
    const w = await world();
    const M = await wrappers();

    // The endpoint's own duplicate check, case-folded like its email handling.
    await expect(
      M.createBetterAuthUser({ email: w.emails.target.toUpperCase(), password: PASSWORD }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("F-13: the contract is structural", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/lib/admin/auth-admin.server.ts"),
    "utf8",
  );

  it("the only Better Auth endpoints the wrappers call are create (headerless), impersonation and the reset email", () => {
    // Any other `auth.api.*` admin endpoint re-authorizes against the cookie
    // session and refuses every bearer caller. New user-administration
    // wrappers write through `auth.$context` instead.
    const called = new Set([...source.matchAll(/auth\.api\.(\w+)\(/g)].map((m) => m[1]));
    expect([...called].sort()).toEqual([
      "createUser",
      "impersonateUser",
      "requestPasswordReset",
      "stopImpersonating",
    ]);
  });

  it("createBetterAuthUser forwards no headers and no request", () => {
    const start = source.indexOf("export async function createBetterAuthUser");
    const end = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, end);
    expect(body).toContain("auth.api.createUser(");
    expect(body).not.toMatch(/headers|request/);
  });
});
