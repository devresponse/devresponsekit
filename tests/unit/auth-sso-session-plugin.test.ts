import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review #126 — the server-only SSO session plugin must reject a user who is
 * banned RIGHT NOW, and only such a user. Before the fix it rejected on any
 * truthy `banned` flag, so a user whose temporary ban had already elapsed was
 * refused an SSO handoff even though Better Auth's own sign-in (and the
 * machine-API paths) would have let them in and cleared the stale flag.
 *
 * The real plugin endpoint is driven here — not a re-implementation — with
 * Better Auth's cookie writer stubbed so no session store is needed.
 */
const setSessionCookie = vi.fn();
vi.mock("better-auth/cookies", () => ({
  setSessionCookie: (...args: unknown[]) => setSessionCookie(...args),
}));

const findUserById = vi.fn();
const createSession = vi.fn();

function makeCtx(userId: string, request?: Request) {
  return {
    body: { userId },
    context: { internalAdapter: { findUserById, createSession } },
    json: (value: unknown) => value,
    // better-call's router sets this from the incoming Request; a server-side
    // `auth.api.*` call (the consume route's) never carries one.
    ...(request ? { request } : {}),
  };
}

async function callCreateSsoSession(userId: string, request?: Request) {
  const { ssoSession } = await import("@/lib/auth-sso-session");
  const endpoint = ssoSession().endpoints.createSsoSession as unknown as (
    ctx: ReturnType<typeof makeCtx>,
  ) => Promise<unknown>;
  return endpoint(makeCtx(userId, request));
}

beforeEach(() => {
  setSessionCookie.mockReset();
  findUserById.mockReset();
  createSession.mockReset();
  createSession.mockResolvedValue({ id: "s-1", userId: "u-1", token: "tok" });
});

describe("ssoSession().createSsoSession — ban handling", () => {
  it("rejects a user whose temporary ban is still running", async () => {
    findUserById.mockResolvedValue({
      id: "u-1",
      banned: true,
      banExpires: new Date(Date.now() + 60 * 60 * 1000),
    });
    await expect(callCreateSsoSession("u-1")).rejects.toThrow(/banned/);
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it("rejects a user banned indefinitely (no expiry)", async () => {
    findUserById.mockResolvedValue({ id: "u-1", banned: true, banExpires: null });
    await expect(callCreateSsoSession("u-1")).rejects.toThrow(/banned/);
    expect(setSessionCookie).not.toHaveBeenCalled();
  });

  it("admits a user whose temporary ban has already elapsed (review #126)", async () => {
    findUserById.mockResolvedValue({
      id: "u-1",
      banned: true,
      banExpires: new Date(Date.now() - 60 * 60 * 1000),
    });
    await expect(callCreateSsoSession("u-1")).resolves.toEqual({ ok: true });
    expect(createSession).toHaveBeenCalledWith("u-1");
    expect(setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("admits an unbanned user", async () => {
    findUserById.mockResolvedValue({ id: "u-1", banned: false });
    await expect(callCreateSsoSession("u-1")).resolves.toEqual({ ok: true });
    expect(setSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown user before touching the session store", async () => {
    findUserById.mockResolvedValue(null);
    await expect(callCreateSsoSession("nobody")).rejects.toThrow(/unknown user/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails loudly when the session store returns nothing", async () => {
    findUserById.mockResolvedValue({ id: "u-1", banned: false });
    createSession.mockResolvedValue(null);
    await expect(callCreateSsoSession("u-1")).rejects.toThrow(/failed to create session/);
    expect(setSessionCookie).not.toHaveBeenCalled();
  });
});

/**
 * F-81 — the endpoint signs in ANY user id it is given, so it must never answer
 * HTTP. Better Auth keeps it off the router only through its SERVER_ONLY
 * metadata; the handler now refuses a call that arrives with a Request as
 * well, so a vendor change that mounted it would still sign no one in.
 */
describe("ssoSession().createSsoSession — server-only in the handler too (F-81)", () => {
  const overHttp = () =>
    new Request("https://demo.devresponse.ca/api/auth/sso-session/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "u-1" }),
    });

  it("answers 404 to a call that arrives over HTTP, before any user lookup", async () => {
    findUserById.mockResolvedValue({ id: "u-1", banned: false });
    await expect(callCreateSsoSession("u-1", overHttp())).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(findUserById).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(setSessionCookie).not.toHaveBeenCalled();
    // The server-side call shape (no Request) is served: "admits an unbanned user" above.
  });
});
