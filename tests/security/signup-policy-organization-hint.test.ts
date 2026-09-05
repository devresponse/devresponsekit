import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG_SIGNUP_HINT_COOKIE } from "@/lib/scoped-auth";

/**
 * Review 2026-09-04 #2 — the sign-up verification waiver must follow the org
 * the account will LAND in, and a waived verification must never pass for a
 * mailbox proof.
 *
 * BEHAVIORAL: the REAL `auth` instance from src/lib/auth.ts (its hooks, its
 * `user.additionalFields`, its `requireEmailVerification`), backed by Better
 * Auth's memory adapter instead of the pg pool, driven through the same
 * `auth.api.signUpEmail` the public sign-up endpoint calls. Policy resolution
 * and provisioning are mocked at the module boundary so each side of the
 * contract can be pinned:
 *
 *   1. The attack: the default org waives verification, the hinted org is
 *      strict. A sign-up carrying `organizationHint=<strict org>` (plus an
 *      attacker-supplied `emailVerified: true` / `emailVerificationWaived:
 *      true` in the body) is stored UNVERIFIED and UNWAIVED, receives a
 *      verification mail, and provisioning is told `emailVerified: false`
 *      for that hint — so it can never be domain auto-approved.
 *   2. The legitimate waiver: the hinted org waives verification → stored
 *      verified AND marked waived; provisioning receives the marker; no
 *      verification mail.
 *   3. Precedence: the `before` hook hands `resolveSignupPolicy` exactly the
 *      hint the `after` hook hands `provisionUserFromAuth`.
 *   4. An invitation-proven sign-up is verified WITHOUT the waiver marker
 *      (it is real mailbox proof) and never consults the policy.
 *   5. The social path (session hook): the `org_signup_hint` cookie is the
 *      hint provisioning receives, with the marker read off the user row;
 *      a pending user's re-evaluation carries the marker too.
 */

const resolveSignupPolicyMock = vi.fn();
vi.mock("@/lib/auth-policy.server", () => ({
  resolveSignupPolicy: (...a: unknown[]) => resolveSignupPolicyMock(...a),
}));

const provisionMock = vi.fn();
const reevaluateMock = vi.fn();
vi.mock("@/lib/user-provisioning.server", () => ({
  provisionUserFromAuth: (...a: unknown[]) => provisionMock(...a),
  reevaluatePendingActivation: (...a: unknown[]) => reevaluateMock(...a),
}));

const findInvitationMock = vi.fn();
vi.mock("@/lib/invitations.server", () => ({
  findValidInvitationByToken: (...a: unknown[]) => findInvitationMock(...a),
}));

const sendAppEmailMock = vi.fn();
vi.mock("@/lib/email/send.server", () => ({
  sendAppEmail: (...a: unknown[]) => sendAppEmailMock(...a),
}));

const logErrorMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logErrorMock(...a),
}));

vi.mock("@/lib/auth-login-audit.server", () => ({
  recordSessionLogin: vi.fn(),
}));

// Plugins that need a Next.js request scope / the SSO schema are stubbed;
// the admin plugin stays real (it only adds user columns and endpoints).
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({ id: "next-cookies" }) }));
vi.mock("@/lib/auth-sso-session", () => ({ ssoSession: () => ({ id: "sso-session" }) }));

// The app_users lookup the session hook makes; `null` = brand-new user.
let existingAppUser: { id: string; status: string } | null = null;

vi.mock("@/db/database", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: () => Promise.resolve(existingAppUser ?? undefined),
  };
  return {
    pgPool: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    db: { selectFrom: () => chain },
  };
});

const STRICT_ORG = "victim";
const LAX_ORG = "open";
const PASSWORD = "ci-only-signup-hint-password-not-for-production";

const STRICT_POLICY = {
  requireEmailVerification: true,
  signupApprovalMode: "admin_approval",
  allowedAuthMethods: null,
  autoApproveEmailDomains: ["victim.com"],
  source: "organization",
};
const LAX_POLICY = {
  requireEmailVerification: false,
  signupApprovalMode: "admin_approval",
  allowedAuthMethods: null,
  autoApproveEmailDomains: null,
  source: "organization",
};

type StoredUser = Record<string, unknown> & { emailVerified: boolean };

async function loadAuth() {
  const { auth } = await import("@/lib/auth");
  return auth;
}

async function findStoredUser(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  email: string,
): Promise<StoredUser> {
  const ctx = await auth.$context;
  const found = (await ctx.internalAdapter.findUserByEmail(email)) as
    { user: StoredUser } | StoredUser | null;
  if (!found) {
    throw new Error(`user ${email} not stored`);
  }
  return "user" in found && found.user && typeof found.user === "object"
    ? (found.user as StoredUser)
    : (found as StoredUser);
}

function signUp(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  body: Record<string, unknown>,
): Promise<unknown> {
  return auth.api.signUpEmail({
    body: {
      name: "Sign-up",
      password: PASSWORD,
      ...body,
    } as NonNullable<Parameters<typeof auth.api.signUpEmail>[0]>["body"],
  });
}

beforeEach(() => {
  vi.resetModules();
  resolveSignupPolicyMock.mockReset();
  // The finding's topology: everything except the strict org waives
  // verification (the default org, any domain-routed org).
  resolveSignupPolicyMock.mockImplementation(
    async (_input: unknown, options?: { organizationHint?: string }) =>
      options?.organizationHint === STRICT_ORG ? STRICT_POLICY : LAX_POLICY,
  );
  provisionMock.mockReset();
  provisionMock.mockResolvedValue(undefined);
  reevaluateMock.mockReset();
  reevaluateMock.mockResolvedValue(undefined);
  findInvitationMock.mockReset();
  findInvitationMock.mockResolvedValue(null);
  sendAppEmailMock.mockReset();
  sendAppEmailMock.mockResolvedValue(undefined);
  logErrorMock.mockReset();
  existingAppUser = null;
});
afterEach(() => vi.resetModules());

describe("email/password sign-up hinted at a STRICT org while the default org waives verification (review #2)", () => {
  it("stores the account UNVERIFIED and UNWAIVED, mails a verification link, and provisions it unverified", async () => {
    const auth = await loadAuth();
    const email = "ceo@victim.com";

    await signUp(auth, {
      email,
      organizationHint: STRICT_ORG,
      // Attacker-supplied: both must be ignored (sign-up forces
      // emailVerified:false; the marker is `input: false`).
      emailVerified: true,
      emailVerificationWaived: true,
    });

    const stored = await findStoredUser(auth, email);
    expect(stored.emailVerified).toBe(false);
    expect(stored.emailVerificationWaived).not.toBe(true);

    // The hook resolved the policy of the HINTED org, not the default.
    expect(resolveSignupPolicyMock).toHaveBeenCalledTimes(1);
    expect(resolveSignupPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "email", email, emailVerified: false }),
      { organizationHint: STRICT_ORG },
    );

    // Provisioning targets the same org and is told the truth.
    expect(provisionMock).toHaveBeenCalledTimes(1);
    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email,
        emailVerified: false,
        emailVerificationWaived: false,
        organizationHint: STRICT_ORG,
        provider: "email",
      }),
    );

    // A real verification is still demanded.
    expect(sendAppEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: email, templateKey: "email_verification" }),
    );
  });

  it("the before hook and provisioning see ONE hint — precedence cannot diverge", async () => {
    const auth = await loadAuth();
    await signUp(auth, { email: "someone@victim.com", organizationHint: STRICT_ORG });

    const policyHint = resolveSignupPolicyMock.mock.calls[0]?.[1]?.organizationHint;
    const provisionHint = provisionMock.mock.calls[0]?.[0]?.organizationHint;
    expect(policyHint).toBe(STRICT_ORG);
    expect(provisionHint).toBe(policyHint);
  });
});

describe("email/password sign-up whose TARGET org waives verification (legitimate waiver)", () => {
  it("stores the account verified WITH the waiver marker, skips the verification mail, and tells provisioning", async () => {
    const auth = await loadAuth();
    const email = "new@open.example";

    await signUp(auth, { email, organizationHint: LAX_ORG });

    const stored = await findStoredUser(auth, email);
    expect(stored.emailVerified).toBe(true);
    expect(stored.emailVerificationWaived).toBe(true);

    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email,
        emailVerified: true,
        emailVerificationWaived: true,
        organizationHint: LAX_ORG,
      }),
    );
    expect(sendAppEmailMock).not.toHaveBeenCalled();
  });

  it("with no hint at all, the default org's waiver applies and is marked as such", async () => {
    const auth = await loadAuth();
    const email = "plain@example.com";

    await signUp(auth, { email });

    const stored = await findStoredUser(auth, email);
    expect(stored.emailVerified).toBe(true);
    expect(stored.emailVerificationWaived).toBe(true);
    expect(resolveSignupPolicyMock).toHaveBeenCalledWith(expect.anything(), {
      organizationHint: undefined,
    });
    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerificationWaived: true, organizationHint: undefined }),
    );
  });
});

describe("invitation-backed sign-up (mailbox proof, not a waiver)", () => {
  it("is verified WITHOUT the waiver marker and never consults the policy", async () => {
    const auth = await loadAuth();
    const email = "invited@victim.com";
    findInvitationMock.mockResolvedValue({ id: "inv-1", email, organizationId: "org-victim" });

    await signUp(auth, { email, invitationToken: "live-token", organizationHint: STRICT_ORG });

    const stored = await findStoredUser(auth, email);
    expect(stored.emailVerified).toBe(true);
    expect(stored.emailVerificationWaived).not.toBe(true);
    expect(resolveSignupPolicyMock).not.toHaveBeenCalled();
    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        emailVerified: true,
        emailVerificationWaived: false,
        invitationToken: "live-token",
      }),
    );
  });
});

describe("social sign-up path (session hook) honours the same channel and carries the marker", () => {
  function sessionHook(auth: Awaited<ReturnType<typeof loadAuth>>) {
    const hook = auth.options.databaseHooks?.session?.create?.after;
    if (!hook) {
      throw new Error("session.create.after hook missing");
    }
    return hook;
  }

  function makeContext(authUser: Record<string, unknown>, cookie: string) {
    return {
      path: "/callback/google",
      request: new Request("http://localhost:3000/api/auth/callback/google", {
        headers: { cookie },
      }),
      context: { internalAdapter: { findUserById: async () => authUser } },
    } as never;
  }

  it("a brand-new social user is provisioned with the cookie hint and an UNWAIVED marker", async () => {
    const auth = await loadAuth();
    const authUser = {
      id: "ba-social",
      email: "colleague@victim.com",
      name: "Colleague",
      emailVerified: true,
      emailVerificationWaived: false,
    };

    await sessionHook(auth)(
      { userId: "ba-social" } as never,
      makeContext(authUser, `${ORG_SIGNUP_HINT_COOKIE}=${STRICT_ORG}`),
    );

    expect(provisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: "ba-social",
        provider: "google",
        emailVerified: true,
        emailVerificationWaived: false,
        organizationHint: STRICT_ORG,
      }),
    );
    // The before hook never runs for OAuth — no policy waiver is possible.
    expect(resolveSignupPolicyMock).not.toHaveBeenCalled();
  });

  it("a pending user's sign-in re-evaluation carries the waiver marker off the user row", async () => {
    const auth = await loadAuth();
    existingAppUser = { id: "app-1", status: "pending_approval" };
    const authUser = {
      id: "ba-waived",
      email: "ceo@victim.com",
      name: "Waived",
      emailVerified: true,
      emailVerificationWaived: true,
    };

    await sessionHook(auth)(
      { userId: "ba-waived" } as never,
      {
        path: "/sign-in/email",
        context: { internalAdapter: { findUserById: async () => authUser } },
      } as never,
    );

    expect(reevaluateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: "ba-waived",
        emailVerified: true,
        emailVerificationWaived: true,
        provider: "email",
      }),
    );
    expect(provisionMock).not.toHaveBeenCalled();
  });
});
