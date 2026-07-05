import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideInitialStatus,
  FAIL_CLOSED_AUTH_POLICY,
  findEmailDomainOrganization,
  getAuthPolicyForOrg,
  isAuthMethod,
  resolveSignupPolicy,
  type OrgAuthPolicy,
} from "@/lib/auth-policy.server";

/**
 * Unit tests for `auth-policy.server.ts` (0007).
 *
 * Covers the two contracts the signup workflow hangs on:
 *   - resolution order org row → platform default → fail-closed, with every
 *     failure mode (missing rows, malformed values, thrown DB errors)
 *     degrading to the STRICTEST policy;
 *   - the pure `decideInitialStatus` matrix, including the ordering rules
 *     (a disallowed method beats `auto_active`; domain auto-approval
 *     requires a VERIFIED address).
 */

const logMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logMock(...a),
}));

interface Stubs {
  policyRows: () => unknown[];
  orgBySlug: () => unknown;
  emailMapping: () => unknown;
}

let stubs: Stubs;

interface Chain {
  select: (...args: unknown[]) => Chain;
  where: (...args: unknown[]) => Chain;
  executeTakeFirst: () => Promise<unknown>;
  execute: () => Promise<unknown>;
}

function makeChain(opts: { first?: () => unknown; all?: () => unknown }): Chain {
  const chain: Chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: () => Promise.resolve(opts.first?.()),
    execute: () => Promise.resolve(opts.all?.() ?? []),
  };
  return chain;
}

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      if (table === "app_organization_auth_settings")
        return makeChain({ all: () => stubs.policyRows() });
      if (table === "app_organizations") return makeChain({ first: () => stubs.orgBySlug() });
      if (table === "app_provider_organizations")
        return makeChain({ first: () => stubs.emailMapping() });
      throw new Error(`unmocked selectFrom: ${table}`);
    },
  },
}));

const DEFAULT_ROW = {
  organization_id: null,
  require_email_verification: true,
  signup_approval_mode: "admin_approval",
  allowed_auth_methods: null,
  auto_approve_email_domains: null,
};

beforeEach(() => {
  logMock.mockReset();
  stubs = {
    policyRows: () => [DEFAULT_ROW],
    orgBySlug: () => Promise.resolve({ id: "org-default" }),
    emailMapping: () => Promise.resolve(undefined),
  };
});
afterEach(() => vi.resetModules());

describe("getAuthPolicyForOrg", () => {
  it("prefers the organization's own row over the platform default", async () => {
    stubs.policyRows = () => [
      DEFAULT_ROW,
      {
        organization_id: "org-1",
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: ["email", "google"],
        auto_approve_email_domains: [" Acme.COM"],
      },
    ];
    const policy = await getAuthPolicyForOrg("org-1");
    expect(policy).toMatchObject({
      source: "organization",
      requireEmailVerification: false,
      signupApprovalMode: "auto_active",
      allowedAuthMethods: ["email", "google"],
    });
    // Domains are normalized (trim + lowercase) at read time.
    expect(policy.autoApproveEmailDomains).toEqual(["acme.com"]);
  });

  it("falls back to the platform default when the org has no row", async () => {
    const policy = await getAuthPolicyForOrg("org-without-row");
    expect(policy.source).toBe("platform_default");
    expect(policy.requireEmailVerification).toBe(true);
    expect(policy.signupApprovalMode).toBe("admin_approval");
  });

  it("resolves the platform default directly for a null org id", async () => {
    const policy = await getAuthPolicyForOrg(null);
    expect(policy.source).toBe("platform_default");
  });

  it("fails closed when no rows exist at all", async () => {
    stubs.policyRows = () => [];
    const policy = await getAuthPolicyForOrg("org-1");
    expect(policy).toBe(FAIL_CLOSED_AUTH_POLICY);
  });

  it("fails closed on a malformed approval mode (schema drift)", async () => {
    stubs.policyRows = () => [
      { ...DEFAULT_ROW, organization_id: "org-1", signup_approval_mode: "nonsense" },
    ];
    const policy = await getAuthPolicyForOrg("org-1");
    expect(policy).toBe(FAIL_CLOSED_AUTH_POLICY);
  });

  it("filters unknown auth methods instead of trusting them", async () => {
    stubs.policyRows = () => [
      {
        ...DEFAULT_ROW,
        organization_id: "org-1",
        allowed_auth_methods: ["email", "carrier-pigeon"],
      },
    ];
    const policy = await getAuthPolicyForOrg("org-1");
    expect(policy.allowedAuthMethods).toEqual(["email"]);
  });

  it("accepts the invite_only mode (0008) instead of failing closed", async () => {
    stubs.policyRows = () => [
      { ...DEFAULT_ROW, organization_id: "org-1", signup_approval_mode: "invite_only" },
    ];
    const policy = await getAuthPolicyForOrg("org-1");
    expect(policy.signupApprovalMode).toBe("invite_only");
    expect(policy.source).toBe("organization");
  });
});

describe("findEmailDomainOrganization", () => {
  it("returns the mapped organization for a known domain", async () => {
    stubs.emailMapping = () =>
      Promise.resolve({ organization_id: "org-acme", provider_organization_key: "acme.com" });
    await expect(findEmailDomainOrganization("eve@acme.com")).resolves.toEqual({
      organizationId: "org-acme",
      providerOrganizationKey: "acme.com",
    });
  });

  it("returns null for an unmapped domain", async () => {
    await expect(findEmailDomainOrganization("eve@nowhere.example")).resolves.toBeNull();
  });

  it("returns null for a malformed address without touching the DB", async () => {
    stubs.emailMapping = () => {
      throw new Error("must not query for a domainless address");
    };
    await expect(findEmailDomainOrganization("not-an-email")).resolves.toBeNull();
  });
});

describe("resolveSignupPolicy", () => {
  it("resolves a provider-keyed org by slug and returns its policy", async () => {
    stubs.orgBySlug = () => Promise.resolve({ id: "org-hd" });
    stubs.policyRows = () => [
      DEFAULT_ROW,
      { ...DEFAULT_ROW, organization_id: "org-hd", signup_approval_mode: "auto_active" },
    ];
    const policy = await resolveSignupPolicy({
      provider: "google",
      email: "u@corp.example",
      emailVerified: true,
      profile: { hd: "corp.example" },
    });
    expect(policy.source).toBe("organization");
    expect(policy.signupApprovalMode).toBe("auto_active");
  });

  it("uses the platform default when the provider org does not exist yet", async () => {
    stubs.orgBySlug = () => Promise.resolve(undefined);
    const policy = await resolveSignupPolicy({
      provider: "google",
      email: "u@corp.example",
      emailVerified: true,
      profile: { hd: "corp.example" },
    });
    expect(policy.source).toBe("platform_default");
  });

  it("routes email sign-ups through the email-domain mapping", async () => {
    stubs.emailMapping = () =>
      Promise.resolve({ organization_id: "org-acme", provider_organization_key: "acme.com" });
    stubs.policyRows = () => [
      DEFAULT_ROW,
      { ...DEFAULT_ROW, organization_id: "org-acme", require_email_verification: false },
    ];
    const policy = await resolveSignupPolicy({
      provider: "email",
      email: "eve@acme.com",
      emailVerified: false,
    });
    expect(policy.source).toBe("organization");
    expect(policy.requireEmailVerification).toBe(false);
  });

  it("falls back to the default org's policy for unmapped email sign-ups", async () => {
    stubs.policyRows = () => [
      DEFAULT_ROW,
      { ...DEFAULT_ROW, organization_id: "org-default", require_email_verification: false },
    ];
    const policy = await resolveSignupPolicy({
      provider: "email",
      email: "someone@example.com",
      emailVerified: false,
    });
    expect(policy.source).toBe("organization");
    expect(policy.requireEmailVerification).toBe(false);
  });

  it("fails closed (and logs) when resolution throws", async () => {
    stubs.emailMapping = () => {
      throw new Error("db down");
    };
    const policy = await resolveSignupPolicy({
      provider: "email",
      email: "eve@acme.com",
      emailVerified: false,
    });
    expect(policy).toBe(FAIL_CLOSED_AUTH_POLICY);
    expect(logMock).toHaveBeenCalled();
  });
});

describe("decideInitialStatus", () => {
  const base: OrgAuthPolicy = {
    requireEmailVerification: true,
    signupApprovalMode: "admin_approval",
    allowedAuthMethods: null,
    autoApproveEmailDomains: null,
    source: "organization",
  };
  const input = { provider: "email" as const, email: "ada@example.com", emailVerified: false };

  it("defaults to admin approval", () => {
    expect(decideInitialStatus(base, input)).toEqual({
      status: "pending_approval",
      reason: "admin_approval",
    });
  });

  it("activates under auto_active", () => {
    expect(decideInitialStatus({ ...base, signupApprovalMode: "auto_active" }, input)).toEqual({
      status: "active",
      reason: "auto_active",
    });
  });

  it("parks a disallowed method even under auto_active", () => {
    expect(
      decideInitialStatus(
        { ...base, signupApprovalMode: "auto_active", allowedAuthMethods: ["google"] },
        input,
      ),
    ).toEqual({ status: "pending_approval", reason: "auth_method_not_allowed" });
  });

  it("an empty allow-list blocks every method", () => {
    expect(decideInitialStatus({ ...base, allowedAuthMethods: [] }, input)).toEqual({
      status: "pending_approval",
      reason: "auth_method_not_allowed",
    });
  });

  it("activates a VERIFIED email on an auto-approve domain", () => {
    expect(
      decideInitialStatus(
        { ...base, autoApproveEmailDomains: ["example.com"] },
        { ...input, emailVerified: true },
      ),
    ).toEqual({ status: "active", reason: "domain_auto_approved" });
  });

  it("does NOT auto-approve an unverified address on a listed domain", () => {
    expect(
      decideInitialStatus({ ...base, autoApproveEmailDomains: ["example.com"] }, input),
    ).toEqual({ status: "pending_approval", reason: "admin_approval" });
  });

  it("does NOT domain-approve when verification is WAIVED, even if emailVerified is set (waiver fabricates the flag)", () => {
    // The sign-up hook stamps emailVerified:true without proof when an org
    // waives verification; the domain branch must not trust it. This is the
    // regression guard for the security finding.
    expect(
      decideInitialStatus(
        {
          ...base,
          requireEmailVerification: false,
          autoApproveEmailDomains: ["example.com"],
        },
        { ...input, emailVerified: true },
      ),
    ).toEqual({ status: "pending_approval", reason: "admin_approval" });
  });

  it("matches domains case-insensitively", () => {
    expect(
      decideInitialStatus(
        { ...base, autoApproveEmailDomains: ["example.com"] },
        { ...input, email: "Ada@EXAMPLE.com", emailVerified: true },
      ),
    ).toEqual({ status: "active", reason: "domain_auto_approved" });
  });

  it("a valid invitation activates under every mode — the invitation IS the approval (0008)", () => {
    for (const mode of ["admin_approval", "auto_active", "invite_only"] as const) {
      expect(
        decideInitialStatus(
          { ...base, signupApprovalMode: mode },
          { ...input, hasValidInvitation: true },
        ),
      ).toEqual({ status: "active", reason: "invitation" });
    }
  });

  it("a valid invitation OVERRIDES the method allow-list (targeted grant beats the unsolicited-signup gate)", () => {
    expect(
      decideInitialStatus(
        { ...base, allowedAuthMethods: ["google"] },
        { ...input, hasValidInvitation: true },
      ),
    ).toEqual({ status: "active", reason: "invitation" });
  });

  it("invite_only parks uninvited signups as invite_required", () => {
    expect(decideInitialStatus({ ...base, signupApprovalMode: "invite_only" }, input)).toEqual({
      status: "pending_approval",
      reason: "invite_required",
    });
  });

  it("invite_only still honors a verified auto-approve domain", () => {
    expect(
      decideInitialStatus(
        {
          ...base,
          signupApprovalMode: "invite_only",
          autoApproveEmailDomains: ["example.com"],
        },
        { ...input, emailVerified: true },
      ),
    ).toEqual({ status: "active", reason: "domain_auto_approved" });
  });
});

describe("isAuthMethod (the single provider-narrowing predicate)", () => {
  it("accepts every known provider", () => {
    for (const m of ["email", "google", "microsoft", "github"]) {
      expect(isAuthMethod(m)).toBe(true);
    }
  });

  it("rejects unknown strings, null, and undefined (nullable columns narrow in one step)", () => {
    expect(isAuthMethod("carrier-pigeon")).toBe(false);
    expect(isAuthMethod("")).toBe(false);
    expect(isAuthMethod(null)).toBe(false);
    expect(isAuthMethod(undefined)).toBe(false);
  });
});
