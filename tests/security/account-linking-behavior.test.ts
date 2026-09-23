import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { runWithEndpointContext } from "@better-auth/core/context";
import {
  EMAIL_VERIFICATION_WAIVED_FIELD,
  EMAIL_VERIFICATION_WAIVED_USER_FIELD,
  validateUserInfoForLinking,
} from "@/lib/auth-verification-waiver";

/**
 * §29.7.9 — accounts may be linked ONLY by verified email. BEHAVIORAL
 * counterpart of account-linking-config.test.ts: exercises better-auth's
 * real implicit-linking decision (`handleOAuthUserInfo`, the function the
 * OAuth callback route delegates to) against a memory-adapter instance
 * configured like src/lib/auth.ts.
 *
 * The pivotal semantic: `accountLinking.trustedProviders` does NOT restrict
 * which providers may link — it EXEMPTS the listed providers from the
 * incoming profile's `emailVerified` requirement. These tests fail if a
 * better-auth upgrade changes that meaning, so the empty-list policy in
 * src/lib/auth.ts can be revisited instead of silently drifting.
 */

type LinkingContext = Parameters<typeof handleOAuthUserInfo>[0];

function makeAuth(trustedProviders: string[]) {
  return betterAuth({
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    secret: "account-linking-behavior-test-secret-0000",
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders,
        allowDifferentEmails: false,
      },
    },
  });
}

/** Simulate an OAuth callback for `email` asserted by `providerId`. */
async function attemptImplicitLink(
  auth: ReturnType<typeof makeAuth>,
  opts: { providerId: string; email: string; emailVerified: boolean },
) {
  const ctx = await auth.$context;
  return handleOAuthUserInfo({ context: ctx } as unknown as LinkingContext, {
    userInfo: {
      id: `${opts.providerId}-account-1`,
      email: opts.email,
      emailVerified: opts.emailVerified,
      name: "Provider Profile",
    },
    account: {
      providerId: opts.providerId,
      accountId: `${opts.providerId}-account-1`,
    },
  });
}

async function seedLocalUser(
  auth: ReturnType<typeof makeAuth>,
  email: string,
  emailVerified: boolean,
) {
  const ctx = await auth.$context;
  // better-auth 1.7 made the creation SOURCE a required second argument (it is
  // forwarded to the database hooks). This helper stands in for a local
  // email/password sign-up, which is the case these tests are about: a local
  // account a provider might later try to link itself to.
  await ctx.internalAdapter.createUser(
    { email, name: "Local User", emailVerified },
    { method: "email-password" },
  );
}

describe("account linking behavior (better-auth implicit linking)", () => {
  const email = "victim@example.com";

  it("refuses to link an UNVERIFIED provider email to a verified local account (our config)", async () => {
    const auth = makeAuth([]);
    await seedLocalUser(auth, email, true);

    const result = await attemptImplicitLink(auth, {
      providerId: "microsoft",
      email,
      emailVerified: false,
    });

    expect(result.error).toBe("account not linked");
    expect(result.data).toBeNull();
  });

  it("links a VERIFIED provider email to a verified local account (our config)", async () => {
    const auth = makeAuth([]);
    await seedLocalUser(auth, email, true);

    const result = await attemptImplicitLink(auth, {
      providerId: "google",
      email,
      emailVerified: true,
    });

    expect(result.error).toBeNull();
    expect(result.data?.user.email).toBe(email);
    expect(result.data?.session).toBeTruthy();
  });

  it("refuses to link onto an UNVERIFIED local account even when the provider email is verified", async () => {
    // requireLocalEmailVerified defaults to true — the config must not
    // opt out (pinned in account-linking-config.test.ts).
    const auth = makeAuth([]);
    await seedLocalUser(auth, email, false);

    const result = await attemptImplicitLink(auth, {
      providerId: "google",
      email,
      emailVerified: true,
    });

    expect(result.error).toBe("account not linked");
    expect(result.data).toBeNull();
  });

  it("DOCUMENTS THE HAZARD: a trusted provider bypasses the verified-email requirement", async () => {
    // This is why src/lib/auth.ts keeps trustedProviders EMPTY. With the
    // multi-tenant Microsoft provider trusted, any Entra tenant admin could
    // assert an arbitrary unverified email and take over the matching local
    // account ("nOAuth"). If this test starts failing, better-auth changed
    // the trustedProviders semantics — re-evaluate the policy in auth.ts.
    const auth = makeAuth(["microsoft"]);
    await seedLocalUser(auth, email, true);

    const result = await attemptImplicitLink(auth, {
      providerId: "microsoft",
      email,
      emailVerified: false,
    });

    expect(result.error).toBeNull();
    expect(result.data?.session).toBeTruthy();
  });
});

/**
 * F-03 — no provider link into an account WITHOUT mailbox proof. A policy
 * waiver or an org-admin-created identity carries `emailVerified: true` but
 * nobody proved the mailbox; Better Auth's `requireLocalEmailVerified` sees a
 * verified local account and would link the real owner's Google sign-in into
 * it, while whoever registered or planted the address still holds its
 * password. The app's `validateUserInfo` gate refuses that link. These drive
 * the REAL gate inside a real Better Auth instance.
 */
describe("F-03: the unproven-email gate (real validateUserInfo)", () => {
  const email = "cfo@victimcorp.example";

  function makeGatedAuth() {
    return betterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      secret: "account-linking-behavior-test-secret-0000",
      baseURL: "http://localhost:3000",
      emailAndPassword: { enabled: true },
      user: {
        additionalFields: {
          [EMAIL_VERIFICATION_WAIVED_FIELD]: EMAIL_VERIFICATION_WAIVED_USER_FIELD,
        },
        validateUserInfo: validateUserInfoForLinking,
      },
      account: {
        accountLinking: { enabled: true, trustedProviders: [], allowDifferentEmails: false },
      },
    });
  }

  /**
   * Better Auth only runs `validateUserInfo` inside an endpoint context (the
   * OAuth callback provides one in production); run each step the same way.
   */
  async function inEndpoint<T>(
    auth: ReturnType<typeof makeGatedAuth>,
    fn: (ctx: Awaited<ReturnType<typeof makeGatedAuth>["$context"]>) => Promise<T>,
  ): Promise<T> {
    const ctx = await auth.$context;
    return runWithEndpointContext({ context: ctx } as never, () => fn(ctx));
  }

  async function seedAccount(auth: ReturnType<typeof makeGatedAuth>, unproven: boolean) {
    await inEndpoint(auth, (ctx) =>
      ctx.internalAdapter.createUser(
        {
          email,
          name: "Planted",
          emailVerified: true,
          [EMAIL_VERIFICATION_WAIVED_FIELD]: unproven,
        },
        { method: "admin" },
      ),
    );
  }

  async function linkGoogle(auth: ReturnType<typeof makeGatedAuth>) {
    return inEndpoint(auth, (ctx) =>
      handleOAuthUserInfo({ context: ctx } as unknown as LinkingContext, {
        userInfo: { id: "google-1", email, emailVerified: true, name: "Real CFO" },
        account: { providerId: "google", accountId: "google-1" },
      }),
    );
  }

  it("REFUSES a verified Google sign-in linking into an account with no mailbox proof", async () => {
    const auth = makeGatedAuth();
    await seedAccount(auth, true);

    await expect(linkGoogle(auth)).rejects.toMatchObject({
      body: expect.objectContaining({ code: "account_not_linked" }),
    });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.findUserByEmail(email, { includeAccounts: true });
    expect(user?.accounts.some((a) => a.providerId === "google")).toBe(false);
  });

  it("control: links into the same account once the mailbox is proven (marker cleared)", async () => {
    const auth = makeGatedAuth();
    await seedAccount(auth, false);

    const result = await linkGoogle(auth);

    expect(result.error).toBeNull();
    expect(result.data?.session).toBeTruthy();
  });

  it("does not interfere with a brand-new provider sign-up (no existing account)", async () => {
    const auth = makeGatedAuth();

    const result = await linkGoogle(auth);

    expect(result.error).toBeNull();
    expect(result.data?.user.email).toBe(email);
  });
});
