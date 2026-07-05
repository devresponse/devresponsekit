import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionUserFromAuth, reevaluatePendingActivation } from "@/lib/user-provisioning.server";

/**
 * Unit tests for `user-provisioning.server.ts`.
 *
 * Verifies the documented contract:
 *   - initial statuses follow the org's runtime signup policy (0007): the
 *     platform default parks new users in `pending_approval` (the pre-0007
 *     behavior), `auto_active` and verified auto-approve-domain matches
 *     activate immediately, and a disallowed auth method is parked
 *     `pending_approval` even under `auto_active`;
 *   - seed users are activated immediately WITHOUT reading policy;
 *   - existing users keep their current status (no privilege escalation
 *     from arbitrary OAuth profile data) and emit `auth.account.linked`;
 *   - a missing organization triggers an insert into
 *     `app_organizations` + `app_provider_organizations`;
 *   - email/password sign-ups are routed to an admin-mapped org for their
 *     email domain (`app_provider_organizations`, provider = 'email');
 *   - `reevaluatePendingActivation` upgrades ONLY `pending_approval` rows,
 *     and only when the CURRENT policy decides active.
 *
 * The Kysely query builder is stubbed per-table so each branch can be
 * exercised without a real database; insert/update payloads are captured so
 * assertions cover what was WRITTEN, not just what the stubs return.
 */

const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const findInvitationMock = vi.fn();
const consumeInvitationMock = vi.fn();
vi.mock("@/lib/invitations.server", () => ({
  findValidInvitationByToken: (...a: unknown[]) => findInvitationMock(...a),
  consumeInvitation: (...a: unknown[]) => consumeInvitationMock(...a),
}));

const logErrorMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logErrorMock(...a),
}));

interface PolicyRow {
  organization_id: string | null;
  require_email_verification: boolean;
  signup_approval_mode: string;
  allowed_auth_methods: string[] | null;
  auto_approve_email_domains: string[] | null;
}

interface Stubs {
  orgSelect: () => unknown;
  orgInsert?: unknown;
  providerOrgSelect: () => unknown;
  providerOrgInsert?: unknown;
  policyRows: () => PolicyRow[];
  userSelect: () => unknown;
  userInsert?: unknown;
  membershipSelect: () => unknown;
  membershipList: () => unknown[];
  membershipInsert?: unknown;
}

let stubs: Stubs;
let insertCalls: Array<{ table: string; values: Record<string, unknown> }>;
let updateCalls: Array<{ table: string; values: Record<string, unknown> }>;

interface Chain {
  select: (...args: unknown[]) => Chain;
  where: (...args: unknown[]) => Chain;
  returning: (...args: unknown[]) => Chain;
  onConflict: (...args: unknown[]) => Chain;
  values: (v: Record<string, unknown>) => Chain;
  set: (v: Record<string, unknown>) => Chain;
  executeTakeFirst: () => Promise<unknown>;
  executeTakeFirstOrThrow: () => Promise<unknown>;
  execute: () => Promise<unknown>;
}

function makeChain(opts: {
  table: string;
  first?: () => unknown;
  all?: () => unknown;
  firstOrThrow?: () => unknown;
  done?: () => unknown;
  captureInsert?: boolean;
  captureUpdate?: boolean;
}): Chain {
  let captured: Record<string, unknown> = {};
  const chain: Chain = {
    select: () => chain,
    where: () => chain,
    returning: () => chain,
    onConflict: () => chain,
    values: (v) => {
      captured = v;
      if (opts.captureInsert) insertCalls.push({ table: opts.table, values: v });
      return chain;
    },
    set: (v) => {
      captured = v;
      return chain;
    },
    executeTakeFirst: () => Promise.resolve(opts.first?.()),
    executeTakeFirstOrThrow: () => Promise.resolve(opts.firstOrThrow?.()),
    execute: () => {
      if (opts.captureUpdate) updateCalls.push({ table: opts.table, values: captured });
      return Promise.resolve(opts.all ? opts.all() : opts.done?.());
    },
  };
  return chain;
}

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      if (table === "app_organizations")
        return makeChain({ table, first: () => stubs.orgSelect() });
      if (table === "app_provider_organizations")
        return makeChain({ table, first: () => stubs.providerOrgSelect() });
      if (table === "app_organization_auth_settings")
        return makeChain({ table, all: () => stubs.policyRows() });
      if (table === "app_users") return makeChain({ table, first: () => stubs.userSelect() });
      if (table === "app_organization_memberships")
        return makeChain({
          table,
          first: () => stubs.membershipSelect(),
          all: () => stubs.membershipList(),
        });
      throw new Error(`unmocked selectFrom: ${table}`);
    },
    insertInto: (table: string) => {
      if (table === "app_organizations")
        return makeChain({ table, captureInsert: true, firstOrThrow: () => stubs.orgInsert });
      if (table === "app_provider_organizations")
        return makeChain({ table, captureInsert: true, done: () => stubs.providerOrgInsert });
      if (table === "app_users")
        return makeChain({ table, captureInsert: true, firstOrThrow: () => stubs.userInsert });
      if (table === "app_organization_memberships")
        return makeChain({ table, captureInsert: true, done: () => stubs.membershipInsert });
      throw new Error(`unmocked insertInto: ${table}`);
    },
    updateTable: (table: string) => makeChain({ table, captureUpdate: true }),
  },
}));

const DEFAULT_POLICY_ROW: PolicyRow = {
  organization_id: null,
  require_email_verification: true,
  signup_approval_mode: "admin_approval",
  allowed_auth_methods: null,
  auto_approve_email_domains: null,
};

beforeEach(() => {
  auditMock.mockReset();
  findInvitationMock.mockReset();
  findInvitationMock.mockResolvedValue(null);
  consumeInvitationMock.mockReset();
  consumeInvitationMock.mockResolvedValue({ consumed: true, roleGranted: false });
  logErrorMock.mockReset();
  insertCalls = [];
  updateCalls = [];
  stubs = {
    orgSelect: () => Promise.resolve({ id: "org-default" }),
    providerOrgSelect: () => Promise.resolve(undefined),
    policyRows: () => [DEFAULT_POLICY_ROW],
    userSelect: () => Promise.resolve(undefined),
    userInsert: Promise.resolve({ id: "user-1", status: "pending_approval" }),
    membershipSelect: () => Promise.resolve(undefined),
    membershipList: () => [],
    membershipInsert: Promise.resolve(undefined),
  };
});
afterEach(() => vi.resetModules());

describe("provisionUserFromAuth", () => {
  it("creates a new pending_approval user and pending membership under the platform default", async () => {
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "google",
    });
    expect(result).toMatchObject({
      appUserId: "user-1",
      organizationId: "org-default",
      status: "pending_approval",
      membershipStatus: "pending_approval",
      linkedExisting: false,
    });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe(
      "pending_approval",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.pending_approval",
        outcome: "success",
        provider: "google",
        metadata: expect.objectContaining({
          decisionReason: "admin_approval",
          policySource: "platform_default",
        }),
      }),
    );
  });

  it("activates seed users immediately without reading policy", async () => {
    stubs.policyRows = () => {
      throw new Error("seeds must not read signup policy");
    };
    stubs.userInsert = Promise.resolve({ id: "user-seed", status: "active" });
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-seed",
      email: "seed@example.com",
      emailVerified: true,
      provider: "google",
      isSeed: true,
    });
    expect(result.status).toBe("active");
    expect(result.membershipStatus).toBe("active");
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
  });

  it("preserves existing user status and emits auth.account.linked", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "existing-1", status: "blocked" });
    stubs.membershipSelect = () => Promise.resolve({ id: "m-1", status: "blocked" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-1",
      email: "x@example.com",
      emailVerified: true,
      provider: "github",
    });
    expect(result.linkedExisting).toBe(true);
    expect(result.status).toBe("blocked");
    expect(result.membershipStatus).toBe("blocked");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.account.linked" }),
    );
  });

  it("creates the organization + provider org row when slug is unknown", async () => {
    stubs.orgSelect = () => Promise.resolve(undefined);
    stubs.orgInsert = Promise.resolve({ id: "new-org" });
    stubs.providerOrgInsert = Promise.resolve(undefined);

    // Microsoft tenants resolve to a tid-keyed organization, so this triggers
    // the "no existing org" branch.
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-2",
      email: "u@contoso.com",
      emailVerified: true,
      provider: "microsoft",
      profile: { tid: "tenant-123", name: "Contoso" },
    });
    expect(result.organizationId).toBe("new-org");
    expect(insertCalls.find((c) => c.table === "app_organizations")?.values.slug).toBe(
      "tenant-123",
    );
  });

  it("activates immediately when the org policy is auto_active", async () => {
    stubs.policyRows = () => [
      DEFAULT_POLICY_ROW,
      {
        organization_id: "org-default",
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      },
    ];
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-3",
      email: "open@example.com",
      emailVerified: false,
      provider: "email",
    });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
    expect(insertCalls.find((c) => c.table === "app_organization_memberships")?.values.status).toBe(
      "active",
    );
    expect(result.membershipStatus).toBe("active");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        metadata: expect.objectContaining({
          decisionReason: "auto_active",
          policySource: "organization",
        }),
      }),
    );
  });

  it("activates a VERIFIED email matching an auto-approve domain under admin_approval", async () => {
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: null,
        auto_approve_email_domains: ["example.com"],
      },
    ];
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });
    await provisionUserFromAuth({
      betterAuthUserId: "ba-4",
      email: "grace@example.com",
      emailVerified: true,
      provider: "google",
    });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        metadata: expect.objectContaining({ decisionReason: "domain_auto_approved" }),
      }),
    );
  });

  it("keeps an UNVERIFIED auto-approve-domain email pending (no domain trust without proof)", async () => {
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: null,
        auto_approve_email_domains: ["example.com"],
      },
    ];
    await provisionUserFromAuth({
      betterAuthUserId: "ba-5",
      email: "mallory@example.com",
      emailVerified: false,
      provider: "email",
    });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe(
      "pending_approval",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.account.pending_approval" }),
    );
  });

  it("parks a disallowed auth method in pending_approval even when the org is auto_active", async () => {
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: ["google", "microsoft"],
        auto_approve_email_domains: null,
      },
    ];
    await provisionUserFromAuth({
      betterAuthUserId: "ba-6",
      email: "e@example.com",
      emailVerified: true,
      provider: "email",
    });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe(
      "pending_approval",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.pending_approval",
        metadata: expect.objectContaining({ decisionReason: "auth_method_not_allowed" }),
      }),
    );
  });

  it("routes email sign-ups to the admin-mapped organization for their domain", async () => {
    stubs.providerOrgSelect = () =>
      Promise.resolve({ organization_id: "org-acme", provider_organization_key: "acme.com" });
    stubs.policyRows = () => [DEFAULT_POLICY_ROW];
    stubs.orgSelect = () => {
      throw new Error("mapped sign-ups must not fall back to the slug lookup");
    };

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-7",
      email: "eve@acme.com",
      emailVerified: false,
      provider: "email",
    });
    expect(result.organizationId).toBe("org-acme");
    expect(
      insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
    ).toMatchObject({ organization_id: "org-acme", provider_organization_key: "acme.com" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ emailDomainRouted: true }),
      }),
    );
  });

  it("places an INVITED signup active in the inviting org and consumes the invitation (0008)", async () => {
    findInvitationMock.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-invited",
      organizationName: "Invited Org",
      email: "ada@example.com",
      roleId: null,
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    stubs.orgSelect = () => {
      throw new Error("an invited signup must not resolve the org by slug");
    };
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-inv",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
      invitationToken: "tok-plain",
    });

    expect(findInvitationMock).toHaveBeenCalledWith("tok-plain");
    expect(result.organizationId).toBe("org-invited");
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
    expect(
      insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
    ).toMatchObject({
      organization_id: "org-invited",
      status: "active",
      provider_organization_key: null,
    });
    expect(consumeInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        invitation: expect.objectContaining({ id: "inv-1" }),
        appUser: expect.objectContaining({ id: "user-1", primaryEmail: "ada@example.com" }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        metadata: expect.objectContaining({ decisionReason: "invitation" }),
      }),
    );
  });

  it("an invitation overrides the org's method allow-list (targeted grant, coherent with the accept endpoint)", async () => {
    findInvitationMock.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-strict",
      organizationName: "Strict Org",
      email: "ada@example.com",
      roleId: null,
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    // The inviting org only allows google — but the invited email/password
    // sign-up must still land active and consume the invitation.
    stubs.policyRows = () => [
      {
        organization_id: "org-strict",
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: ["google"],
        auto_approve_email_domains: null,
      },
    ];
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-inv-strict",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
      invitationToken: "tok-plain",
    });

    expect(result.organizationId).toBe("org-strict");
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
    expect(consumeInvitationMock).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        metadata: expect.objectContaining({ decisionReason: "invitation" }),
      }),
    );
  });

  it("treats an email-mismatched invitation as uninvited (no consume, normal policy)", async () => {
    findInvitationMock.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-invited",
      organizationName: "Invited Org",
      email: "someone-else@example.com",
      roleId: null,
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-mismatch",
      email: "ada@example.com",
      emailVerified: false,
      provider: "email",
      invitationToken: "tok-plain",
    });

    expect(result.organizationId).toBe("org-default");
    expect(result.status).toBe("pending_approval");
    expect(consumeInvitationMock).not.toHaveBeenCalled();
  });

  it("parks uninvited signups under invite_only with reason invite_required", async () => {
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: true,
        signup_approval_mode: "invite_only",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      },
    ];

    await provisionUserFromAuth({
      betterAuthUserId: "ba-uninvited",
      email: "stranger@example.com",
      emailVerified: false,
      provider: "email",
    });

    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe(
      "pending_approval",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.pending_approval",
        metadata: expect.objectContaining({ decisionReason: "invite_required" }),
      }),
    );
  });

  it("degrades to the uninvited path when the invitation lookup throws", async () => {
    findInvitationMock.mockRejectedValue(new Error("db down"));

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-err",
      email: "ada@example.com",
      emailVerified: false,
      provider: "email",
      invitationToken: "tok-plain",
    });

    expect(result.status).toBe("pending_approval");
    expect(result.organizationId).toBe("org-default");
    expect(consumeInvitationMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
  });
});

describe("reevaluatePendingActivation", () => {
  it("activates a pending user + membership when the org policy now says active", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "pending_approval" });
    stubs.membershipList = () => [
      { id: "m-1", organization_id: "org-default", source_provider: "email" },
    ];
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      },
    ];

    await reevaluatePendingActivation({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: false,
      provider: "email",
    });

    expect(updateCalls).toEqual([
      expect.objectContaining({
        table: "app_organization_memberships",
        values: expect.objectContaining({ status: "active" }),
      }),
      expect.objectContaining({
        table: "app_users",
        values: expect.objectContaining({ status: "active" }),
      }),
    ]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        metadata: expect.objectContaining({
          trigger: "sign_in_reevaluation",
          decisionReason: "auto_active",
        }),
      }),
    );
  });

  it("activates via a verified auto-approve domain (the post-verification sign-in path)", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "pending_approval" });
    stubs.membershipList = () => [
      { id: "m-1", organization_id: "org-default", source_provider: "email" },
    ];
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: null,
        auto_approve_email_domains: ["example.com"],
      },
    ];

    await reevaluatePendingActivation({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
    });

    expect(updateCalls.map((c) => c.table)).toEqual(["app_organization_memberships", "app_users"]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ decisionReason: "domain_auto_approved" }),
      }),
    );
  });

  it("leaves a pending user untouched while policy still requires admin approval", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "pending_approval" });
    stubs.membershipList = () => [
      { id: "m-1", organization_id: "org-default", source_provider: "email" },
    ];
    // Domain rule present but the email is still unverified — no activation.
    stubs.policyRows = () => [
      {
        organization_id: "org-default",
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: null,
        auto_approve_email_domains: ["example.com"],
      },
    ];

    await reevaluatePendingActivation({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: false,
      provider: "email",
    });

    expect(updateCalls).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("never touches non-pending users (blocked stays blocked)", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "blocked" });
    stubs.membershipList = () => {
      throw new Error("must not query memberships for a non-pending user");
    };

    await reevaluatePendingActivation({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
    });

    expect(updateCalls).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
