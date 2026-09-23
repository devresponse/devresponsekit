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
 * deleted no session at all; it now ends every one of them, S's own included
 * (F-10). Its one-hour expiry was no bound either: the plugin skips the rolling
 * refresh only while the signed `dont_remember` cookie rides along, so a holder
 * who drops it keeps the row alive 8 h at a time.
 *
 * F-10 — the same gap in the self-service sweeps: changing the password with
 * `revokeOtherSessions`, or "Sign out other sessions", ended S's own sessions
 * and left the one S was driving as T. And replacing a password (reset or
 * admin set) left every bearer credential of the account alive; both paths now
 * hand it to `revokeBearerCredentialsOf`, whose SQL is proven against Postgres
 * in tests/db/credential-eviction.db.test.ts. Here it is a spy, so the cases
 * pin WHO calls it, with what, and that its failure cannot undo a reset.
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

const revokeBearerCredentialsMock = vi.fn();
vi.mock("@/lib/api-auth/credential-eviction.server", () => ({
  revokeBearerCredentialsOf: (...a: unknown[]) => revokeBearerCredentialsMock(...a),
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

/** Requests a reset for `email` and returns the token from the outbox email. */
async function resetTokenFor(auth: Auth, email: string): Promise<string> {
  sendAppEmailMock.mockClear();
  await auth.api.requestPasswordReset({ body: { email } });
  const resetMail = sendAppEmailMock.mock.calls
    .map(([arg]) => arg as { templateKey: string; variables: { resetUrl?: string } })
    .find((m) => m.templateKey === "password_reset");
  const token = /\/reset-password\/([^?]+)/.exec(resetMail?.variables.resetUrl ?? "")?.[1];
  expect(token, "reset link not captured").toBeTruthy();
  return token!;
}

beforeEach(() => {
  vi.resetModules();
  sendAppEmailMock.mockReset().mockResolvedValue(undefined);
  logErrorMock.mockReset();
  revokeBearerCredentialsMock.mockReset().mockResolvedValue({ apiKeyIds: [], oauthClientIds: [] });
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

    await banBetterAuthUser({
      userId: w.s,
      banReason: "compromised",
      actorBetterAuthUserId: w.peer,
    });

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
  });

  it("revoke-all (DELETE …/sessions) ends S's borrowed session", async () => {
    const w = await world();
    const { revokeAllBetterAuthUserSessions } = await import("@/lib/admin/auth-admin.server");

    await revokeAllBetterAuthUserSessions(w.s);

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
  });

  it("admin set-password (POST …/password, mode set) ends S's borrowed session AND S's own (F-10)", async () => {
    const w = await world();
    const { setBetterAuthUserPassword } = await import("@/lib/admin/auth-admin.server");

    await setBetterAuthUserPassword(
      {
        userId: w.s,
        newPassword: NEW_PASSWORD,
        setBy: { betterAuthUserId: w.peer, appUserId: "app-peer" },
      },
      w.peerHeaders,
    );

    await expectOnlySContained(w);
    // F-10: Better Auth's setUserPassword deletes none of S's own sessions, so
    // a browser already signed in as S (possibly the attacker's) used to keep
    // S's full authority. admin-manager §19 now says a new password signs the
    // user out; this pins that doc in both directions.
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    // The operator doing it is not signed out.
    expect(await w.auth.api.getSession({ headers: w.peerHeaders })).not.toBeNull();
  });

  it("a completed password reset (auth.ts onPasswordReset) ends S's borrowed session", async () => {
    const w = await world();

    const token = await resetTokenFor(w.auth, w.emails.s);
    await w.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } });

    // The vendor's own sweep (revokeSessionsOnPasswordReset)…
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    // …and the one it cannot express.
    await expectOnlySContained(w);
  });
});

describe("F-10: signing out one's other sessions ends the ones opened as someone else", () => {
  it("change-password with revokeOtherSessions (the account form) ends S's borrowed session", async () => {
    const w = await world();
    const sOther = await signIn(w.auth, w.emails.s);

    await w.auth.api.changePassword({
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
      headers: w.sHeaders,
    });

    // The vendor's sweep…
    expect(await w.auth.api.getSession({ headers: sOther })).toBeNull();
    // …and the one it cannot express.
    await expectOnlySContained(w);
    // A password CHANGE is not a compromise response: the caller proved the
    // current password, so the account's API keys and clients stay.
    expect(revokeBearerCredentialsMock).not.toHaveBeenCalled();
  });

  it("the same over HTTP: the hook sees the route pattern and the parsed JSON body", async () => {
    // `auth.handler` is what the Next catch-all mounts. The after-hook reads
    // `ctx.path` and `ctx.body`, which the router fills from the Request, so
    // this is the path production takes.
    const w = await world();
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

    const res = await w.auth.handler(
      new Request(`${baseUrl}/api/auth/change-password`, {
        method: "POST",
        headers: {
          cookie: w.sHeaders.get("cookie")!,
          "content-type": "application/json",
          origin: baseUrl,
        },
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          revokeOtherSessions: true,
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expectOnlySContained(w);
  });

  it("change-password WITHOUT revokeOtherSessions keeps every session, the borrowed one included", async () => {
    const w = await world();

    await w.auth.api.changePassword({
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      headers: w.sHeaders,
    });

    expect(await sessionExists(w.auth, w.borrowedByS.token)).toBe(true);
  });

  it("a refused change-password (wrong current password) ends nothing", async () => {
    const w = await world();

    await expect(
      w.auth.api.changePassword({
        body: {
          currentPassword: "not-the-current-password",
          newPassword: NEW_PASSWORD,
          revokeOtherSessions: true,
        },
        headers: w.sHeaders,
      }),
    ).rejects.toThrow();

    expect(await sessionExists(w.auth, w.borrowedByS.token)).toBe(true);
  });

  it("'Sign out other sessions' (/revoke-other-sessions) ends S's borrowed session", async () => {
    const w = await world();
    const sOther = await signIn(w.auth, w.emails.s);

    await w.auth.api.revokeOtherSessions({ headers: w.sHeaders });

    expect(await w.auth.api.getSession({ headers: sOther })).toBeNull();
    // The caller's own current session survives, as the vendor intends.
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).not.toBeNull();
    await expectOnlySContained(w);
  });

  it("/revoke-sessions (closed over HTTP, still callable server-side) ends it too", async () => {
    const w = await world();

    await w.auth.api.revokeSessions({ headers: w.sHeaders });

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
  });

  it("an impersonated caller's sweep does not end the BORROWED user's own borrowed sessions", async () => {
    // Server-side only (over HTTP the before-hook refuses it, IMP-3): the
    // session's user is T, but T did not ask. Give T a borrowed session of its
    // own to prove the hook leaves it alone.
    const w = await world();
    const ctx = await w.auth.$context;
    await ctx.internalAdapter.updateUser(w.t, { role: "admin" });
    const tBorrowsPeer = await impersonate(w.auth, w.tOwn, w.peer);

    await w.auth.api.revokeOtherSessions({
      headers: new Headers({ cookie: w.borrowedByS.cookie }),
    });

    expect(await sessionExists(w.auth, tBorrowsPeer.token)).toBe(true);
  });

  it("a failure to end the borrowed sessions is logged and does not fail the password change", async () => {
    const w = await world();
    const sOther = await signIn(w.auth, w.emails.s);
    const ctx = await w.auth.$context;
    // Fail ONLY the by-`impersonatedBy` delete; the vendor's own sweep goes
    // through the same adapter and must still run.
    const realDeleteMany = ctx.adapter.deleteMany.bind(ctx.adapter);
    const deleteMany = vi
      .spyOn(ctx.adapter, "deleteMany")
      .mockImplementation(async (args: Parameters<typeof realDeleteMany>[0]) => {
        if (args.where.some((clause) => clause.field === "impersonatedBy")) {
          throw new Error("db down");
        }
        return realDeleteMany(args);
      });

    try {
      await expect(
        w.auth.api.changePassword({
          body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: true },
          headers: w.sHeaders,
        }),
      ).resolves.toEqual(expect.objectContaining({ token: expect.any(String) }));
    } finally {
      deleteMany.mockRestore();
    }

    expect(await w.auth.api.getSession({ headers: sOther })).toBeNull();
    expect(logErrorMock).toHaveBeenCalledWith(
      "could not end impersonation sessions after a session sweep",
      expect.objectContaining({ betterAuthUserId: w.s, path: "/change-password" }),
    );
  });
});

describe("F-10: replacing a password revokes the account's bearer credentials", () => {
  it("a completed password reset hands the account to the credential cut-off, as the account", async () => {
    const w = await world();

    const token = await resetTokenFor(w.auth, w.emails.s);
    await w.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } });

    expect(revokeBearerCredentialsMock).toHaveBeenCalledTimes(1);
    expect(revokeBearerCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: w.s,
        trigger: "password_reset",
        actorBetterAuthUserId: w.s,
      }),
    );
  });

  it("a completed reset ends every session of the account BEFORE it revokes the credentials", async () => {
    // Better Auth deletes the account's sessions only after `onPasswordReset`
    // returns. Revoking credentials first left the thief's cookie valid for the
    // whole revoke, long enough to mint a key the revoke never saw.
    const w = await world();
    const order: string[] = [];
    revokeBearerCredentialsMock.mockImplementation(async () => {
      order.push(
        (await w.auth.api.getSession({ headers: w.sHeaders })) === null &&
          !(await sessionExists(w.auth, w.borrowedByS.token))
          ? "credentials-after-sessions"
          : "credentials-before-sessions",
      );
      return { apiKeyIds: [], oauthClientIds: [] };
    });

    const token = await resetTokenFor(w.auth, w.emails.s);
    await w.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } });

    expect(order).toEqual(["credentials-after-sessions"]);
    await expectOnlySContained(w);
  });

  it("over HTTP, the cut-off's audit rows get the reset request itself (user agent, IP)", async () => {
    const w = await world();
    const token = await resetTokenFor(w.auth, w.emails.s);
    const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

    const res = await w.auth.handler(
      new Request(`${baseUrl}/api/auth/reset-password`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: baseUrl,
          "user-agent": "f10-reset-agent",
        },
        body: JSON.stringify({ newPassword: NEW_PASSWORD, token }),
      }),
    );

    expect(res.status).toBe(200);
    expect(revokeBearerCredentialsMock).toHaveBeenCalledTimes(1);
    const [arg] = revokeBearerCredentialsMock.mock.calls[0] as [{ request?: Request }];
    expect(arg.request?.headers.get("user-agent")).toBe("f10-reset-agent");
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
  });

  it("a failure to end the sessions early is logged; the credentials still go and Better Auth still signs S out", async () => {
    const w = await world();
    const ctx = await w.auth.$context;
    // Fail only OUR early delete; Better Auth's own sweep after the hook goes
    // through the same adapter method and must still run.
    const deleteUserSessions = vi
      .spyOn(ctx.internalAdapter, "deleteUserSessions")
      .mockRejectedValueOnce(new Error("db down"));

    try {
      const token = await resetTokenFor(w.auth, w.emails.s);
      await expect(
        w.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } }),
      ).resolves.toEqual({ status: true });
    } finally {
      deleteUserSessions.mockRestore();
    }

    expect(logErrorMock).toHaveBeenCalledWith(
      "could not end the account's sessions before revoking its credentials",
      expect.objectContaining({ betterAuthUserId: w.s }),
    );
    expect(revokeBearerCredentialsMock).toHaveBeenCalledTimes(1);
    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
  });

  it("a failed cut-off is logged and neither undoes the reset nor skips the session sweeps", async () => {
    const w = await world();
    revokeBearerCredentialsMock.mockRejectedValue(new Error("db down"));

    const token = await resetTokenFor(w.auth, w.emails.s);
    await expect(
      w.auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } }),
    ).resolves.toEqual({ status: true });

    expect(await w.auth.api.getSession({ headers: w.sHeaders })).toBeNull();
    await expectOnlySContained(w);
    expect(logErrorMock).toHaveBeenCalledWith(
      "could not revoke bearer credentials after a password reset",
      expect.objectContaining({ betterAuthUserId: w.s }),
    );
    // The new password works; the old one does not.
    await expect(
      w.auth.api.signInEmail({ body: { email: w.emails.s, password: NEW_PASSWORD } }),
    ).resolves.toBeTruthy();
  });

  it("admin set-password revokes them in the ADMIN's name, after every session ended", async () => {
    const w = await world();
    const order: string[] = [];
    revokeBearerCredentialsMock.mockImplementation(async () => {
      // Ordering: by the time credentials go, no session of S's is left.
      order.push(
        (await w.auth.api.getSession({ headers: w.sHeaders })) === null &&
          !(await sessionExists(w.auth, w.borrowedByS.token))
          ? "credentials-after-sessions"
          : "credentials-before-sessions",
      );
      return { apiKeyIds: [], oauthClientIds: [] };
    });
    const { setBetterAuthUserPassword } = await import("@/lib/admin/auth-admin.server");

    await setBetterAuthUserPassword(
      {
        userId: w.s,
        newPassword: NEW_PASSWORD,
        setBy: { betterAuthUserId: w.peer, appUserId: "app-peer", requestId: "req-1" },
      },
      w.peerHeaders,
    );

    expect(revokeBearerCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: w.s,
        trigger: "password_set",
        actorBetterAuthUserId: w.peer,
        revokedByAppUserId: "app-peer",
        requestId: "req-1",
      }),
    );
    expect(order).toEqual(["credentials-after-sessions"]);
  });

  it("admin set-password reports failure when the credentials could not be revoked", async () => {
    // The route turns this into its 502 + failure audit, so the operator
    // retries instead of believing the account is contained.
    const w = await world();
    revokeBearerCredentialsMock.mockRejectedValue(new Error("db down"));
    const { setBetterAuthUserPassword } = await import("@/lib/admin/auth-admin.server");

    await expect(
      setBetterAuthUserPassword(
        {
          userId: w.s,
          newPassword: NEW_PASSWORD,
          setBy: { betterAuthUserId: w.peer, appUserId: "app-peer" },
        },
        w.peerHeaders,
      ),
    ).rejects.toThrow("db down");
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
