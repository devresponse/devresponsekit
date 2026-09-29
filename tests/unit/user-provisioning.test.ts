import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DefaultOrganizationModule from "@/lib/default-organization.server";
import { NoDefaultOrganizationError } from "@/lib/default-organization.server";
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
 *   - F-52: provisioning never creates an organization or a provider-org
 *     row, and never looks an org up by a slug derived from the address: a
 *     verified GitHub sign-in no binding claims lands in the default org;
 *   - F-40: the default-org fallback places the sign-up in the org flagged
 *     `is_default` (`@/lib/default-organization.server`, stubbed here),
 *     whatever its slug, and with no default org it refuses before writing
 *     anything — it never creates a "Default Organization";
 *   - email/password sign-ups, and GitHub sign-ins with a verified address
 *     (F-52), are routed to an admin-mapped org for their email domain
 *     (`app_provider_organizations`, provider = 'email');
 *   - `reevaluatePendingActivation` upgrades ONLY `pending_approval` rows,
 *     and only when the CURRENT policy decides active;
 *   - F-95: the account and its membership are written through ONE
 *     transaction and converge on a concurrent duplicate (ON CONFLICT, then a
 *     re-read), and the re-evaluation's writes share one transaction too. The
 *     rollbacks and the real races are proven on a live database in
 *     tests/db/signup-acceptance-atomicity.db.test.ts.
 *
 * The Kysely query builder is stubbed per-table so each branch can be
 * exercised without a real database; insert/update payloads are captured so
 * assertions cover what was WRITTEN, not just what the stubs return.
 */

const auditMock = vi.fn();
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));

const findInvitationMock = vi.fn();
const consumeInvitationMock = vi.fn();
const inviterStandingMock = vi.fn();
vi.mock("@/lib/invitations.server", () => ({
  findValidInvitationByToken: (...a: unknown[]) => findInvitationMock(...a),
  consumeInvitation: (...a: unknown[]) => consumeInvitationMock(...a),
  enforceInviterStanding: (...a: unknown[]) => inviterStandingMock(...a),
}));

const resolveOrgMock = vi.fn();
vi.mock("@/lib/org-lookup.server", () => ({
  resolveOrganizationByIdentifier: (...a: unknown[]) => resolveOrgMock(...a),
}));

const logErrorMock = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logErrorMock(...a),
}));

// F-40: the default org is resolved by `is_default` in its own module; the
// real `NoDefaultOrganizationError` is kept so the refusal is the real one.
vi.mock("@/lib/default-organization.server", async (importOriginal) => {
  const actual = await importOriginal<typeof DefaultOrganizationModule>();
  return {
    ...actual,
    requireDefaultOrganization: async () => {
      const org = await stubs.defaultOrg();
      if (!org) throw new actual.NoDefaultOrganizationError();
      return org;
    },
  };
});

interface PolicyRow {
  organization_id: string | null;
  require_email_verification: boolean;
  signup_approval_mode: string;
  allowed_auth_methods: string[] | null;
  auto_approve_email_domains: string[] | null;
}

interface Stubs {
  /** The org flagged `is_default` (F-40), or null when there is none. */
  defaultOrg: () => Promise<{ id: string; slug: string; name: string; status: string } | null>;
  orgSelect: () => unknown;
  orgInsert?: unknown;
  providerOrgSelect: () => unknown;
  providerOrgInsert?: unknown;
  policyRows: () => PolicyRow[];
  userSelect: () => unknown;
  /**
   * What the `app_users` INSERT returns: the new row, or nothing when a
   * concurrent provisioning already inserted the identity and
   * `ON CONFLICT DO NOTHING` skipped this one (F-95).
   */
  userInsert?: unknown;
  membershipSelect: () => unknown;
  membershipList: () => unknown[];
  /**
   * What the membership INSERT returns; by default the row it was given, or
   * nothing to model a concurrent insert of the same (org, user) (F-95).
   */
  membershipInsert?: (values: Record<string, unknown>) => unknown;
}

let stubs: Stubs;
let insertCalls: Array<{ table: string; values: Record<string, unknown> }>;
let updateCalls: Array<{ table: string; values: Record<string, unknown> }>;
/**
 * F-95: every write issued through the TRANSACTION handle, in order, as
 * `insert:<table>` / `update:<table>`. Writes on the pool are not listed.
 */
let transactionWrites: string[];

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
  /** Like `first`, but handed the inserted values (an INSERT … RETURNING). */
  inserted?: (values: Record<string, unknown>) => unknown;
  all?: () => unknown;
  firstOrThrow?: () => unknown;
  done?: () => unknown;
  captureInsert?: boolean;
  captureUpdate?: boolean;
  inTransaction?: boolean;
}): Chain {
  let captured: Record<string, unknown> = {};
  const chain: Chain = {
    select: () => chain,
    where: () => chain,
    returning: () => chain,
    onConflict: () => chain,
    values: (v) => {
      captured = v;
      if (opts.captureInsert) {
        insertCalls.push({ table: opts.table, values: v });
        if (opts.inTransaction) transactionWrites.push(`insert:${opts.table}`);
      }
      return chain;
    },
    set: (v) => {
      captured = v;
      return chain;
    },
    executeTakeFirst: () =>
      Promise.resolve(opts.inserted ? opts.inserted(captured) : opts.first?.()),
    executeTakeFirstOrThrow: () => Promise.resolve((opts.firstOrThrow ?? opts.first)?.()),
    execute: () => {
      if (opts.captureUpdate) {
        updateCalls.push({ table: opts.table, values: captured });
        if (opts.inTransaction) transactionWrites.push(`update:${opts.table}`);
      }
      return Promise.resolve(opts.all ? opts.all() : opts.done?.());
    },
  };
  return chain;
}

vi.mock("@/db/database", () => {
  // The pool and a transaction share one stub; the transaction handle only
  // tags its writes (F-95), so a test can tell where each write went.
  const handle = (inTransaction: boolean) => ({
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
        return makeChain({
          table,
          captureInsert: true,
          inTransaction,
          first: () => stubs.userInsert,
        });
      if (table === "app_organization_memberships")
        return makeChain({
          table,
          captureInsert: true,
          inTransaction,
          inserted: (values) => (stubs.membershipInsert ? stubs.membershipInsert(values) : values),
        });
      throw new Error(`unmocked insertInto: ${table}`);
    },
    updateTable: (table: string) => makeChain({ table, captureUpdate: true, inTransaction }),
  });
  return {
    db: {
      ...handle(false),
      transaction: () => ({
        execute: <T>(fn: (trx: ReturnType<typeof handle>) => Promise<T>) => fn(handle(true)),
      }),
    },
  };
});

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
  inviterStandingMock.mockReset();
  inviterStandingMock.mockResolvedValue(true);
  resolveOrgMock.mockReset();
  resolveOrgMock.mockResolvedValue(null);
  logErrorMock.mockReset();
  insertCalls = [];
  updateCalls = [];
  transactionWrites = [];
  stubs = {
    defaultOrg: () =>
      Promise.resolve({
        id: "org-default",
        slug: "default",
        name: "Default Organization",
        status: "active",
      }),
    orgSelect: () => Promise.resolve({ id: "org-default" }),
    providerOrgSelect: () => Promise.resolve(undefined),
    policyRows: () => [DEFAULT_POLICY_ROW],
    userSelect: () => Promise.resolve(undefined),
    userInsert: Promise.resolve({ id: "user-1", status: "pending_approval" }),
    membershipSelect: () => Promise.resolve(undefined),
    membershipList: () => [],
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

  it("writes the account and its membership in ONE transaction (F-95)", async () => {
    await provisionUserFromAuth({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "google",
    });
    // Neither row reaches the pool on its own, so a failure between them can
    // no longer leave an account without the membership the next sign-in
    // (which returns early for an existing account) would never write.
    expect(transactionWrites).toEqual(["insert:app_users", "insert:app_organization_memberships"]);
    expect(insertCalls.map((c) => c.table)).toEqual(["app_users", "app_organization_memberships"]);
  });

  it("converges on a concurrent provisioning of the same identity instead of failing (F-95)", async () => {
    // Both reads miss; by each insert, the racing provisioning has committed
    // that row, so ON CONFLICT DO NOTHING returns nothing and the row is re-read.
    let userReads = 0;
    stubs.userSelect = () =>
      Promise.resolve(userReads++ === 0 ? undefined : { id: "user-raced", status: "active" });
    stubs.userInsert = Promise.resolve(undefined);
    let membershipReads = 0;
    stubs.membershipSelect = () =>
      Promise.resolve(membershipReads++ === 0 ? undefined : { status: "active" });
    stubs.membershipInsert = () => undefined;

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "google",
    });
    expect(result).toMatchObject({
      appUserId: "user-raced",
      status: "active",
      membershipStatus: "active",
      linkedExisting: true,
    });
    expect([userReads, membershipReads]).toEqual([2, 2]);
    // The winner's row keeps its status; only the profile fields are refreshed.
    expect(updateCalls.map((c) => c.table)).toEqual(["app_users"]);
    expect(updateCalls[0]!.values).not.toHaveProperty("status");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "auth.account.linked", appUserId: "user-raced" }),
    );
  });

  /**
   * F-52: a verified GitHub address's domain used to be looked up as an org
   * SLUG — joining whatever org held it, and creating an active one plus a
   * `github` provider-org row when none did — so the first GitHub user with a
   * verified gmail.com address founded a tenant every later one joined.
   */
  it.each([
    ["no org holds the domain as its slug (it used to be created)", undefined],
    ["an org holds the domain as its slug (it used to be joined)", { id: "org-contoso-com" }],
  ])(
    "F-52: a verified GitHub sign-in no binding claims lands in the default org when %s",
    async (_case, slugOrg) => {
      stubs.orgSelect = () => Promise.resolve(slugOrg);
      stubs.orgInsert = Promise.resolve({ id: "new-org" });
      stubs.providerOrgInsert = Promise.resolve(undefined);

      const result = await provisionUserFromAuth({
        betterAuthUserId: "ba-2",
        email: "u@contoso.com",
        emailVerified: true,
        provider: "github",
      });
      expect(result.organizationId).toBe("org-default");
      // No organization and no provider-org row: only the user and membership.
      expect(insertCalls.map((c) => c.table)).toEqual([
        "app_users",
        "app_organization_memberships",
      ]);
      expect(
        insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
      ).toMatchObject({
        organization_id: "org-default",
        source_provider: "github",
        provider_organization_key: "default",
      });
    },
  );

  it("F-52: a verified GitHub sign-in is placed by the superadmin-curated email-domain binding", async () => {
    stubs.providerOrgSelect = () =>
      Promise.resolve({ organization_id: "org-acme", provider_organization_key: "acme.com" });
    stubs.orgSelect = () => {
      throw new Error("no org may be looked up by a slug derived from the address");
    };

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-gh-bound",
      email: "dev@acme.com",
      emailVerified: true,
      provider: "github",
    });
    expect(result.organizationId).toBe("org-acme");
    expect(insertCalls.map((c) => c.table)).toEqual(["app_users", "app_organization_memberships"]);
    expect(
      insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
    ).toMatchObject({
      organization_id: "org-acme",
      source_provider: "github",
      provider_organization_key: "acme.com",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-acme",
        provider: "github",
        metadata: expect.objectContaining({ emailDomainRouted: true }),
      }),
    );
  });

  it("F-52: an UNVERIFIED GitHub address is not matched against the binding", async () => {
    // GitHub has not proven it, and no verification step of ours runs for an
    // OAuth sign-in, so it cannot claim a curated domain.
    stubs.providerOrgSelect = () => {
      throw new Error("an unverified GitHub address must not meet the binding");
    };

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-gh-unverified",
      email: "dev@acme.com",
      emailVerified: false,
      provider: "github",
    });
    expect(result.organizationId).toBe("org-default");
    expect(insertCalls.some((c) => c.table === "app_organizations")).toBe(false);
  });

  it("F-40: places an unmapped sign-up in the org flagged is_default, whatever its slug", async () => {
    // The default org was renamed: its slug is no longer `default`. Routing
    // must follow the flag and never look the default org up by slug.
    stubs.defaultOrg = () =>
      Promise.resolve({
        id: "org-renamed",
        slug: "acme-renamed",
        name: "Acme",
        status: "active",
      });
    stubs.orgSelect = () => {
      throw new Error("the default org must not be looked up by slug");
    };
    stubs.policyRows = () => [
      DEFAULT_POLICY_ROW,
      {
        ...DEFAULT_POLICY_ROW,
        organization_id: "org-renamed",
        signup_approval_mode: "invite_only",
      },
    ];

    for (const provider of ["email", "google"] as const) {
      insertCalls = [];
      auditMock.mockReset();
      const result = await provisionUserFromAuth({
        betterAuthUserId: `ba-renamed-${provider}`,
        email: "ada@example.com",
        emailVerified: true,
        provider,
      });
      expect(result.organizationId).toBe("org-renamed");
      expect(result.status).toBe("pending_approval");
      // No org is invented, and the membership lands in the renamed default
      // under ITS policy (invite_only), not the platform's.
      expect(insertCalls.some((c) => c.table === "app_organizations")).toBe(false);
      expect(
        insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
      ).toMatchObject({ organization_id: "org-renamed", provider_organization_key: "default" });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-renamed",
          metadata: expect.objectContaining({
            decisionReason: "invite_required",
            policySource: "organization",
          }),
        }),
      );
    }
  });

  it("F-40: with no default org it refuses before writing anything — no 'Default Organization' is created", async () => {
    stubs.defaultOrg = () => Promise.resolve(null);
    // What the old slug lookup saw after a rename: no org with slug `default`.
    stubs.orgSelect = () => Promise.resolve(undefined);
    stubs.orgInsert = Promise.resolve({ id: "phantom-default" });

    await expect(
      provisionUserFromAuth({
        betterAuthUserId: "ba-orphan",
        email: "ada@example.com",
        emailVerified: true,
        provider: "email",
      }),
    ).rejects.toBeInstanceOf(NoDefaultOrganizationError);
    expect(insertCalls).toEqual([]);
    expect(updateCalls).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
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

  it("treats an invitation whose inviter lost standing as uninvited: no activation, no consume (F-149)", async () => {
    const invitation = {
      id: "inv-1",
      organizationId: "org-invited",
      organizationName: "Invited Org",
      email: "ada@example.com",
      roleId: "role-superuser",
      invitedByAppUserId: "admin-banned",
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    };
    findInvitationMock.mockResolvedValue(invitation);
    // enforceInviterStanding voids the invitation and says no.
    inviterStandingMock.mockResolvedValue(false);

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-inv-lapsed",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
      invitationToken: "tok-plain",
    });

    // Asked BEFORE placement, since this path activates before it consumes.
    expect(inviterStandingMock).toHaveBeenCalledWith(
      expect.objectContaining({ invitation, actorBetterAuthUserId: "ba-inv-lapsed" }),
    );
    expect(result.organizationId).toBe("org-default");
    expect(result.status).toBe("pending_approval");
    expect(
      insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
    ).toMatchObject({ organization_id: "org-default", status: "pending_approval" });
    expect(consumeInvitationMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.pending_approval",
        metadata: expect.not.objectContaining({ decisionReason: "invitation" }),
      }),
    );
  });

  it("degrades to the uninvited path when the inviter-standing check throws (F-149)", async () => {
    findInvitationMock.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-invited",
      organizationName: "Invited Org",
      email: "ada@example.com",
      roleId: null,
      invitedByAppUserId: "admin-1",
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    inviterStandingMock.mockRejectedValue(new Error("auth down"));

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-inv-err",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
      invitationToken: "tok-plain",
    });

    expect(result.organizationId).toBe("org-default");
    expect(result.status).toBe("pending_approval");
    expect(consumeInvitationMock).not.toHaveBeenCalled();
    expect(logErrorMock).toHaveBeenCalled();
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

  it("targets the hinted org for a scoped sign-up (`?org=`); status still policy-gated", async () => {
    resolveOrgMock.mockResolvedValue({ id: "org-hinted", slug: "acme", name: "Acme" });
    // The hinted org runs auto_active, so the scoped sign-up lands active THERE
    // (not the default org) — placement by hint, activation by the org's policy.
    stubs.policyRows = () => [
      DEFAULT_POLICY_ROW,
      {
        organization_id: "org-hinted",
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      },
    ];
    stubs.orgSelect = () => {
      throw new Error("a hinted sign-up must not resolve the org by slug");
    };
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-hint",
      email: "new@acme.com",
      emailVerified: false,
      provider: "email",
      organizationHint: "acme",
    });

    expect(resolveOrgMock).toHaveBeenCalledWith("acme");
    expect(result.organizationId).toBe("org-hinted");
    expect(
      insertCalls.find((c) => c.table === "app_organization_memberships")?.values,
    ).toMatchObject({ organization_id: "org-hinted", provider_organization_key: null });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ organizationHintApplied: true }),
      }),
    );
  });

  it("keeps a hinted sign-up pending when the hinted org requires admin approval", async () => {
    resolveOrgMock.mockResolvedValue({ id: "org-hinted", slug: "acme", name: "Acme" });
    stubs.policyRows = () => [
      {
        organization_id: "org-hinted",
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      },
    ];
    stubs.orgSelect = () => {
      throw new Error("a hinted sign-up must not resolve the org by slug");
    };

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-hint2",
      email: "new@acme.com",
      emailVerified: true,
      provider: "email",
      organizationHint: "acme",
    });

    expect(result.organizationId).toBe("org-hinted");
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe(
      "pending_approval",
    );
  });

  it("falls through to normal resolution when the org hint does not resolve", async () => {
    resolveOrgMock.mockResolvedValue(null); // unknown identifier

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-hint3",
      email: "u@example.com",
      emailVerified: true,
      provider: "email",
      organizationHint: "does-not-exist",
    });

    expect(resolveOrgMock).toHaveBeenCalledWith("does-not-exist");
    expect(result.organizationId).toBe("org-default");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ organizationHintApplied: true }),
      }),
    );
  });

  it("lets a live invitation override the org hint (email-bound proof wins; hint not consulted)", async () => {
    findInvitationMock.mockResolvedValue({
      id: "inv-1",
      organizationId: "org-invited",
      organizationName: "Invited Org",
      email: "ada@example.com",
      roleId: null,
      status: "pending",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    });
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-both",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
      invitationToken: "tok-plain",
      organizationHint: "acme",
    });

    expect(result.organizationId).toBe("org-invited");
    // The invitation already fixed the org, so the hint branch is never reached.
    expect(resolveOrgMock).not.toHaveBeenCalled();
  });
});

/**
 * Review 2026-09-04 #2 — the finding's exact topology: the account arrives
 * `emailVerified: true` because a LAX org's policy waived verification, but
 * the sign-up hint places it in a STRICT org that auto-approves the address's
 * domain. The waiver marker must keep it out of `active`.
 */
describe("policy-waived verification vs domain auto-approval (review #2)", () => {
  const STRICT_AUTO_APPROVE: PolicyRow = {
    organization_id: "org-hinted",
    require_email_verification: true,
    signup_approval_mode: "admin_approval",
    allowed_auth_methods: null,
    auto_approve_email_domains: ["victim.com"],
  };

  beforeEach(() => {
    resolveOrgMock.mockResolvedValue({ id: "org-hinted", slug: "victim", name: "Victim" });
    stubs.policyRows = () => [DEFAULT_POLICY_ROW, STRICT_AUTO_APPROVE];
  });

  it("a WAIVED verification hinted into a strict auto-approve org lands pending, never active", async () => {
    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-spoof",
      email: "ceo@victim.com",
      emailVerified: true,
      emailVerificationWaived: true,
      provider: "email",
      organizationHint: "victim",
    });

    expect(result.organizationId).toBe("org-hinted");
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe(
      "pending_approval",
    );
    expect(insertCalls.find((c) => c.table === "app_organization_memberships")?.values.status).toBe(
      "pending_approval",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.pending_approval",
        metadata: expect.objectContaining({
          organizationHintApplied: true,
          emailVerificationWaived: true,
          decisionReason: "admin_approval",
        }),
      }),
    );
  });

  it("a GENUINE verification hinted into the same org still activates by domain (legitimate path)", async () => {
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });

    const result = await provisionUserFromAuth({
      betterAuthUserId: "ba-real",
      email: "colleague@victim.com",
      emailVerified: true,
      emailVerificationWaived: false,
      provider: "email",
      organizationHint: "victim",
    });

    expect(result.organizationId).toBe("org-hinted");
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        metadata: expect.objectContaining({ decisionReason: "domain_auto_approved" }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ emailVerificationWaived: true }),
      }),
    );
  });

  it("an omitted marker means NOT waived (OAuth / admin / legacy rows keep today's behaviour)", async () => {
    stubs.userInsert = Promise.resolve({ id: "user-1", status: "active" });
    await provisionUserFromAuth({
      betterAuthUserId: "ba-oauth",
      email: "colleague@victim.com",
      emailVerified: true,
      provider: "google",
      organizationHint: "victim",
    });
    expect(insertCalls.find((c) => c.table === "app_users")?.values.status).toBe("active");
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
        table: "app_users",
        values: expect.objectContaining({ status: "active" }),
      }),
      expect.objectContaining({
        table: "app_organization_memberships",
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

  it("activates across MULTIPLE orgs in one pass and lists them all in the audit", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "pending_approval" });
    stubs.membershipList = () => [
      { id: "m-a", organization_id: "org-a", source_provider: "email" },
      { id: "m-b", organization_id: "org-b", source_provider: "email" },
    ];
    stubs.policyRows = () => [
      {
        organization_id: "org-a",
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      },
      {
        organization_id: "org-b",
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

    // The user row once, then both memberships, all in one transaction
    // (F-95): a failure after a membership flipped used to leave the account
    // pending with no pending membership for the next sign-in to re-decide.
    // The account goes first, in the admin status change's lock order (the
    // deadlock race is in the DB suite).
    expect(updateCalls.map((c) => c.table)).toEqual([
      "app_users",
      "app_organization_memberships",
      "app_organization_memberships",
    ]);
    expect(transactionWrites).toEqual([
      "update:app_users",
      "update:app_organization_memberships",
      "update:app_organization_memberships",
    ]);
    // The event's top-level org is the first activated; metadata carries the
    // full set so a multi-org activation isn't silently reduced to one.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        organizationId: "org-a",
        metadata: expect.objectContaining({
          trigger: "sign_in_reevaluation",
          activatedOrgIds: ["org-a", "org-b"],
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

    expect(updateCalls.map((c) => c.table)).toEqual(["app_users", "app_organization_memberships"]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ decisionReason: "domain_auto_approved" }),
      }),
    );
  });

  it("does NOT activate a policy-WAIVED verification by domain, even after the org tightened its policy (review #2)", async () => {
    // Sign-up happened while the org waived verification (flag fabricated,
    // marker set); the admin has since turned verification on and listed the
    // domain. The next sign-in must not treat the fabricated flag as proof.
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
      emailVerificationWaived: true,
      provider: "email",
    });

    expect(updateCalls).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
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

  // F-480: the sign-up policy re-decides only what a sign-up decided. A
  // membership an administrator placed pending (the confined create, or
  // `POST …/memberships`) has no sign-up source, and used to be judged by THIS
  // sign-in's provider instead: an `auto_active` org then activated a user
  // nobody had approved, at its first sign-in.
  it.each([
    ["no source (an admin-placed membership)", null],
    ["a non-sign-up source (mcp)", "mcp"],
    ["a non-sign-up source (invitation)", "invitation"],
  ])(
    "leaves a pending membership with %s alone, even in an auto_active org",
    async (_label, source) => {
      stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "pending_approval" });
      stubs.membershipList = () => [
        { id: "m-1", organization_id: "org-default", source_provider: source },
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
        emailVerified: true,
        provider: "email",
      });

      expect(updateCalls).toEqual([]);
      expect(auditMock).not.toHaveBeenCalled();
    },
  );

  it("activates the sign-up membership and leaves an admin-placed one pending", async () => {
    stubs.userSelect = () => Promise.resolve({ id: "user-1", status: "pending_approval" });
    stubs.membershipList = () => [
      { id: "m-admin", organization_id: "org-a", source_provider: null },
      { id: "m-signup", organization_id: "org-b", source_provider: "email" },
    ];
    stubs.policyRows = () =>
      ["org-a", "org-b"].map((organization_id) => ({
        organization_id,
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: null,
        auto_approve_email_domains: null,
      }));

    await reevaluatePendingActivation({
      betterAuthUserId: "ba-1",
      email: "ada@example.com",
      emailVerified: true,
      provider: "email",
    });

    // The user, then one membership (org-b's); the audit names org-b.
    expect(updateCalls.map((c) => c.table)).toEqual(["app_users", "app_organization_memberships"]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth.account.auto_activated",
        organizationId: "org-b",
      }),
    );
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
