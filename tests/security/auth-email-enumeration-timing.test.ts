import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextServer from "next/server";
import type { auth as AuthInstance } from "@/lib/auth";
import { RESPONSE_FLOOR_MS } from "@/lib/auth-response-floor";

/**
 * F-20: the public auth endpoints must not reveal through response time
 * whether an account exists.
 *
 * `/request-password-reset`, `/send-verification-email` and `/sign-up/email`
 * give the same answer for every address, but they used to await the email
 * send, which happens only for a real (or, on sign-up, a new) account: the
 * outbox INSERT plus the provider call, 200-800 ms against a few ms. An
 * attacker read account existence off the clock.
 *
 * BEHAVIOURAL: the REAL `auth` instance from src/lib/auth.ts (its callbacks,
 * its hooks, its plugins) on Better Auth's memory adapter, driven through
 * `auth.handler`, the function the Next catch-all mounts. `sendAppEmail` is
 * replaced by one that NEVER settles, so any response still waiting on it
 * loses the race below. Pinned:
 *
 *   1. For existing, unknown and new addresses alike, every endpoint answers
 *      while the send is still pending, and no sooner than the floor.
 *   2. A failed send is logged with the app logger. It does not fail the
 *      request, and `/send-verification-email` no longer turns it into a 500
 *      that only a real unverified account could produce.
 *   3. Inside a request scope, the send is scheduled with `after()` and has
 *      not started when the response is ready.
 *   4. The administrator's server-side reset call is not slowed by the floor.
 *   5. Sign-up's body does not give it away either: a duplicate address gets
 *      the same user object as a new one (`customSyntheticUser`), where the
 *      vendor default returned `role: null` against a real `role: "user"`.
 *
 * Outside a request scope, as here, the real `after()` throws, so cases 1 and
 * 2 also exercise the fallback path that seeds and scripts take.
 */

const sendAppEmailMock = vi.fn();
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...args: unknown[]) => sendAppEmailMock(...args),
}));

const logServerErrorMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...args: unknown[]) => logServerErrorMock(...args),
}));

// Every sign-up lands in an org that requires verification, so a new account
// is unverified and gets a verification email.
vi.mock("@/lib/auth-policy.server", () => ({
  resolveSignupPolicy: async () => ({
    requireEmailVerification: true,
    signupApprovalMode: "admin_approval",
    allowedAuthMethods: null,
    autoApproveEmailDomains: null,
    source: "organization",
  }),
}));
vi.mock("@/lib/user-provisioning.server", () => ({
  provisionUserFromAuth: async () => undefined,
  reevaluatePendingActivation: async () => undefined,
}));
vi.mock("@/lib/invitations.server", () => ({ findValidInvitationByToken: async () => null }));
vi.mock("@/lib/auth-login-audit.server", () => ({ recordSessionLogin: vi.fn() }));

// Plugins that need a Next.js request scope or the SSO schema are stubbed, as
// in signup-policy-organization-hint.test.ts. Neither acts on these endpoints.
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));
vi.mock("@/lib/auth-sso-session", () => ({ ssoSession: () => ({ id: "sso-session" }) }));

vi.mock("@/db/database", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: () => Promise.resolve(undefined),
  };
  return {
    pgPool: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    db: { selectFrom: () => chain },
  };
});

// `after()` is the real one unless a test simulates a request scope.
let afterTasks: unknown[] | null = null;
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof NextServer>();
  return {
    ...actual,
    after: (task: Parameters<typeof actual.after>[0]) => {
      if (afterTasks) {
        afterTasks.push(task);
        return;
      }
      return actual.after(task);
    },
  };
});

const BASE = "http://localhost:3000";
const PASSWORD = "ci-only-f20-timing-password-0000";
/** Far above the floor plus jitter; a response still waiting on the send never makes it. */
const RACE_MS = 3_000;

type Auth = typeof AuthInstance;
let auth: Auth;
let seq = 0;

const neverSettles = () => new Promise<never>(() => undefined);

beforeAll(async () => {
  ({ auth } = await import("@/lib/auth"));
});

beforeEach(() => {
  afterTasks = null;
  sendAppEmailMock.mockReset();
  sendAppEmailMock.mockResolvedValue({ outboxId: "o-1", status: "logged" });
  logServerErrorMock.mockReset();
});

/** An account that exists and is still unverified, created server-side (no floor). */
async function existingUnverifiedUser(): Promise<string> {
  seq += 1;
  const email = `f20-existing-${seq}@example.com`;
  await auth.api.signUpEmail({ body: { name: "Existing", email, password: PASSWORD } });
  // Setting up the account sends its own verification email; start clean.
  await vi.waitFor(() => expect(sendAppEmailMock).toHaveBeenCalled());
  sendAppEmailMock.mockReset();
  return email;
}

function unknownEmail(): string {
  seq += 1;
  return `f20-nobody-${seq}@example.com`;
}

type Endpoint = "/request-password-reset" | "/send-verification-email" | "/sign-up/email";

function bodyFor(endpoint: Endpoint, email: string): Record<string, unknown> {
  if (endpoint === "/request-password-reset") return { email, redirectTo: "/en/reset-password" };
  if (endpoint === "/send-verification-email") return { email, callbackURL: "/en" };
  return { name: "Probe", email, password: PASSWORD, callbackURL: "/en" };
}

/** POSTs over HTTP and races the response against {@link RACE_MS}. */
async function post(
  endpoint: Endpoint,
  email: string,
): Promise<{ outcome: "response"; status: number; elapsed: number } | { outcome: "timeout" }> {
  const start = performance.now();
  const response = auth
    .handler(
      new Request(`${BASE}/api/auth${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(bodyFor(endpoint, email)),
      }),
    )
    .then((res) => ({
      outcome: "response" as const,
      status: res.status,
      elapsed: performance.now() - start,
    }));
  const timeout = new Promise<{ outcome: "timeout" }>((resolve) =>
    setTimeout(() => resolve({ outcome: "timeout" }), RACE_MS),
  );
  return Promise.race([response, timeout]);
}

function sentTemplates(): string[] {
  return sendAppEmailMock.mock.calls.map(
    (call) => (call[0] as { templateKey: string }).templateKey,
  );
}

describe("F-20: responses do not wait for the email send", () => {
  const cases: Array<{
    endpoint: Endpoint;
    who: string;
    email: () => Promise<string> | string;
    sends: string[];
  }> = [
    {
      endpoint: "/request-password-reset",
      who: "an existing account",
      email: existingUnverifiedUser,
      sends: ["password_reset"],
    },
    {
      endpoint: "/request-password-reset",
      who: "an unknown address",
      email: unknownEmail,
      sends: [],
    },
    {
      endpoint: "/send-verification-email",
      who: "an existing unverified account",
      email: existingUnverifiedUser,
      sends: ["email_verification"],
    },
    {
      endpoint: "/send-verification-email",
      who: "an unknown address",
      email: unknownEmail,
      sends: [],
    },
    {
      endpoint: "/sign-up/email",
      who: "a new address",
      email: unknownEmail,
      sends: ["email_verification"],
    },
    {
      endpoint: "/sign-up/email",
      who: "an existing account",
      email: existingUnverifiedUser,
      sends: [],
    },
  ];

  it.each(cases)(
    "$endpoint answers $who while a never-settling send is pending, and not before the floor",
    async ({ endpoint, email, sends }) => {
      const address = await email();
      sendAppEmailMock.mockImplementation(neverSettles);

      const result = await post(endpoint, address);

      expect(result.outcome).toBe("response");
      if (result.outcome !== "response") return;
      expect(result.status).toBe(200);
      // Timers can fire a millisecond early on some platforms.
      expect(result.elapsed).toBeGreaterThanOrEqual(RESPONSE_FLOOR_MS - 2);
      // Outside a request scope the send has been started, not dropped.
      expect(sentTemplates()).toEqual(sends);
      if (sends.length > 0) {
        expect(sendAppEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: address }));
      }
    },
  );
});

describe("F-20: a failed send is logged, and the response does not change", () => {
  it.each([
    { endpoint: "/request-password-reset" as const, templateKey: "password_reset" },
    { endpoint: "/send-verification-email" as const, templateKey: "email_verification" },
  ])("$endpoint still answers 200 and logs the failure", async ({ endpoint, templateKey }) => {
    const address = await existingUnverifiedUser();
    const failure = new Error("outbox insert failed");
    sendAppEmailMock.mockRejectedValue(failure);

    const result = await post(endpoint, address);

    expect(result).toMatchObject({ outcome: "response", status: 200 });
    await vi.waitFor(() =>
      expect(logServerErrorMock).toHaveBeenCalledWith(
        "deferred email send failed",
        expect.objectContaining({ err: failure, templateKey }),
      ),
    );
  });
});

describe("F-20: inside a request scope the send starts only after the response", () => {
  it.each([
    { endpoint: "/request-password-reset" as const, templateKey: "password_reset" },
    { endpoint: "/send-verification-email" as const, templateKey: "email_verification" },
    { endpoint: "/sign-up/email" as const, templateKey: "email_verification" },
  ])(
    "$endpoint hands the send to after() and has sent nothing yet",
    async ({ endpoint, templateKey }) => {
      const address =
        endpoint === "/sign-up/email" ? unknownEmail() : await existingUnverifiedUser();
      afterTasks = [];

      const result = await post(endpoint, address);

      expect(result).toMatchObject({ outcome: "response", status: 200 });
      expect(sendAppEmailMock).not.toHaveBeenCalled();
      expect(afterTasks).toHaveLength(1);

      // What Next does once the response has been sent.
      await (afterTasks[0] as () => Promise<void>)();
      expect(sendAppEmailMock).toHaveBeenCalledTimes(1);
      expect(sendAppEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: address, templateKey }),
      );
    },
  );
});

describe("F-20: sign-up's response body does not reveal an existing account", () => {
  /** POSTs /sign-up/email over HTTP and returns the status and parsed body. */
  async function signUpBody(email: string): Promise<{ status: number; body: unknown }> {
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify(bodyFor("/sign-up/email", email)),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  /** Keys that differ on every call, new account or not. */
  const PER_CALL = ["id", "createdAt", "updatedAt"];

  /**
   * The user object Postgres would have returned. `INSERT ... RETURNING *`
   * gives every column, NULL where nothing was written (`image`, `banReason`
   * and `banExpires` have no column default; see better-auth-schema.sql). The
   * memory adapter leaves such a key undefined, and JSON drops it. So a key
   * only the synthetic user carries counts as present in the real one when
   * its value is null, and in the same place in the order.
   */
  function asPostgresReturns(
    real: Record<string, unknown>,
    synthetic: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(synthetic)) {
      if (key in real) out[key] = real[key];
      else if (synthetic[key] === null) out[key] = null;
    }
    for (const key of Object.keys(real)) if (!(key in out)) out[key] = real[key];
    return out;
  }

  it("answers a new and an existing address with the same user object (keys, order and values)", async () => {
    const email = unknownEmail();

    const created = await signUpBody(email);
    const duplicate = await signUpBody(email);

    expect(created.status).toBe(200);
    expect(duplicate.status).toBe(200);
    const real = created.body as { token: unknown; user: Record<string, unknown> };
    const synthetic = duplicate.body as { token: unknown; user: Record<string, unknown> };
    expect(Object.keys(synthetic)).toEqual(Object.keys(real));
    expect(synthetic.token).toBe(real.token);
    const realUser = asPostgresReturns(real.user, synthetic.user);
    // Key ORDER is part of the body an attacker reads, so compare it as sent.
    expect(Object.keys(synthetic.user)).toEqual(Object.keys(realUser));
    const withoutPerCall = (user: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(user).filter(([key]) => !PER_CALL.includes(key)));
    expect(withoutPerCall(synthetic.user)).toEqual(withoutPerCall(realUser));
    // The admin plugin's fields in particular: a real row gets role "user"
    // from its create hook, which the vendor's default synthetic user lacks.
    expect(real.user).toMatchObject({ role: "user", banned: false });
    expect(synthetic.user).toMatchObject({ role: "user", banned: false });
    // The per-call fields are present and well-formed on both.
    for (const user of [real.user, synthetic.user]) {
      expect(typeof user.id).toBe("string");
      expect(Number.isNaN(Date.parse(String(user.createdAt)))).toBe(false);
      expect(Number.isNaN(Date.parse(String(user.updatedAt)))).toBe(false);
    }
    expect(synthetic.user.id).not.toBe(real.user.id);
  });
});

describe("F-20: the floor applies to HTTP only", () => {
  it("does not slow the administrator's server-side reset call (auth.api, no request)", async () => {
    const address = await existingUnverifiedUser();

    const start = performance.now();
    await auth.api.requestPasswordReset({ body: { email: address } });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(RESPONSE_FLOOR_MS / 2);
    await vi.waitFor(() =>
      expect(sendAppEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: address, templateKey: "password_reset" }),
      ),
    );
  });
});
