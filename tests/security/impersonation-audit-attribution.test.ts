import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as InMemoryLimiter from "@/lib/admin/rate-limit.server";
import type * as UserTargetModule from "@/lib/admin/user-target.server";

/**
 * F-07 — WHAT AN IMPERSONATED SESSION DOES IS AUDITED AGAINST THE HUMAN.
 *
 * An impersonated session carries the borrowed identity, so every guard hands
 * its route `betterAuthUserId` = the TARGET, and the routes audit exactly that.
 * An admin who impersonated a co-admin and then soft-deleted users, edited a
 * profile or revoked keys left rows (and `deactivated_by`) naming the co-admin,
 * and spent the co-admin's rate-limit budget. docs/admin-manager.md §12 says
 * the opposite: the actor is the ORIGINAL admin, never the impersonated user.
 *
 * This drives REAL routes through the REAL chain — guard → `resolveCaller` →
 * session record → `auditEvent` → the rate limiter — on each surface the
 * finding names: the admin console, the account self-service API and `/api/v1`,
 * plus invitation acceptance, which reads the session itself. It also pins each
 * Better Auth user-id "who" COLUMN a route writes directly (`deactivated_by`
 * from both soft-delete paths, an invitation's `revoked_by`, an auth policy's
 * `updated_by`): `auditEvent` cannot correct those, so each route must pass
 * the human itself. Only the session lookup, the access context, Better Auth
 * and the database are stubbed; the database stub RECORDS every insert and
 * every `set()`, which is what the assertions read. The own-session controls
 * are what stop the fix passing by re-attributing everyone.
 */

const HUMAN = "ba-human";
const BORROWED = "ba-borrowed";
const TARGET_ID = "11111111-1111-4111-8111-111111111101";
const KEY_ID = "22222222-2222-4222-8222-222222222202";
const ORG_ID = "33333333-3333-4333-8333-333333333303";
const INVITATION_ID = "44444444-4444-4444-8444-444444444404";

const IMPERSONATED = { user: { id: BORROWED }, session: { id: "s-imp", impersonatedBy: HUMAN } };
const OWN_SESSION = { user: { id: "ba-admin" }, session: { id: "s-own" } };

/**
 * The "who" column cases run on both sessions: the impersonated one must name
 * the HUMAN (with the borrowed identity in the audit metadata), and the
 * admin's own session must name the admin, with no impersonation metadata.
 */
const SESSIONS = [
  { label: "impersonated session", session: IMPERSONATED, human: HUMAN, borrowed: BORROWED },
  { label: "own session (control)", session: OWN_SESSION, human: "ba-admin", borrowed: null },
];

const ORG = { id: ORG_ID, slug: "org-a", name: "Org A" };
const POLICY = {
  requireEmailVerification: true,
  signupApprovalMode: "admin_approval",
  allowedAuthMethods: null,
  autoApproveEmailDomains: null,
};

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const authBan = vi.fn();
const authUpdateUser = vi.fn();
const getApiKeyById = vi.fn();
const revokeApiKey = vi.fn();

/** Every row inserted into `app_audit_events`, every other insert, and every `set()` payload. */
const writes = vi.hoisted(() => ({
  audit: [] as Record<string, unknown>[],
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  sets: [] as { table: string; values: Record<string, unknown> }[],
}));
/**
 * Canned read results, keyed `${verb}:${table}` (`select:app_users`,
 * `update:app_organization_invitations`). Unset: no row, no rows.
 */
const reads = vi.hoisted(() => ({
  first: {} as Record<string, unknown>,
  rows: {} as Record<string, unknown[]>,
}));

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (...a: unknown[]) => accessGetter(...a) };
});
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return {
    ...actual,
    requiresSuperadminForSharedTarget: async () => false,
    membershipCascadeStripsLastGlobalSuperuser: async () => false,
  };
});
vi.mock("@/lib/admin/user-target.server", async () => {
  const actual = await vi.importActual<typeof UserTargetModule>("@/lib/admin/user-target.server");
  return {
    ...actual,
    resolveTargetUser: async () => ({
      appUserId: TARGET_ID,
      betterAuthUserId: "ba-victim",
      primaryEmail: "victim@example.com",
      displayName: null,
      status: "active",
    }),
    refuseOutrankingTarget: async () => null,
  };
});
vi.mock("@/lib/admin/auth-admin.server", () => ({
  banBetterAuthUser: (...a: unknown[]) => authBan(...a),
  unbanBetterAuthUser: vi.fn(),
  updateBetterAuthUser: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: { updateUser: (...a: unknown[]) => authUpdateUser(...a) },
    $context: Promise.resolve({ internalAdapter: { updateUser: vi.fn() } }),
  },
}));
vi.mock("@/lib/api-auth/api-keys.server", () => ({
  getApiKeyById: (...a: unknown[]) => getApiKeyById(...a),
  revokeApiKey: (...a: unknown[]) => revokeApiKey(...a),
  verifyApiKey: vi.fn(),
  touchApiKeyUsage: vi.fn(),
}));
// The acceptance floor's SHARED bucket lives in Postgres. With no database it
// is routed through the in-memory limiter, which applies the same charging
// rule; the shared limiter's own charging is pinned in rate-limit-shared.test.ts.
// Resolved per call rather than captured by the factory: `vi.resetModules`
// keeps mocked modules cached, so a captured limiter would be an earlier
// test's instance and its buckets invisible to `bucketKeys()`.
vi.mock("@/lib/admin/rate-limit-shared.server", () => ({
  enforceSharedRateLimit: async (...a: Parameters<typeof InMemoryLimiter.enforceRateLimit>) =>
    (await import("@/lib/admin/rate-limit.server")).enforceRateLimit(...a),
}));

/** A chainable query stub that records `values()` / `set()` and answers reads from `reads`. */
function recordingChain(verb: "select" | "update" | "insert", table: string): unknown {
  const key = `${verb}:${table}`;
  const chain: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "values") {
          return (values: Record<string, unknown>) => {
            if (table === "app_audit_events") writes.audit.push(values);
            else writes.inserts.push({ table, values });
            return chain;
          };
        }
        if (prop === "set") {
          return (values: Record<string, unknown>) => {
            writes.sets.push({ table, values });
            return chain;
          };
        }
        if (prop === "execute") return async () => reads.rows[key] ?? [];
        if (prop === "executeTakeFirst") return async () => reads.first[key];
        return () => chain;
      },
    },
  );
  return chain;
}

vi.mock("@/db/database", () => {
  const handle = {
    selectFrom: (table: string) => recordingChain("select", table),
    updateTable: (table: string) => recordingChain("update", table),
    insertInto: (table: string) => recordingChain("insert", table),
  };
  return {
    db: {
      ...handle,
      transaction: () => ({ execute: async (cb: (trx: unknown) => unknown) => cb(handle) }),
    },
  };
});

function makeRequest(url: string, method: string, body?: unknown): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    method,
    headers: new Headers({ "user-agent": "vitest" }),
    json: async () => body ?? {},
  } as unknown as NextRequest;
}

const access = (permissions: string[], organizationId: string | null = "o-1") => ({
  appUserId: "u-session",
  primaryEmail: "session@x.com",
  status: "active",
  organizationId,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions,
});

function auditRow(eventType: string): Record<string, unknown> {
  const row = writes.audit.find((r) => r.event_type === eventType);
  expect(row, `no ${eventType} audit row was written`).toBeDefined();
  return row!;
}

const metadataOf = (row: Record<string, unknown>) =>
  JSON.parse(row.metadata as string) as Record<string, unknown>;

/** The row names `human`, and carries the borrowed identity only when there is one. */
function expectAttributedTo(
  row: Record<string, unknown>,
  human: string,
  borrowed: string | null,
): void {
  expect(row.actor_better_auth_user_id).toBe(human);
  if (borrowed) {
    expect(metadataOf(row)).toMatchObject({ impersonatedBetterAuthUserId: borrowed });
  } else {
    expect(metadataOf(row)).not.toHaveProperty("impersonatedBetterAuthUserId");
  }
}

const setsOn = (table: string) => writes.sets.filter((s) => s.table === table).map((s) => s.values);

const insertsInto = (table: string) =>
  writes.inserts.filter((i) => i.table === table).map((i) => i.values);

async function bucketKeys(): Promise<string[]> {
  const { __rateLimitBucketKeysForTests } = await import("@/lib/admin/rate-limit.server");
  return __rateLimitBucketKeysForTests();
}

beforeEach(() => {
  writes.audit.length = 0;
  writes.inserts.length = 0;
  writes.sets.length = 0;
  reads.first = {};
  reads.rows = {};
  for (const m of [
    sessionGetter,
    accessGetter,
    authBan,
    authUpdateUser,
    getApiKeyById,
    revokeApiKey,
  ])
    m.mockReset();
  authBan.mockResolvedValue(undefined);
  authUpdateUser.mockResolvedValue({});
});
afterEach(() => vi.resetModules());

describe("admin console — DELETE /api/administrator/users/[id] (soft delete)", () => {
  async function softDelete(): Promise<Response> {
    const { DELETE } = await import("@/app/api/administrator/users/[id]/route");
    return DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, "DELETE", {
        reason: "spam",
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
  }

  it("names the impersonating admin on the audit row, in deactivated_by and on the rate-limit bucket", async () => {
    sessionGetter.mockResolvedValue(IMPERSONATED);
    accessGetter.mockResolvedValue(access(["admin.users.delete"]));

    expect((await softDelete()).status).toBe(200);

    const row = auditRow("admin.user.soft_deleted");
    expect(row.actor_better_auth_user_id).toBe(HUMAN);
    expect(row.app_user_id).toBe(TARGET_ID);
    expect(metadataOf(row)).toMatchObject({ impersonatedBetterAuthUserId: BORROWED });

    const deactivation = writes.sets.find((s) => s.table === "app_users");
    expect(deactivation?.values).toMatchObject({ status: "deactivated", deactivated_by: HUMAN });

    const keys = await bucketKeys();
    expect(keys).toContain(`admin.users.mutate:${HUMAN}`);
    expect(keys).not.toContain(`admin.users.mutate:${BORROWED}`);
  });

  it("control: an admin on their OWN session is the actor, with no impersonation metadata", async () => {
    sessionGetter.mockResolvedValue(OWN_SESSION);
    accessGetter.mockResolvedValue(access(["admin.users.delete"]));

    expect((await softDelete()).status).toBe(200);

    const row = auditRow("admin.user.soft_deleted");
    expect(row.actor_better_auth_user_id).toBe("ba-admin");
    expect(metadataOf(row)).not.toHaveProperty("impersonatedBetterAuthUserId");
    expect(writes.sets.find((s) => s.table === "app_users")?.values).toMatchObject({
      deactivated_by: "ba-admin",
    });
    expect(await bucketKeys()).toContain("admin.users.mutate:ba-admin");
  });

  it("the permission guard's own denial row names the human", async () => {
    sessionGetter.mockResolvedValue(IMPERSONATED);
    accessGetter.mockResolvedValue(access(["admin.users.read"]));

    expect((await softDelete()).status).toBe(403);

    const row = auditRow("administrator.access.denied");
    expect(row.actor_better_auth_user_id).toBe(HUMAN);
    expect(metadataOf(row)).toMatchObject({
      required: ["admin.users.delete"],
      impersonatedBetterAuthUserId: BORROWED,
    });
  });
});

describe("account self-service — PATCH /api/account/profile", () => {
  it("attributes an edit made while impersonating the user to the admin", async () => {
    sessionGetter.mockResolvedValue(IMPERSONATED);
    accessGetter.mockResolvedValue(access(["shell.view"]));

    const { PATCH } = await import("@/app/api/account/profile/route");
    const res = await PATCH(
      makeRequest("http://test.local/api/account/profile", "PATCH", { name: "Changed" }),
    );
    expect(res.status).toBe(200);

    const row = auditRow("account.profile.updated");
    expect(row.actor_better_auth_user_id).toBe(HUMAN);
    // The subject of the change is still the user's own account.
    expect(row.app_user_id).toBe("u-session");
    expect(metadataOf(row)).toEqual({
      fields: ["name"],
      impersonatedBetterAuthUserId: BORROWED,
    });
    expect(await bucketKeys()).toEqual([`account.profile:${HUMAN}`]);
  });
});

describe("versioned API — DELETE /api/v1/admin/api-keys/[id]", () => {
  it("attributes a cookie-session revocation to the admin and charges the admin's bucket", async () => {
    sessionGetter.mockResolvedValue(IMPERSONATED);
    accessGetter.mockResolvedValue(access(["admin.apikeys.manage"]));
    getApiKeyById.mockResolvedValue({ id: KEY_ID, organization_id: "o-1", app_user_id: "u-owner" });
    revokeApiKey.mockResolvedValue(true);

    const { DELETE } = await import("@/app/api/v1/admin/api-keys/[id]/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/v1/admin/api-keys/${KEY_ID}`, "DELETE"),
      { params: Promise.resolve({ id: KEY_ID }) },
    );
    expect(res.status).toBe(200);

    const row = auditRow("api_key.revoked");
    expect(row.actor_better_auth_user_id).toBe(HUMAN);
    expect(metadataOf(row)).toMatchObject({
      apiKeyId: KEY_ID,
      impersonatedBetterAuthUserId: BORROWED,
    });
    expect(await bucketKeys()).toEqual([`api.admin.apikeys:${HUMAN}`]);
  });
});

describe("admin console — POST /api/administrator/users/bulk (soft_delete)", () => {
  it.each(SESSIONS)(
    "$label: deactivated_by, the audit rows and the bulk bucket name the human",
    async ({ session, human, borrowed }) => {
      sessionGetter.mockResolvedValue(session);
      accessGetter.mockResolvedValue(access(["admin.users.delete"]));
      reads.rows["select:app_users"] = [
        {
          id: TARGET_ID,
          better_auth_user_id: "ba-victim",
          primary_email: "victim@example.com",
          status: "active",
        },
      ];

      const { POST } = await import("@/app/api/administrator/users/bulk/route");
      const res = await POST(
        makeRequest("http://test.local/api/administrator/users/bulk", "POST", {
          action: "soft_delete",
          ids: [TARGET_ID],
          reason: "spam",
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ attempted: 1, succeeded: 1 });

      // The column the route hands the helper: the human, not the borrowed id.
      expect(setsOn("app_users")).toContainEqual(
        expect.objectContaining({ status: "deactivated", deactivated_by: human }),
      );
      expectAttributedTo(auditRow("admin.user.soft_deleted"), human, borrowed);
      expectAttributedTo(auditRow("admin.users.bulk_action"), human, borrowed);

      const keys = await bucketKeys();
      expect(keys).toContain(`admin.users.bulk:${human}`);
      if (borrowed) expect(keys).not.toContain(`admin.users.bulk:${borrowed}`);
    },
  );
});

describe("admin console — DELETE /api/administrator/organizations/[id]/invitations/[invitationId]", () => {
  it.each(SESSIONS)(
    "$label: revoked_by and the audit row name the human",
    async ({ session, human, borrowed }) => {
      sessionGetter.mockResolvedValue(session);
      accessGetter.mockResolvedValue(access(["admin.orgs.update"], ORG_ID));
      reads.first["select:app_organizations"] = ORG;
      reads.first["update:app_organization_invitations"] = { numUpdatedRows: 1n };

      const { DELETE } =
        await import("@/app/api/administrator/organizations/[id]/invitations/[invitationId]/route");
      const res = await DELETE(
        makeRequest(
          `http://test.local/api/administrator/organizations/${ORG_ID}/invitations/${INVITATION_ID}`,
          "DELETE",
        ),
        { params: Promise.resolve({ id: ORG_ID, invitationId: INVITATION_ID }) },
      );
      expect(res.status).toBe(200);

      expect(setsOn("app_organization_invitations")).toEqual([
        expect.objectContaining({ status: "revoked", revoked_by: human }),
      ]);
      expectAttributedTo(auditRow("admin.organization.invitation_revoked"), human, borrowed);
    },
  );
});

describe("admin console — PATCH auth settings (org override and platform default)", () => {
  it.each(SESSIONS)(
    "$label: the org policy row's updated_by and the audit row name the human",
    async ({ session, human, borrowed }) => {
      sessionGetter.mockResolvedValue(session);
      accessGetter.mockResolvedValue(access(["admin.orgs.update"], ORG_ID));
      reads.first["select:app_organizations"] = ORG;

      const { PATCH } =
        await import("@/app/api/administrator/organizations/[id]/auth-settings/route");
      const res = await PATCH(
        makeRequest(
          `http://test.local/api/administrator/organizations/${ORG_ID}/auth-settings`,
          "PATCH",
          POLICY,
        ),
        { params: Promise.resolve({ id: ORG_ID }) },
      );
      expect(res.status).toBe(200);

      expect(insertsInto("app_organization_auth_settings")).toEqual([
        expect.objectContaining({ organization_id: ORG_ID, updated_by: human }),
      ]);
      expectAttributedTo(auditRow("admin.organization.auth_policy_updated"), human, borrowed);
    },
  );

  it.each(SESSIONS)(
    "$label: the platform default's updated_by and the audit row name the human",
    async ({ session, human, borrowed }) => {
      sessionGetter.mockResolvedValue(session);
      accessGetter.mockResolvedValue(access(["superuser"], null));

      const { PATCH } = await import("@/app/api/administrator/auth-settings/defaults/route");
      const res = await PATCH(
        makeRequest("http://test.local/api/administrator/auth-settings/defaults", "PATCH", POLICY),
      );
      expect(res.status).toBe(200);

      expect(insertsInto("app_organization_auth_settings")).toEqual([
        expect.objectContaining({ organization_id: null, updated_by: human }),
      ]);
      expectAttributedTo(auditRow("admin.platform.auth_policy_updated"), human, borrowed);
    },
  );
});

describe("invitation acceptance — POST /api/invitations/accept (reads the session itself)", () => {
  const INVITEE_EMAIL = "invitee@example.com";

  it.each(SESSIONS)(
    "$label: the acceptance row and the accept bucket name the human",
    async ({ session, human, borrowed }) => {
      sessionGetter.mockResolvedValue({
        ...session,
        user: { ...session.user, email: INVITEE_EMAIL },
      });
      // The token lookup's joined row (`findValidInvitationByToken` runs for real).
      reads.first["select:app_organization_invitations as i"] = {
        id: INVITATION_ID,
        organization_id: ORG_ID,
        organization_name: "Org A",
        email: INVITEE_EMAIL,
        role_id: null,
        invited_by: null,
        status: "pending",
        expires_at: new Date("2099-01-01T00:00:00Z"),
      };
      reads.first["select:app_users"] = { id: "u-invitee", status: "pending_approval" };
      reads.first["update:app_organization_invitations"] = { numUpdatedRows: 1n };

      const { POST } = await import("@/app/api/invitations/accept/route");
      const res = await POST(
        makeRequest("http://test.local/api/invitations/accept", "POST", { token: "t" }),
      );
      expect(res.status).toBe(200);

      const row = auditRow("auth.account.invitation_accepted");
      expectAttributedTo(row, human, borrowed);
      // Written with the accepting request: its user agent reached the row.
      expect(row.user_agent).toBe("vitest");
      expect(row.app_user_id).toBe("u-invitee");

      const keys = await bucketKeys();
      expect(keys).toContain(`invitations.accept:${human}`);
      if (borrowed) expect(keys).not.toContain(`invitations.accept:${borrowed}`);
    },
  );
});
