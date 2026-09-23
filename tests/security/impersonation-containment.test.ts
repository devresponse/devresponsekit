import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPERSONATION_SESSION_MAX_AGE_SECONDS } from "@/lib/session-lifetime";

/**
 * F-08 — CONTAINING AN ADMIN ENDS THE SESSIONS THEY OPENED AS SOMEONE ELSE,
 * AND NO BORROWED SESSION OUTLIVES ONE HOUR.
 *
 * An impersonation session belongs to the TARGET: Better Auth stores it with
 * `userId` = the borrowed identity and names the admin only in
 * `impersonatedBy`. Every vendor call that ends "a user's sessions" deletes by
 * `userId`. So when a peer banned a compromised superadmin S, revoked all of
 * S's sessions, or S's password was reset, S's own rows went and the session
 * S was driving as customer user T stayed — with T's authority, and, S being a
 * superadmin, with no tenant confinement. An admin SETTING S's password
 * deleted no session at all; it now ends the borrowed one, but still none of
 * S's own (F-10, open — see the set-password case). Its one-hour expiry was no
 * bound either: the plugin skips the rolling refresh only while the signed
 * `dont_remember` cookie rides along, so a holder who drops it keeps the row
 * alive 8 h at a time.
 *
 * BEHAVIOURAL: the REAL `auth` instance from src/lib/auth.ts (its admin plugin
 * options, its `onPasswordReset`, its hooks) on Better Auth's memory adapter,
 * driven through the REAL admin wrappers the routes call
 * (`src/lib/admin/auth-admin.server.ts`) and the REAL session chokepoint
 * (`getCurrentSession`). Every case carries a control — a second admin's
 * borrowed session and the target's own session — so "delete everything" can
 * never pass for the fix.
 */

const sendAppEmailMock = vi.fn();
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...a: unknown[]) => sendAppEmailMock(...a),
}));

const logErrorMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logErrorMock(...a),
}));

vi.mock("@/lib/auth-login-audit.server", () => ({ recordSessionLogin: vi.fn() }));
// Sign-up provisioning and its policy lookups are the app's, not under test.
vi.mock("@/lib/auth-signup-provisioning", () => ({ shouldProvisionSelfSignup: () => false }));

// Plugins that need a Next.js request scope are stubbed; the admin plugin is
// real — it is the thing under test.
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

const PASSWORD = "ci-only-f08-containment-password-not-for-production";
const NEW_PASSWORD = "ci-only-f08-replacement-password-not-for-production";
const MINUTE = 60 * 1000;

async function loadAuth() {
  const { auth } = await import("@/lib/auth");
  return auth;
}
type Auth = Awaited<ReturnType<typeof loadAuth>>;

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

async function signIn(auth: Auth, email: string): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return new Headers({ cookie: cookieHeaderFrom(res.headers) });
}

/** Starts impersonation the way the route does; returns the borrowed session. */
async function impersonate(auth: Auth, actor: Headers, targetId: string) {
  const res = await auth.api.impersonateUser({
    body: { userId: targetId },
    headers: actor,
    returnHeaders: true,
  });
  return {
    token: res.response.session.token,
    cookie: cookieHeaderFrom(res.headers),
  };
}

async function sessionsImpersonatedBy(auth: Auth, adminId: string) {
  const ctx = await auth.$context;
  return ctx.adapter.findMany<{ token: string; userId: string }>({
    model: "session",
    where: [{ field: "impersonatedBy", value: adminId }],
  });
}

async function sessionExists(auth: Auth, token: string): Promise<boolean> {
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.findSession(token)) !== null;
}

let worlds = 0;

/**
 * S (the compromised superadmin) and PEER (the operator containing them) are
 * both admins; T is the customer user both are impersonating. T is also
 * signed in on their own device.
 */
async function world() {
  const auth = await loadAuth();
  // The mocked memory database outlives `vi.resetModules()`, so every world
  // gets its own addresses rather than inheriting the last one's ban.
  const n = ++worlds;
  const emails = {
    s: `compromised-${n}@example.com`,
    peer: `peer-${n}@example.com`,
    t: `customer-${n}@example.com`,
  };
  const s = await seedUser(auth, emails.s, "admin");
  const peer = await seedUser(auth, emails.peer, "admin");
  const t = await seedUser(auth, emails.t, "user");

  const sHeaders = await signIn(auth, emails.s);
  const peerHeaders = await signIn(auth, emails.peer);
  const tOwn = await signIn(auth, emails.t);

  const borrowedByS = await impersonate(auth, sHeaders, t);
  const borrowedByPeer = await impersonate(auth, peerHeaders, t);

  // The premise, checked rather than assumed.
  expect(await sessionsImpersonatedBy(auth, s)).toEqual([
    expect.objectContaining({ token: borrowedByS.token, userId: t }),
  ]);
  return { auth, emails, s, peer, t, sHeaders, peerHeaders, tOwn, borrowedByS, borrowedByPeer };
}

/** The controls every containment case asserts: nobody else lost a session. */
async function expectOnlySContained(w: Awaited<ReturnType<typeof world>>) {
  expect(await sessionsImpersonatedBy(w.auth, w.s)).toEqual([]);
  expect(await sessionExists(w.auth, w.borrowedByS.token)).toBe(false);
  // The peer's borrowed session of the SAME target is untouched…
  expect(await sessionExists(w.auth, w.borrowedByPeer.token)).toBe(true);
  // …and so is the target's own session: T did nothing wrong.
  expect(await w.auth.api.getSession({ headers: w.tOwn })).not.toBeNull();
}

beforeEach(() => {
  vi.resetModules();
  sendAppEmailMock.mockReset().mockResolvedValue(undefined);
  logErrorMock.mockReset();
  ambient.headers = new Headers();
});
afterEach(() => vi.resetModules());

describe("F-08: containment reaches the sessions an admin opened as someone else", () => {
  it("THE GAP: Better Auth's own ban deletes S's rows by userId and leaves the borrowed one", async () => {
    // Why the wrappers must do it: this is the vendor call on its own.
    const w = await world();

    await w.auth.api.banUser({ body: { userId: w.s }, headers: w.peerHeaders });

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    expect(await sessionExists(w.auth, w.borrowedByS.token)).toBe(true);
  });

  it("ban (POST …/ban, the soft-delete saga, bulk) ends S's borrowed session", async () => {
    const w = await world();
    const { banBetterAuthUser } = await import("@/lib/admin/auth-admin.server");

    await banBetterAuthUser({ userId: w.s, banReason: "compromised" }, w.peerHeaders);

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
  });

  it("revoke-all (DELETE …/sessions) ends S's borrowed session", async () => {
    const w = await world();
    const { revokeAllBetterAuthUserSessions } = await import("@/lib/admin/auth-admin.server");

    await revokeAllBetterAuthUserSessions(w.s, w.peerHeaders);

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
  });

  it("admin set-password (POST …/password, mode set) ends S's borrowed session, not S's own", async () => {
    const w = await world();
    const { setBetterAuthUserPassword } = await import("@/lib/admin/auth-admin.server");

    await setBetterAuthUserPassword({ userId: w.s, newPassword: NEW_PASSWORD }, w.peerHeaders);

    await expectOnlySContained(w);
    // …and ONLY the borrowed one. Better Auth's setUserPassword deletes none
    // of S's own sessions, and admin-manager §19 tells operators so (revoke
    // all or ban to contain an admin). Pinned so that doc cannot go stale in
    // either direction: when F-10 makes set-password sign S out, flip this
    // assertion and that paragraph together.
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).not.toBeNull();
  });

  it("a completed password reset (auth.ts onPasswordReset) ends S's borrowed session", async () => {
    const w = await world();

    await w.auth.api.requestPasswordReset({ body: { email: w.emails.s } });
    const resetMail = sendAppEmailMock.mock.calls
      .map(([arg]) => arg as { templateKey: string; variables: { resetUrl?: string } })
      .find((m) => m.templateKey === "password_reset");
    const token = /\/reset-password\/([^?]+)/.exec(resetMail?.variables.resetUrl ?? "")?.[1];
    expect(token, "reset link not captured").toBeTruthy();

    await w.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token: token! } });

    // The vendor's own sweep (revokeSessionsOnPasswordReset)…
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    // …and the one it cannot express.
    await expectOnlySContained(w);
  });
});

describe("F-08: an impersonation session lives one hour, however it is refreshed", () => {
  /** Ages a session row as if it had been created `minutes` ago and kept rolling. */
  async function ageSession(auth: Auth, token: string, minutes: number) {
    const ctx = await auth.$context;
    await ctx.adapter.update({
      model: "session",
      where: [{ field: "token", value: token }],
      update: {
        createdAt: new Date(Date.now() - minutes * MINUTE),
        // The state the verifier reproduced: a holder who dropped the
        // `dont_remember` cookie has had `expiresAt` rolled to now + 8 h.
        expiresAt: new Date(Date.now() + 8 * 60 * MINUTE),
      },
    });
  }

  async function currentSessionFor(cookie: string) {
    ambient.headers = new Headers({ cookie });
    const { getCurrentSession } = await import("@/lib/auth-guard");
    return getCurrentSession();
  }

  it("the plugin is told the same hour the app enforces", async () => {
    const w = await world();
    const ctx = await w.auth.$context;
    const row = (await ctx.internalAdapter.findSession(w.borrowedByS.token))!.session;

    const lifetimeMs = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(Math.abs(lifetimeMs - IMPERSONATION_SESSION_MAX_AGE_SECONDS * 1000)).toBeLessThan(
      MINUTE,
    );
  });

  it("refuses and deletes a borrowed session past the hour even though Better Auth still honours it", async () => {
    const w = await world();
    await ageSession(w.auth, w.borrowedByS.token, 61);

    // Better Auth alone would keep serving it — the soft cap.
    expect(
      await w.auth.api.getSession({ headers: new Headers({ cookie: w.borrowedByS.cookie }) }),
    ).not.toBeNull();

    await expect(currentSessionFor(w.borrowedByS.cookie)).resolves.toBeNull();
    expect(await sessionExists(w.auth, w.borrowedByS.token)).toBe(false);
  });

  it("keeps a borrowed session inside the hour", async () => {
    const w = await world();
    await ageSession(w.auth, w.borrowedByS.token, 59);

    const session = await currentSessionFor(w.borrowedByS.cookie);

    expect(session?.user.id).toBe(w.t);
    expect(await sessionExists(w.auth, w.borrowedByS.token)).toBe(true);
  });

  it("does not cap an ORDINARY session of the same age (the operator cap is unset)", async () => {
    const w = await world();
    const ctx = await w.auth.$context;
    const own = (await ctx.internalAdapter.listSessions(w.t)).filter(
      (row) => !(row as { impersonatedBy?: string | null }).impersonatedBy,
    );
    expect(own).toHaveLength(1);
    await ageSession(w.auth, own[0]!.token, 180);

    const session = await currentSessionFor(w.tOwn.get("cookie")!);

    expect(session?.user.id).toBe(w.t);
  });
});
