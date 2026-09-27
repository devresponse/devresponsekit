import { beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { ADMIN_PLUGIN_OPTIONS, rejectClosedAuthEndpoints } from "@/lib/auth-admin-surface";
import type * as EnvModule from "@/lib/env";

/**
 * F-54 — A SESSION PAST ITS LIFETIME IS ENDED ON BETTER AUTH'S OWN ENDPOINTS
 * TOO, NOT ONLY BY THE APP'S GUARDS.
 *
 * `SESSION_ABSOLUTE_LIFETIME_HOURS` was enforced in `getCurrentSession` alone.
 * Better Auth's endpoints never pass through it, so with a 24-hour cap a
 * 30-hour-old cookie was refused by `/app` and `/api/v1` but still served by
 * `/api/auth/get-session` (which rolled its expiry forward), `/change-password`,
 * `/list-sessions` and the revocation endpoints. The single `hooks.before`
 * (`rejectClosedAuthEndpoints`) now deletes such a session on every endpoint
 * but `/sign-out` and answers 401, except where the endpoint serves a
 * signed-out caller (`SESSIONLESS_PATHS`: a sign-in, an emailed link), which
 * then proceeds signed out. The one-hour impersonation cap (F-08) is the same
 * kind of bound on the same endpoints and goes through the same rule.
 *
 * BEHAVIORAL: a real `betterAuth` instance on the memory adapter with the app's
 * hook and admin options, driven through `auth.handler` (the function the Next
 * catch-all mounts). The cap is read from `getServerEnv()`, stubbed per test.
 */

const lifetime = vi.hoisted(() => ({ hours: undefined as number | undefined }));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getServerEnv: () => ({ SESSION_ABSOLUTE_LIFETIME_HOURS: lifetime.hours }),
}));
const logServerError = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}));
const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

const BASE_URL = "http://localhost:3000";
const PASSWORD = "ci-only-session-lifetime-password";
const HOUR = 60 * 60 * 1000;

interface Store {
  user: Array<Record<string, unknown>>;
  session: Array<{ userId: string; token: string; createdAt: Date; expiresAt: Date }>;
  account: Array<Record<string, unknown>>;
  verification: Array<Record<string, unknown>>;
}

function makeAuth(store: Store) {
  return betterAuth({
    database: memoryAdapter(store as unknown as Parameters<typeof memoryAdapter>[0]),
    // Allow-listed dummy (see .gitleaks.toml).
    secret: "test-secret-test-secret-test-secret",
    baseURL: BASE_URL,
    emailAndPassword: { enabled: true },
    // Every read is due for a refresh, so a served session answers with a
    // fresh cookie: the "rolled forward" half of the finding is observable.
    session: { updateAge: 0 },
    hooks: { before: rejectClosedAuthEndpoints },
    plugins: [admin(ADMIN_PLUGIN_OPTIONS)],
  });
}

type TestAuth = ReturnType<typeof makeAuth>;

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

function httpGet(auth: TestAuth, route: string, cookie: string) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth${route}`, { method: "GET", headers: { cookie } }),
  );
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

async function seedUser(auth: TestAuth, email: string, role: "admin" | "user") {
  const ctx = await auth.$context;
  const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  await ctx.internalAdapter.updateUser(res.user.id, { role, emailVerified: true });
  return res.user.id;
}

async function signIn(auth: TestAuth, email: string, password = PASSWORD) {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password }),
    }),
  );
}

async function signInCookie(auth: TestAuth, email: string): Promise<string> {
  const res = await signIn(auth, email);
  expect(res.status).toBe(200);
  return cookieHeaderFrom(res.headers);
}

/** Backdates the creation of every live session of `userId` by `hours`. */
function age(store: Store, userId: string, hours: number) {
  for (const row of store.session.filter((s) => s.userId === userId)) {
    row.createdAt = new Date(Date.now() - hours * HOUR);
  }
}

function sessionsOf(store: Store, userId: string) {
  return store.session.filter((s) => s.userId === userId);
}

async function setup() {
  const store: Store = { user: [], session: [], account: [], verification: [] };
  const auth = makeAuth(store);
  const memberId = await seedUser(auth, "member@example.com", "user");
  // Sign-up opened a session; start from none so counts below are exact.
  store.session.length = 0;
  return { store, auth, memberId };
}

beforeEach(() => {
  lifetime.hours = undefined;
  logServerError.mockReset();
  auditMock.mockReset();
});

describe("F-54: SESSION_ABSOLUTE_LIFETIME_HOURS holds on /api/auth/*", () => {
  it("/get-session: an over-age session gets 401, is deleted, and is not rolled forward", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 30);

    const res = await httpGet(auth, "/get-session", cookie);

    expect(res.status).toBe(401);
    const body = await res.text();
    expect((JSON.parse(body) as { code?: string }).code).toBe("SESSION_EXPIRED");
    expect(body).not.toContain("member@example.com");
    // No refreshed session cookie, and no row left to refresh.
    expect(cookieHeaderFrom(res.headers)).not.toContain("session_token=");
    expect(sessionsOf(store, memberId)).toHaveLength(0);

    // The row is gone, so the same cookie now reads as signed out.
    const again = await httpGet(auth, "/get-session", cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toBeNull();
  });

  it("/change-password: an over-age session changes nothing", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 30);

    const res = await httpPost(auth, "/change-password", cookie, {
      currentPassword: PASSWORD,
      newPassword: "attacker-chosen-password-9",
      revokeOtherSessions: true,
    });

    expect(res.status).toBe(401);
    // The original password still works; the new one does not.
    expect((await signIn(auth, "member@example.com", "attacker-chosen-password-9")).status).toBe(
      401,
    );
    expect((await signIn(auth, "member@example.com")).status).toBe(200);
  });

  it("/list-sessions, /revoke-session and /revoke-other-sessions refuse it too", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    // A second device the revocation endpoints would otherwise end.
    await signInCookie(auth, "member@example.com");
    const calls: Array<[string, (cookie: string) => Promise<Response>]> = [
      ["/list-sessions", (cookie) => httpGet(auth, "/list-sessions", cookie)],
      ["/revoke-session", (cookie) => httpPost(auth, "/revoke-session", cookie, { token: "x" })],
      ["/revoke-other-sessions", (cookie) => httpPost(auth, "/revoke-other-sessions", cookie, {})],
    ];

    for (const [route, send] of calls) {
      const cookie = await signInCookie(auth, "member@example.com");
      age(store, memberId, 30);
      const res = await send(cookie);
      expect(res.status, route).toBe(401);
      expect(await res.text(), route).not.toContain("userAgent");
    }
  });

  it("/sign-out still works for an over-age session", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 30);

    const res = await httpPost(auth, "/sign-out", cookie, {});

    expect(res.status).toBe(200);
    expect(sessionsOf(store, memberId)).toHaveLength(0);
  });

  it("a sign-in carrying an over-age session ends it and signs in with the right password", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const stale = await signInCookie(auth, "member@example.com");
    const [staleRow] = sessionsOf(store, memberId);
    age(store, memberId, 24.5);

    // A bookmarked sign-in page reads no session, so the over-age row is still
    // there when the form posts, cookie and all.
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL, cookie: stale },
        body: JSON.stringify({ email: "member@example.com", password: PASSWORD }),
      }),
    );

    expect(res.status).toBe(200);
    const rows = sessionsOf(store, memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).not.toBe(staleRow!.token);
    expect(cookieHeaderFrom(res.headers)).toContain("session_token=");
  });

  it("an emailed link carrying an over-age session gets its redirect, not a 401 page", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 30);

    const res = await httpGet(
      auth,
      "/reset-password/not-a-real-token?callbackURL=%2Fen%2Freset-password",
      cookie,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/en/reset-password?error=INVALID_TOKEN");
    expect(sessionsOf(store, memberId)).toHaveLength(0);
  });

  it("a sign-in still gets 401 SESSION_EXPIRED when the over-age row could not be deleted", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 30);
    const ctx = await auth.$context;
    const spy = vi
      .spyOn(ctx.internalAdapter, "deleteSession")
      .mockRejectedValueOnce(new Error("db down"));

    const res = await httpPost(auth, "/sign-in/email", cookie, {
      email: "member@example.com",
      password: PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe("SESSION_EXPIRED");
    expect(sessionsOf(store, memberId)).toHaveLength(1);
    spy.mockRestore();
  });

  it("a session inside the cap is served and still rolls forward", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 23);

    const res = await httpGet(auth, "/get-session", cookie);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(memberId);
    expect(cookieHeaderFrom(res.headers)).toContain("session_token=");
    expect(sessionsOf(store, memberId)).toHaveLength(1);
  });

  it("UNSET (the shipped default): a session of any age is served as before", async () => {
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 10_000);

    const res = await httpGet(auth, "/get-session", cookie);

    expect(res.status).toBe(200);
    expect(sessionsOf(store, memberId)).toHaveLength(1);
  });

  it("still refuses when the delete fails, and logs it", async () => {
    lifetime.hours = 24;
    const { store, auth, memberId } = await setup();
    const cookie = await signInCookie(auth, "member@example.com");
    age(store, memberId, 30);
    const ctx = await auth.$context;
    const spy = vi
      .spyOn(ctx.internalAdapter, "deleteSession")
      .mockRejectedValueOnce(new Error("db down"));

    const res = await httpGet(auth, "/get-session", cookie);

    expect(res.status).toBe(401);
    expect(logServerError).toHaveBeenCalledWith(
      "absolute-lifetime session revocation failed",
      expect.objectContaining({ betterAuthUserId: memberId, path: "/get-session" }),
    );
    spy.mockRestore();
  });
});

describe("F-54 family: the one-hour impersonation cap (F-08) holds on /get-session", () => {
  async function borrowed(auth: TestAuth, memberId: string) {
    await seedUser(auth, "ba-admin@example.com", "admin");
    const adminCookie = await signInCookie(auth, "ba-admin@example.com");
    const started = await auth.api.impersonateUser({
      body: { userId: memberId },
      headers: new Headers({ cookie: adminCookie }),
      returnHeaders: true,
    });
    return cookieHeaderFrom(started.headers);
  }

  it("a borrowed session over an hour old gets 401 and is deleted, with the operator cap unset", async () => {
    const { store, auth, memberId } = await setup();
    const cookie = await borrowed(auth, memberId);
    age(store, memberId, 2);

    const res = await httpGet(auth, "/get-session", cookie);

    expect(res.status).toBe(401);
    expect(sessionsOf(store, memberId)).toHaveLength(0);
    // Ended as expired, not refused as an impersonation (nothing to audit).
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("a borrowed session inside the hour is still served (its way back to the shell)", async () => {
    const { auth, memberId } = await setup();
    const cookie = await borrowed(auth, memberId);

    const res = await httpGet(auth, "/get-session", cookie);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { id: string } }).user.id).toBe(memberId);
  });
});
