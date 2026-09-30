import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as ErasureModule from "@/lib/admin/user-erasure.server";

/**
 * F-151 — the administrator's half of the data-subject lifecycle:
 *
 *   - `GET /api/administrator/users/[id]/export`: `admin.users.export`, the rank
 *     guard, the AUTHZ-2 shared-target rule, and an organization
 *     administrator's document confined to their organization;
 *   - `POST /api/administrator/users/[id]/erase`: `admin.users.delete` plus
 *     cross-org reach (audited when missing), a soft-deleted target, the typed
 *     address, credentials revoked BEFORE the data goes, the pseudonym on the
 *     audit row, and the refusals mapped (409 on a restore race, 500 audited
 *     on a failure).
 *
 * The permission pipeline and target resolution are the real ones; the
 * document builder, the erasure function and the credential eviction are
 * stubbed (they are proven in tests/db/user-data-export-erasure.db.test.ts
 * and tests/db/credential-eviction.db.test.ts).
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const dbMock = vi.fn();
const requiresSuperadminMock = vi.fn();
const superuserGrantMock = vi.fn();
const buildExportMock = vi.fn();
const pseudonymiseMock = vi.fn();
const revokeCredentialsMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (...a: unknown[]) => accessGetter(...a) };
});
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return {
    ...actual,
    requiresSuperadminForSharedTarget: (...a: unknown[]) => requiresSuperadminMock(...a),
    userHoldsSuperuserGrant: (...a: unknown[]) => superuserGrantMock(...a),
  };
});
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/user-data/export.server", () => ({
  buildUserDataExport: (...a: unknown[]) => buildExportMock(...a),
}));
vi.mock("@/lib/admin/user-erasure.server", async () => {
  const actual = await vi.importActual<typeof ErasureModule>("@/lib/admin/user-erasure.server");
  return { ...actual, pseudonymiseUser: (...a: unknown[]) => pseudonymiseMock(...a) };
});
vi.mock("@/lib/api-auth/credential-eviction.server", () => ({
  revokeBearerCredentialsOf: (...a: unknown[]) => revokeCredentialsMock(...a),
}));

function makeChain(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst" || prop === "executeTakeFirstOrThrow") return dbMock;
        if (prop === "execute") return () => Promise.resolve([]);
        return () => makeChain();
      },
    },
  );
}
vi.mock("@/db/database", () => ({
  db: { selectFrom: () => makeChain(), insertInto: () => makeChain() },
}));

const TARGET_ID = "11111111-1111-4111-8111-111111111151";
const PSEUDONYM = `erased+${TARGET_ID}@erased.invalid`;
const ACTOR_BA = "ba-admin";
const params = { params: Promise.resolve({ id: TARGET_ID }) };

const baseAccess = {
  appUserId: "u-admin",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
};
/** An org admin holding `permissions` (the target resolves as a plain member). */
function actingAs(permissions: string[]) {
  sessionGetter.mockResolvedValue({ user: { id: ACTOR_BA } });
  accessGetter.mockImplementation((id: string) =>
    id === ACTOR_BA
      ? { ...baseAccess, permissions: ["shell.view", ...permissions] }
      : { ...baseAccess, appUserId: "u-target", permissions: ["shell.view"] },
  );
}
const SUPERADMIN = ["superuser", "admin.users.delete", "admin.users.export"];

const targetRow = {
  id: TARGET_ID,
  better_auth_user_id: "ba-target",
  primary_email: "Target@Example.com",
  display_name: "Target",
  status: "deactivated",
};

function makeRequest(url: string, init: { method?: string; body?: unknown } = {}): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    method: init.method ?? "GET",
    headers: new Headers(),
    json: async () => {
      if (init.body === "not json") throw new SyntaxError("bad json");
      return init.body ?? {};
    },
  } as unknown as NextRequest;
}

beforeEach(async () => {
  for (const m of [
    sessionGetter,
    accessGetter,
    auditMock,
    dbMock,
    requiresSuperadminMock,
    superuserGrantMock,
    buildExportMock,
    pseudonymiseMock,
    revokeCredentialsMock,
  ]) {
    m.mockReset();
  }
  dbMock.mockResolvedValue(targetRow);
  requiresSuperadminMock.mockResolvedValue(false);
  superuserGrantMock.mockResolvedValue(false);
  revokeCredentialsMock.mockResolvedValue({ apiKeyIds: [], oauthClientIds: [] });
  const { __resetRateLimitForTests } = await import("@/lib/admin/rate-limit.server");
  __resetRateLimitForTests();
});
afterEach(() => vi.resetModules());

const DOC = {
  generatedAt: "2026-09-29T00:00:00.000Z",
  organizationScope: "o-1",
  profile: { appUserId: TARGET_ID },
  memberships: [{}],
  roles: [],
  groups: [],
  linkedAccounts: [],
  sessions: [],
  apiKeys: [],
  oauthClients: [],
  invitations: [],
  auditEvents: [{}],
  auditEventsTruncated: false,
};

async function exportUser() {
  const { GET } = await import("@/app/api/administrator/users/[id]/export/route");
  return GET(makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/export`), params);
}

describe("GET /api/administrator/users/[id]/export (F-151)", () => {
  it("is 403, audited, without admin.users.export", async () => {
    actingAs(["admin.users.read", "admin.audit.read", "admin.users.sessions"]);
    const res = await exportUser();
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        reason: "missing_admin_permission",
      }),
    );
    expect(buildExportMock).not.toHaveBeenCalled();
  });

  it("confines an organization administrator's document to their organization, and audits the counts", async () => {
    actingAs(["admin.users.export"]);
    buildExportMock.mockResolvedValue(DOC);
    const res = await exportUser();
    expect(res.status).toBe(200);
    expect(buildExportMock).toHaveBeenCalledWith(TARGET_ID, { organizationId: "o-1" });
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="user-data-${TARGET_ID}-20260929.json"`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(DOC);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.data_exported",
        outcome: "success",
        actorBetterAuthUserId: ACTOR_BA,
        appUserId: TARGET_ID,
        organizationId: "o-1",
        metadata: {
          counts: expect.objectContaining({ memberships: 1, auditEvents: 1 }),
          organizationScope: "o-1",
          auditEventsTruncated: false,
        },
      }),
    );
  });

  it("gives a superadmin the whole account", async () => {
    actingAs(SUPERADMIN);
    buildExportMock.mockResolvedValue({ ...DOC, organizationScope: null });
    expect((await exportUser()).status).toBe(200);
    expect(buildExportMock).toHaveBeenCalledWith(TARGET_ID, { organizationId: null });
  });

  it("refuses a target who outranks the caller (rank guard), audited", async () => {
    actingAs(["admin.users.export"]);
    superuserGrantMock.mockResolvedValue(true);
    const res = await exportUser();
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.action_denied",
        reason: "target_outranks_actor",
        metadata: expect.objectContaining({ action: "data_export" }),
      }),
    );
    expect(buildExportMock).not.toHaveBeenCalled();
  });

  it("refuses a user shared with other organizations to an org admin (AUTHZ-2), audited", async () => {
    actingAs(["admin.users.export"]);
    requiresSuperadminMock.mockResolvedValue(true);
    const res = await exportUser();
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.action_denied",
        reason: "shared_target_requires_superadmin",
        metadata: expect.objectContaining({ action: "data_export" }),
      }),
    );
    expect(buildExportMock).not.toHaveBeenCalled();
  });

  it("is 404 for a target out of reach, and when the row is gone before the build", async () => {
    actingAs(SUPERADMIN);
    dbMock.mockResolvedValue(undefined);
    expect((await exportUser()).status).toBe(404);
    expect(buildExportMock).not.toHaveBeenCalled();

    dbMock.mockResolvedValue(targetRow);
    buildExportMock.mockResolvedValue(null);
    expect((await exportUser()).status).toBe(404);
  });

  // A caller with no organization and no cross-org reach reaches no user:
  // target resolution (canAccessUser) answers 404 before the route's own
  // scope check, so nothing is built.
  it("is 404, building nothing, for a caller with no organization", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_BA } });
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_BA
        ? { ...baseAccess, organizationId: null, permissions: ["shell.view", "admin.users.export"] }
        : { ...baseAccess, organizationId: null, permissions: ["shell.view"] },
    );
    const res = await exportUser();
    expect(res.status).toBe(404);
    expect(buildExportMock).not.toHaveBeenCalled();
  });

  it("is rate-limited on the export tier", async () => {
    actingAs(SUPERADMIN);
    buildExportMock.mockResolvedValue(DOC);
    for (let i = 0; i < 3; i++) expect((await exportUser()).status).toBe(200);
    expect((await exportUser()).status).toBe(429);
  });
});

async function erase(body: unknown = { confirmEmail: "target@example.com" }) {
  const { POST } = await import("@/app/api/administrator/users/[id]/erase/route");
  return POST(
    makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/erase`, {
      method: "POST",
      body,
    }),
    params,
  );
}

const RESULT = {
  pseudonym: PSEUDONYM,
  alreadyErased: false,
  sessions: 1,
  accounts: 2,
  verifications: 0,
  localePreferences: 1,
  apiKeys: 0,
  oauthClients: 0,
  invitations: 1,
  outbox: 3,
  auditEvents: 7,
};

describe("POST /api/administrator/users/[id]/erase (F-151)", () => {
  it("erases a soft-deleted user: credentials revoked first, then the function, then the audit row under the pseudonym", async () => {
    actingAs(SUPERADMIN);
    const order: string[] = [];
    revokeCredentialsMock.mockImplementation(async () => {
      order.push("revoke");
      return { apiKeyIds: [], oauthClientIds: [] };
    });
    pseudonymiseMock.mockImplementation(async () => {
      order.push("pseudonymise");
      return RESULT;
    });

    // The typed address is compared case-insensitively.
    const res = await erase({ confirmEmail: " TARGET@example.COM " });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyErased: false });
    expect(order).toEqual(["revoke", "pseudonymise"]);
    expect(revokeCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: "ba-target",
        trigger: "owner_deleted",
        actorBetterAuthUserId: ACTOR_BA,
      }),
    );
    expect(pseudonymiseMock).toHaveBeenCalledWith(TARGET_ID);
    const { pseudonym: _p, alreadyErased: _a, ...counts } = RESULT;
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.erased",
        outcome: "success",
        appUserId: TARGET_ID,
        email: PSEUDONYM,
        metadata: { alreadyErased: false, counts },
      }),
    );
    // The real address is not written into the new row.
    const erasedRow = auditMock.mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === "admin.user.erased",
    )![0];
    expect(JSON.stringify(erasedRow).toLowerCase()).not.toContain("target@example.com");
  });

  it("is 403 and audited for a caller without cross-org reach, before the target is read", async () => {
    actingAs(["admin.users.delete"]);
    const res = await erase();
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        reason: "cross_org_reach_required",
        metadata: { action: "user_erase", requestedTargetId: TARGET_ID },
      }),
    );
    expect(dbMock).not.toHaveBeenCalled();
    expect(pseudonymiseMock).not.toHaveBeenCalled();
  });

  it("is 403 without admin.users.delete", async () => {
    actingAs(["admin.users.read"]);
    expect((await erase()).status).toBe(403);
    expect(pseudonymiseMock).not.toHaveBeenCalled();
  });

  it("is 404 for a target that does not exist, and erases nothing", async () => {
    actingAs(SUPERADMIN);
    dbMock.mockResolvedValue(undefined);
    const res = await erase();
    expect(res.status).toBe(404);
    expect(revokeCredentialsMock).not.toHaveBeenCalled();
    expect(pseudonymiseMock).not.toHaveBeenCalled();
  });

  it("is rate-limited per actor on the mutation tier, before the target is read", async () => {
    actingAs(SUPERADMIN);
    // Each call stops at 409 not_deactivated, which still spends a token.
    dbMock.mockResolvedValue({ ...targetRow, status: "active" });
    for (let i = 0; i < 30; i++) expect((await erase()).status).toBe(409);
    dbMock.mockClear();
    const res = await erase();
    expect(res.status).toBe(429);
    expect(dbMock).not.toHaveBeenCalled();
    expect(pseudonymiseMock).not.toHaveBeenCalled();
  });

  it("is 409 not_deactivated for a user who is not soft-deleted", async () => {
    actingAs(SUPERADMIN);
    dbMock.mockResolvedValue({ ...targetRow, status: "active" });
    const res = await erase();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_deactivated" });
    expect(revokeCredentialsMock).not.toHaveBeenCalled();
  });

  it("is 409 for an agent service account", async () => {
    actingAs(SUPERADMIN);
    dbMock.mockResolvedValue({
      ...targetRow,
      better_auth_user_id: "mcp-agent:5b0c7f6e-0c1e-4a57-9d3a-1f2e3d4c5b6a",
    });
    const res = await erase();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_applicable_to_service_account" });
  });

  it.each([
    ["a wrong address", { confirmEmail: "someone@else.com" }],
    ["no address", {}],
    ["an unknown field", { confirmEmail: "target@example.com", force: true }],
    ["an unparseable body", "not json"],
  ])("is 400 invalid_body for %s, and erases nothing", async (_label, body) => {
    actingAs(SUPERADMIN);
    const res = await erase(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(revokeCredentialsMock).not.toHaveBeenCalled();
    expect(pseudonymiseMock).not.toHaveBeenCalled();
  });

  it("maps the function's not-soft-deleted refusal (a restore won the race) to 409, unaudited", async () => {
    actingAs(SUPERADMIN);
    pseudonymiseMock.mockRejectedValue(
      Object.assign(new Error("not deactivated"), { code: "55000" }),
    );
    const res = await erase();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_deactivated" });
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.erase_failed" }),
    );
  });

  it("answers 500 erase_failed with an audited error when the revocation or the function fails", async () => {
    actingAs(SUPERADMIN);
    revokeCredentialsMock.mockRejectedValue(new Error("eviction failed"));
    const res = await erase();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "erase_failed" });
    expect(pseudonymiseMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.erase_failed",
        outcome: "error",
        reason: "erase_failed",
        metadata: { message: "eviction failed" },
      }),
    );
  });

  it("accepts a repeat on an erased account and reports it", async () => {
    actingAs(SUPERADMIN);
    dbMock.mockResolvedValue({ ...targetRow, primary_email: PSEUDONYM });
    pseudonymiseMock.mockResolvedValue({ ...RESULT, alreadyErased: true, auditEvents: 0 });
    const res = await erase({ confirmEmail: PSEUDONYM });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyErased: true });
  });
});
