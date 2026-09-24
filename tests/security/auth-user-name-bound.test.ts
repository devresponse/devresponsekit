import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { runWithEndpointContext } from "@better-auth/core/context";
import type { auth as AuthInstance } from "@/lib/auth";
import { INVALID_NAME_CODE } from "@/lib/auth-user-name";
import { EMAIL_VERIFICATION_WAIVED_FIELD } from "@/lib/auth-verification-waiver";
import { USER_NAME_MAX_LENGTH } from "@/lib/user-name";

/**
 * F-21: anyone could make the platform send a signed email carrying their own
 * unbounded text, as the `name` of a sign-up for someone else's address.
 *
 * BEHAVIOURAL: the REAL `auth` instance from src/lib/auth.ts (its callbacks,
 * hooks and plugins) on Better Auth's memory adapter, driven through
 * `auth.handler` (the function the Next catch-all mounts), `auth.api.*` and
 * `handleOAuthUserInfo` (the function the OAuth callback delegates to), as in
 * auth-email-enumeration-timing.test.ts. `sendAppEmail` is a spy, so the
 * variables an email would be rendered with can be read. Pinned:
 *
 *   1. `/sign-up/email` refuses a name with a control or bidi character, or
 *      one over the bound, with 400 `INVALID_NAME`, and gives the SAME answer
 *      for a new and an existing address (no account-existence oracle, F-20).
 *      Nothing is stored and nothing is sent.
 *   2. An accepted name is stored in its canonical spelling, and the
 *      duplicate-address answer carries that same spelling.
 *   3. The verification email greets by the address, on sign-up, on resend
 *      and on an OAuth sign-up with an unverified provider email.
 *   4. The reset email greets by the name only when the address is proven
 *      (verified and not waived).
 *   5. `/update-user` (reached by the profile route through `auth.api`)
 *      refuses the same names; a write without a name still works.
 *   6. Every other writer is bounded by the database hooks, never refused:
 *      the admin plugin's create, the internal adapter's update (the admin
 *      display-name mirror, the profile route's bearer branch), and an OAuth
 *      sign-in with a 5000-character provider name, which still signs in.
 */

const sendAppEmailMock = vi.fn();
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...args: unknown[]) => sendAppEmailMock(...args),
}));

vi.mock("@/lib/observability/logger.server", () => ({ logServerError: vi.fn() }));

// Every sign-up lands in an org that requires verification.
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
// in auth-email-enumeration-timing.test.ts. Neither acts on these endpoints.
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

const BASE = "http://localhost:3000";
const PASSWORD = "ci-only-f21-name-password-0000";
const MAX = USER_NAME_MAX_LENGTH;
const LURE =
  "Your payroll account is suspended. Re-confirm within 24h at https://evil.example/login - IT Security";

type Auth = typeof AuthInstance;
let auth: Auth;
let seq = 0;

beforeAll(async () => {
  ({ auth } = await import("@/lib/auth"));
});

beforeEach(() => {
  sendAppEmailMock.mockReset();
  sendAppEmailMock.mockResolvedValue({ outboxId: "o-1", status: "logged" });
});

function freshEmail(label: string): string {
  seq += 1;
  return `f21-${label}-${seq}@example.com`;
}

type StoredUser = Record<string, unknown> & { id: string; name: string; email: string };

async function storedUser(email: string): Promise<StoredUser | null> {
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  return (found?.user as StoredUser | undefined) ?? null;
}

/** POSTs `/sign-up/email` over HTTP, the way the sign-up form does. */
async function signUp(email: string, name: unknown): Promise<{ status: number; body: unknown }> {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ name, email, password: PASSWORD, callbackURL: "/en" }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

/** An account that exists, created server-side, with the email it sent cleared. */
async function existingUser(name = "Existing Person"): Promise<StoredUser> {
  const email = freshEmail("existing");
  await auth.api.signUpEmail({ body: { name, email, password: PASSWORD } });
  await vi.waitFor(() => expect(sendAppEmailMock).toHaveBeenCalled());
  sendAppEmailMock.mockReset();
  sendAppEmailMock.mockResolvedValue({ outboxId: "o-1", status: "logged" });
  return (await storedUser(email))!;
}

/** The variables of the one email sent with `templateKey`. */
async function sentVariables(templateKey: string): Promise<Record<string, string>> {
  await vi.waitFor(() =>
    expect(sendAppEmailMock).toHaveBeenCalledWith(expect.objectContaining({ templateKey })),
  );
  const call = sendAppEmailMock.mock.calls.find(
    (args) => (args[0] as { templateKey: string }).templateKey === templateKey,
  );
  return (call![0] as { variables: Record<string, string> }).variables;
}

const REFUSED_NAMES: Array<[string, string]> = [
  ["a line break", "Ann\nLee: your account is suspended"],
  ["a tab", "Ann\tLee"],
  ["NUL", "Ann\u0000Lee"],
  ["a right-to-left override", "Ann \u202egnp.exe"],
  ["a zero-width space", "evil\u200b.example"],
  ["one character over the bound", "x".repeat(MAX + 1)],
  ["a 100 000-character name", "x".repeat(100_000)],
  ["only whitespace", "   "],
];

describe("F-21: /sign-up/email refuses a name that breaks the rule", () => {
  it.each(REFUSED_NAMES)(
    "a name with %s gets 400 INVALID_NAME for a new AND an existing address",
    async (_label, name) => {
      const fresh = freshEmail("new");
      const existing = await existingUser();

      const forNew = await signUp(fresh, name);
      const forExisting = await signUp(existing.email, name);

      expect(forNew.status).toBe(400);
      expect(forNew.body).toMatchObject({ code: INVALID_NAME_CODE });
      // The same answer either way, so the refusal reveals no account.
      expect(forExisting).toEqual(forNew);
      expect(await storedUser(fresh)).toBeNull();
      expect(sendAppEmailMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a name that is not a string", async () => {
    const result = await signUp(freshEmail("type"), { first: "Ann" });
    expect(result.status).toBe(400);
  });
});

describe("F-21: an accepted name is stored in one spelling", () => {
  it("canonicalizes whitespace and NFC, and the duplicate answer carries the same name", async () => {
    const email = freshEmail("canonical");
    const typed = "  Rene\u0301e \u00a0  Lee ";

    const created = await signUp(email, typed);
    const duplicate = await signUp(email, typed);

    expect(created.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect((await storedUser(email))?.name).toBe("Ren\u00e9e Lee");
    // F-20 keeps the two bodies alike; the name is part of both.
    expect((created.body as { user: { name: string } }).user.name).toBe("Ren\u00e9e Lee");
    expect((duplicate.body as { user: { name: string } }).user.name).toBe("Ren\u00e9e Lee");
  });

  it(`accepts a name of exactly ${MAX} characters`, async () => {
    const email = freshEmail("max");
    const result = await signUp(email, "x".repeat(MAX));
    expect(result.status).toBe(200);
    expect((await storedUser(email))?.name).toBe("x".repeat(MAX));
  });
});

describe("F-21: the verification email greets by the address, never the name", () => {
  it("on sign-up, a lure in the name stays out of the email", async () => {
    const email = freshEmail("lure");

    const result = await signUp(email, LURE);

    expect(result.status).toBe(200);
    const variables = await sentVariables("email_verification");
    expect(variables.name).toBe(email);
    expect(JSON.stringify(variables)).not.toContain("payroll");
  });

  it("on resend (/send-verification-email)", async () => {
    const user = await existingUser(LURE);

    await auth.api.sendVerificationEmail({ body: { email: user.email } });

    const variables = await sentVariables("email_verification");
    expect(variables.name).toBe(user.email);
  });

  it("on an OAuth sign-up whose provider email is unverified", async () => {
    const email = freshEmail("oauth-unverified");
    const ctx = await auth.$context;

    const result = await runWithEndpointContext({ context: ctx } as never, () =>
      handleOAuthUserInfo({ context: ctx } as never, {
        userInfo: { id: `ms-${seq}`, email, emailVerified: false, name: LURE },
        account: { providerId: "microsoft", accountId: `ms-${seq}` },
      }),
    );

    expect(result.data?.user.email).toBe(email);
    const variables = await sentVariables("email_verification");
    expect(variables.name).toBe(email);
  });
});

describe("F-21: the reset email greets by the name only once the address is proven", () => {
  async function resetGreeting(user: StoredUser): Promise<string> {
    await auth.api.requestPasswordReset({ body: { email: user.email } });
    return (await sentVariables("password_reset")).name!;
  }

  it("an unverified account is greeted by its address", async () => {
    const user = await existingUser(LURE);
    expect(await resetGreeting(user)).toBe(user.email);
  });

  it("a verified account is greeted by its name", async () => {
    const user = await existingUser("Ada Lovelace");
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(user.id, { emailVerified: true });
    expect(await resetGreeting(user)).toBe("Ada Lovelace");
  });

  it("a verification WAIVED by policy or an org admin is not proof: the address", async () => {
    const user = await existingUser(LURE);
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(user.id, {
      emailVerified: true,
      [EMAIL_VERIFICATION_WAIVED_FIELD]: true,
    });
    expect(await resetGreeting(user)).toBe(user.email);
  });
});

describe("F-21: /update-user refuses the same names", () => {
  async function signedInHeaders(user: StoredUser): Promise<Headers> {
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(user.id, { emailVerified: true });
    const { headers } = await auth.api.signInEmail({
      body: { email: user.email, password: PASSWORD },
      returnHeaders: true,
    });
    const cookie = (headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""])
      .map((c) => c.split(";")[0])
      .join("; ");
    return new Headers({ cookie });
  }

  it.each(REFUSED_NAMES)("a name with %s is refused (400 INVALID_NAME)", async (_label, name) => {
    const user = await existingUser("Before Update");
    const headers = await signedInHeaders(user);

    await expect(auth.api.updateUser({ body: { name }, headers })).rejects.toMatchObject({
      statusCode: 400,
      body: { code: INVALID_NAME_CODE },
    });
    expect((await storedUser(user.email))?.name).toBe("Before Update");
  });

  it("an accepted name is stored canonically, and an update without a name still works", async () => {
    const user = await existingUser("Before Update");
    const headers = await signedInHeaders(user);

    await auth.api.updateUser({ body: { name: " After\u00a0 Update " }, headers });
    expect((await storedUser(user.email))?.name).toBe("After Update");

    await auth.api.updateUser({ body: { image: "https://example.com/a.png" }, headers });
    expect((await storedUser(user.email))?.name).toBe("After Update");
  });
});

describe("F-21: every other writer is bounded by the database hooks, not refused", () => {
  const HOSTILE = `\u202eEvil\r\nName\u0000 ${"x".repeat(5000)}`;

  it("the admin plugin's create (createBetterAuthUser's server call)", async () => {
    const email = freshEmail("admin-create");
    await auth.api.createUser({
      body: { email, password: PASSWORD, name: HOSTILE, data: { emailVerified: true } },
    });
    const name = (await storedUser(email))!.name;
    expect(name.startsWith("Evil Name x")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(MAX);
  });

  it("the internal adapter's update (admin display-name mirror, profile bearer branch)", async () => {
    const user = await existingUser("Plain Name");
    const ctx = await auth.$context;

    await ctx.internalAdapter.updateUser(user.id, { name: HOSTILE });
    const name = (await storedUser(user.email))!.name;
    expect(name.startsWith("Evil Name x")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(MAX);

    // A write without a name (a ban, a role change) leaves the name alone.
    await ctx.internalAdapter.updateUser(user.id, { banned: false });
    expect((await storedUser(user.email))!.name).toBe(name);
  });

  it("an OAuth sign-in with a 5000-character provider name still signs in, bounded", async () => {
    const email = freshEmail("oauth");
    const accountId = `gh-${seq}`;
    const ctx = await auth.$context;
    const signIn = (name: string, overrideUserInfo: boolean) =>
      runWithEndpointContext({ context: ctx } as never, () =>
        handleOAuthUserInfo({ context: ctx } as never, {
          userInfo: { id: accountId, email, emailVerified: true, name },
          account: { providerId: "github", accountId },
          overrideUserInfo,
        }),
      );

    const created = await signIn(HOSTILE, false);
    expect(created.error).toBeNull();
    expect(created.data?.session).toBeTruthy();
    const name = (await storedUser(email))!.name;
    expect(name.startsWith("Evil Name x")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(MAX);

    // A later sign-in that refreshes the profile from the provider.
    const refreshed = await signIn(`New\nName ${"y".repeat(5000)}`, true);
    expect(refreshed.error).toBeNull();
    const renamed = (await storedUser(email))!.name;
    expect(renamed.startsWith("New Name y")).toBe(true);
    expect(renamed.length).toBeLessThanOrEqual(MAX);
  });
});
