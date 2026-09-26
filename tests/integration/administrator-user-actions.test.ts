import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Integration tests for the user-mutation endpoints under
 * `/api/administrator/users/[id]/*` (docs/admin-manager.md §4, §8.1, §12).
 *
 * These tests pin the cross-cutting *handler contract*: permission gate
 * (401 / 403 + audit on missing permission), input validation and the
 * audit row written on success. The Better Auth + DB layers are stubbed
 * — we are not exercising the DB query plan here, just the route shape.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const dbMock = vi.fn();
const authBan = vi.fn();
const authUnban = vi.fn();
const authSetPassword = vi.fn();
const authForget = vi.fn();
const authSetRole = vi.fn();
const authListSessions = vi.fn();
const authRevokeSession = vi.fn();
const authRevokeSessions = vi.fn();
const authCreateUser = vi.fn();
const authUpdateUser = vi.fn();
// AUTHZ-2 shared-target gate. Default false (single-org / superadmin); flip to
// true to exercise the "account-global action on a shared user → 403" path.
const requiresSuperadminMock = vi.fn();
// Shared status-mutation core (exercised end-to-end by admin-status-action
// .test.ts); configurable so the review #7 guard tests can assert it is NOT
// reached for an out-ranking target.
const statusChangeMock = vi.fn();
// REVOKE-2 last-superadmin predicate for the soft-delete cascade (review #444).
// Default false = the platform has other superadmins.
const cascadeStripsLastMock = vi.fn();
// F-09 rank predicate (`userHoldsSuperuserGrant`). Default false.
const superuserGrantMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return {
    ...actual,
    requiresSuperadminForSharedTarget: (...a: unknown[]) => requiresSuperadminMock(...a),
    membershipCascadeStripsLastGlobalSuperuser: (...a: unknown[]) => cascadeStripsLastMock(...a),
    // F-09: the rank guard reads the target's superuser GRANT (awake or asleep
    // in a suspended org) for every non-superadmin actor. Default false = the
    // target holds none; rank then comes from the subset test below.
    userHoldsSuperuserGrant: (...a: unknown[]) => superuserGrantMock(...a),
  };
});
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    // Forward EVERY argument so tests can pin the bound-org call shape
    // (`getUserAccessContext(id, { organizationId })`), not just the id.
    getUserAccessContext: (...a: unknown[]) => accessGetter(...a),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

// Better Auth wrappers — we don't import the real `auth.api`.
vi.mock("@/lib/admin/auth-admin.server", () => ({
  banBetterAuthUser: (...a: unknown[]) => authBan(...a),
  unbanBetterAuthUser: (...a: unknown[]) => authUnban(...a),
  setBetterAuthUserPassword: (...a: unknown[]) => authSetPassword(...a),
  sendBetterAuthPasswordResetEmail: (...a: unknown[]) => authForget(...a),
  setBetterAuthUserRole: (...a: unknown[]) => authSetRole(...a),
  listBetterAuthUserSessions: (...a: unknown[]) => authListSessions(...a),
  revokeBetterAuthUserSession: (...a: unknown[]) => authRevokeSession(...a),
  revokeAllBetterAuthUserSessions: (...a: unknown[]) => authRevokeSessions(...a),
  createBetterAuthUser: (...a: unknown[]) => authCreateUser(...a),
  updateBetterAuthUser: (...a: unknown[]) => authUpdateUser(...a),
}));

// Stub the DB. The handlers call:
//   db.selectFrom("app_users").select([...]).where(...).executeTakeFirst()
//   db.updateTable(...).set(...).where(...).execute()
//   db.transaction().execute(cb)
// `dbMock` is the configurable `executeTakeFirst()` resolver for the
// target-resolution lookup; everything else returns a chainable proxy
// whose terminal methods resolve to undefined.
function makeChain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "executeTakeFirst") return dbMock;
      if (prop === "executeTakeFirstOrThrow") return dbMock;
      if (prop === "execute") return () => Promise.resolve([]);
      if (prop === "returning") {
        return () => makeChain();
      }
      return (..._args: unknown[]) => makeChain();
    },
  };
  return new Proxy({}, handler);
}

// F-480: the create routes look up an email-domain binding for a confined
// creator's address. None exists in these tests, and the lookup must not use
// up a `dbMock` answer meant for a statement a test sequences.
function noRowChain(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return () => Promise.resolve(undefined);
        return () => noRowChain();
      },
    },
  );
}

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) =>
      table === "app_provider_organizations" ? noRowChain() : makeChain(),
    updateTable: () => makeChain(),
    insertInto: () => makeChain(),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({
          // REVOKE-2 reads the target's memberships + the surviving grants
          // inside the soft-delete transaction (review #444).
          selectFrom: () => makeChain(),
          updateTable: () => makeChain(),
          insertInto: () => makeChain(),
        }),
    }),
  },
}));

// Likewise stub the shared status-mutation core used by the /status
// route (it is exercised end-to-end by admin-status-action.test.ts).
vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: (...a: unknown[]) => statusChangeMock(...a),
}));

const TARGET_ID = "11111111-1111-4111-8111-111111111101";

function makeRequest(url: string, init: RequestInit = {}): NextRequest {
  return {
    nextUrl: new URL(url),
    url,
    headers: new Headers(init.headers ?? {}),
    json: async () => (init.body ? JSON.parse(init.body as string) : {}),
    method: init.method ?? "GET",
  } as unknown as NextRequest;
}

const grantedAccess = (perm: string) => ({
  appUserId: "u-self",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: [perm],
});

const targetRow = {
  id: TARGET_ID,
  better_auth_user_id: "ba-target",
  primary_email: "target@example.com",
  display_name: "Target",
  status: "active",
};

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  dbMock.mockReset();
  authBan.mockReset();
  authUnban.mockReset();
  authSetPassword.mockReset();
  authForget.mockReset();
  authSetRole.mockReset();
  authListSessions.mockReset();
  authRevokeSession.mockReset();
  authRevokeSessions.mockReset();
  authCreateUser.mockReset();
  authUpdateUser.mockReset();
  requiresSuperadminMock.mockReset();
  requiresSuperadminMock.mockResolvedValue(false); // target not shared by default
  statusChangeMock.mockReset();
  statusChangeMock.mockResolvedValue({ ok: true, status: "active" });
  cascadeStripsLastMock.mockReset();
  cascadeStripsLastMock.mockResolvedValue(false);
  superuserGrantMock.mockReset();
  superuserGrantMock.mockResolvedValue(false);
});
afterEach(() => vi.resetModules());

describe("POST /api/administrator/users (create)", () => {
  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { POST } = await import("@/app/api/administrator/users/route");
    const res = await POST(
      makeRequest("http://test.local/api/administrator/users", {
        method: "POST",
        body: JSON.stringify({ email: "x@x.com", password: "12345678" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 + audit when caller lacks admin.users.create", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { POST } = await import("@/app/api/administrator/users/route");
    const res = await POST(
      makeRequest("http://test.local/api/administrator/users", {
        method: "POST",
        body: JSON.stringify({ email: "x@x.com", password: "12345678" }),
      }),
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
      }),
    );
  });

  async function create(access: ReturnType<typeof grantedAccess>, extra: object = {}) {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(access);
    dbMock
      .mockResolvedValueOnce(undefined) // no existing app user
      .mockResolvedValue({ id: "u-new", primary_email: "new@x.com", status: "pending_approval" });
    authCreateUser.mockResolvedValue({ user: { id: "ba-new" } });
    const { POST } = await import("@/app/api/administrator/users/route");
    return POST(
      makeRequest("http://test.local/api/administrator/users", {
        method: "POST",
        body: JSON.stringify({ email: "new@x.com", password: "Password#123", ...extra }),
      }),
    );
  }
  const superadminAccess = () => ({
    ...grantedAccess("admin.users.create"),
    permissions: ["admin.users.create", "superuser"],
  });
  // F-480: an org admin's create enrols the user in its org, which needs a
  // membership permission as well (tests/integration/user-create-enrolment.test.ts).
  const orgCreatorAccess = () => ({
    ...grantedAccess("admin.users.create"),
    permissions: ["admin.users.create", "admin.users.update"],
  });

  describe("F-03: only a creator with cross-org reach vouches for the address", () => {
    it("an ORG admin's creation carries no mailbox proof", async () => {
      const res = await create(orgCreatorAccess());
      expect(res.status).toBe(201);
      // F-13: and no caller credentials reach the wrapper (a trusted call).
      expect(authCreateUser).toHaveBeenCalledWith(expect.objectContaining({ emailUnproven: true }));
      expect(authCreateUser.mock.calls[0]).toHaveLength(1);
    });

    it("a SUPERADMIN's creation is vouched for", async () => {
      const res = await create(superadminAccess());
      expect(res.status).toBe(201);
      expect(authCreateUser).toHaveBeenCalledWith(
        expect.objectContaining({ emailUnproven: false }),
      );
    });
  });

  describe("F-13: the Better Auth `admin` role needs cross-org reach, as on POST …/role", () => {
    it("an ORG admin may not create a user with it: 403, and no identity is created", async () => {
      const res = await create(grantedAccess("admin.users.create"), { role: "admin" });
      expect(res.status).toBe(403);
      expect(authCreateUser).not.toHaveBeenCalled();
    });

    it("an ORG-BOUND superuser credential may not either (MACHINE-2)", async () => {
      const res = await create(
        { ...superadminAccess(), orgBound: true } as ReturnType<typeof grantedAccess>,
        { role: "admin" },
      );
      expect(res.status).toBe(403);
      expect(authCreateUser).not.toHaveBeenCalled();
    });

    it("a SUPERADMIN may", async () => {
      const res = await create(superadminAccess(), { role: "admin" });
      expect(res.status).toBe(201);
      expect(authCreateUser).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }));
    });

    it("an ORG admin still creates ordinary users", async () => {
      const res = await create(orgCreatorAccess(), { role: "user" });
      expect(res.status).toBe(201);
      expect(authCreateUser).toHaveBeenCalledWith(expect.objectContaining({ role: "user" }));
    });
  });

  it("rejects an invalid body with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.create"));
    const { POST } = await import("@/app/api/administrator/users/route");
    const res = await POST(
      makeRequest("http://test.local/api/administrator/users", {
        method: "POST",
        body: JSON.stringify({ email: "not-an-email", password: "short" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  /*
   * F-30: every failure row names NO `app_users` row. `app_user_id` is a
   * foreign key, and the nil UUID these rows used to name failed it, so the
   * route answered 500 with no audit row. And the `app_users` check is only a
   * courtesy (no unique key on the email): an address Better Auth already
   * holds fails inside `createBetterAuthUser`, which is the documented 409.
   * tests/db/user-create-failure-audit.db.test.ts runs these against Postgres.
   */
  describe("F-30: failure audits name no user; a held address is a 409", () => {
    async function failingCreate(fail: { create?: unknown; insert?: unknown; returned?: unknown }) {
      sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
      accessGetter.mockResolvedValue(orgCreatorAccess());
      dbMock.mockResolvedValueOnce(undefined); // the up-front email check passes
      if (fail.insert !== undefined) dbMock.mockRejectedValueOnce(fail.insert);
      if (fail.create !== undefined) authCreateUser.mockRejectedValue(fail.create);
      else
        authCreateUser.mockResolvedValue(
          "returned" in fail ? fail.returned : { user: { id: "ba-new" } },
        );
      const { POST } = await import("@/app/api/administrator/users/route");
      return POST(
        makeRequest("http://test.local/api/administrator/users", {
          method: "POST",
          body: JSON.stringify({ email: "held@x.com", password: "Password#123" }),
        }),
      );
    }
    const createFailedRow = () =>
      auditMock.mock.calls
        .map(([row]) => row as Record<string, unknown>)
        .filter((row) => row.eventType === "admin.user.create_failed");

    it.each([
      [
        "the admin plugin's refusal",
        Object.assign(new Error("User already exists. Use another email."), {
          body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
        }),
      ],
      [
        "a concurrent create's unique violation",
        Object.assign(new Error("duplicate key"), { code: "23505", constraint: "user_email_key" }),
      ],
    ])("Better Auth holds the address (%s): 409 email_taken", async (_label, err) => {
      const res = await failingCreate({ create: err });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "email_taken" });
      expect(createFailedRow()).toEqual([
        expect.objectContaining({
          outcome: "error",
          appUserId: null,
          email: "held@x.com",
          reason: "auth_user_exists",
        }),
      ]);
    });

    it("any other Better Auth failure: 502 auth_create_failed", async () => {
      const res = await failingCreate({ create: new Error("identity store unreachable") });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "auth_create_failed" });
      expect(createFailedRow()).toEqual([
        expect.objectContaining({ appUserId: null, reason: "auth_create_user_failed" }),
      ]);
    });

    it.each([
      ["a user with no id", { user: { email: "held@x.com" } }, ["user"]],
      ["nothing", null, []],
    ])(
      "Better Auth returns %s: 502 auth_create_failed, audited with only the returned key names",
      async (_l, returned, returnedKeys) => {
        const res = await failingCreate({ returned });
        expect(res.status).toBe(502);
        expect(await res.json()).toMatchObject({ error: "auth_create_failed" });
        expect(createFailedRow()).toEqual([
          expect.objectContaining({
            outcome: "error",
            appUserId: null,
            email: "held@x.com",
            reason: "auth_create_no_id",
            metadata: { returnedKeys },
          }),
        ]);
        expect(dbMock).toHaveBeenCalledTimes(1); // the up-front check; no insert
      },
    );

    it.each([
      ["a connection failure", new Error("connection reset")],
      // The one unique key on `app_users` is the id Better Auth just minted,
      // so a 23505 here is no email race and is not mapped to 409 any more.
      ["a unique violation", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ])(
      "the app_users insert fails (%s): 500, audited with the orphaned Better Auth id",
      async (_l, err) => {
        const res = await failingCreate({ insert: err });
        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: "internal_error" });
        expect(createFailedRow()).toEqual([
          expect.objectContaining({
            appUserId: null,
            reason: "db_insert_failed",
            metadata: { betterAuthUserId: "ba-new" },
          }),
        ]);
        expect(auditMock).not.toHaveBeenCalledWith(
          expect.objectContaining({ eventType: "admin.user.created" }),
        );
      },
    );
  });
});

describe("POST /api/administrator/users/[id]/ban", () => {
  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/ban`, {
        method: "POST",
        body: JSON.stringify({ reason: "spam" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 + audit when caller lacks admin.users.ban", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/ban`, {
        method: "POST",
        body: JSON.stringify({ reason: "spam" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects an invalid id with 400 before hitting the DB", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.ban"));
    const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
    const res = await POST(
      makeRequest("http://test.local/api/administrator/users/not-a-uuid/ban", {
        method: "POST",
        body: JSON.stringify({ reason: "spam" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(400);
    expect(authBan).not.toHaveBeenCalled();
  });

  it("returns 404 when the target user does not exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.ban"));
    dbMock.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/ban`, {
        method: "POST",
        body: JSON.stringify({ reason: "spam" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(404);
    expect(authBan).not.toHaveBeenCalled();
  });

  it("bans + audits success on a valid request", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.ban"));
    dbMock.mockResolvedValue(targetRow);
    authBan.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/ban`, {
        method: "POST",
        body: JSON.stringify({ reason: "spam" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(200);
    // F-13: the caller the guard authorized is named, so the wrapper can
    // refuse a ban of oneself; no caller credentials are passed.
    expect(authBan).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "ba-target",
        banReason: "spam",
        actorBetterAuthUserId: "ba-1",
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.banned",
        outcome: "success",
        appUserId: TARGET_ID,
      }),
    );
  });

  it("returns 403 when a non-superadmin bans a user shared with other orgs (AUTHZ-2)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.ban"));
    dbMock.mockResolvedValue(targetRow);
    requiresSuperadminMock.mockResolvedValue(true); // target is shared
    const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/ban`, {
        method: "POST",
        body: JSON.stringify({ reason: "spam" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(403);
    expect(authBan).not.toHaveBeenCalled();
  });
});

describe("POST /api/administrator/users/[id]/password", () => {
  it("never logs the password value in audit metadata (mode=set)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.setPassword"));
    dbMock.mockResolvedValue(targetRow);
    authSetPassword.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
        method: "POST",
        body: JSON.stringify({ mode: "set", password: "supersecret-pw-123" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(200);
    // Only the `metadata` field is persisted as JSON by `auditEvent`,
    // so scope the negative assertion there. (The `reason` field is
    // also persisted but we additionally scan it to be safe.)
    for (const call of auditMock.mock.calls) {
      const arg = call[0] as { metadata?: Record<string, unknown>; reason?: string | null };
      const metaBlob = JSON.stringify(arg?.metadata ?? {});
      expect(metaBlob).not.toContain("supersecret-pw-123");
      expect(arg?.reason ?? "").not.toContain("supersecret-pw-123");
    }
  });

  it("F-10: sets the password in the actor's name, so the credential cut-off records the admin", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.setPassword"));
    dbMock.mockResolvedValue(targetRow);
    authSetPassword.mockResolvedValue({ status: true });
    const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
    const request = makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
      method: "POST",
      body: JSON.stringify({ mode: "set", password: "supersecret-pw-123" }),
    });
    const res = await POST(request, { params: Promise.resolve({ id: TARGET_ID }) });

    expect(res.status).toBe(200);
    expect(authSetPassword).toHaveBeenCalledWith(
      {
        userId: "ba-target",
        newPassword: "supersecret-pw-123",
        setBy: { betterAuthUserId: "ba-1", appUserId: "u-self", requestId: expect.any(String) },
      },
      request,
    );
  });

  it("reports 502 + a failure audit, and no success row, whenever the wrapper throws", async () => {
    // The wrapper is mocked here, so this pins the ROUTE's half only. Since
    // F-10 the wrapper also throws when ending the sessions or revoking the
    // bearer credentials fails; that half is pinned on the real wrapper in
    // tests/security/impersonation-containment.test.ts ("admin set-password
    // reports failure when the credentials could not be revoked"). The operator
    // retries instead of believing the account is contained; every step is
    // idempotent.
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.setPassword"));
    dbMock.mockResolvedValue(targetRow);
    authSetPassword.mockRejectedValue(new Error("db down"));
    const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
        method: "POST",
        body: JSON.stringify({ mode: "set", password: "supersecret-pw-123" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );

    expect(res.status).toBe(502);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.password_set_failed",
        reason: "auth_set_password_failed",
      }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.password_set" }),
    );
  });

  it("dispatches reset_email mode and audits", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.setPassword"));
    dbMock.mockResolvedValue(targetRow);
    authForget.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
        method: "POST",
        body: JSON.stringify({ mode: "reset_email" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(200);
    expect(authForget).toHaveBeenCalledWith("target@example.com", undefined, expect.anything());
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.password_reset_email_sent" }),
    );
  });

  it("returns 403 when a non-superadmin sets the password of a shared user (AUTHZ-2)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.setPassword"));
    dbMock.mockResolvedValue(targetRow);
    requiresSuperadminMock.mockResolvedValue(true); // target shared across orgs
    const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
    const res = await POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
        method: "POST",
        body: JSON.stringify({ mode: "set", password: "supersecret-pw-123" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(403);
    expect(authSetPassword).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/administrator/users/[id]/sessions (revoke all)", () => {
  it("revokes all sessions for a non-shared target (200)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.sessions"));
    dbMock.mockResolvedValue(targetRow);
    authRevokeSessions.mockResolvedValue({ ok: true });
    const { DELETE } = await import("@/app/api/administrator/users/[id]/sessions/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/sessions`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(200);
    expect(authRevokeSessions).toHaveBeenCalled();
  });

  it("returns 403 when a non-superadmin revokes all sessions of a shared user (AUTHZ-2)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.sessions"));
    dbMock.mockResolvedValue(targetRow);
    requiresSuperadminMock.mockResolvedValue(true); // target shared across orgs
    const { DELETE } = await import("@/app/api/administrator/users/[id]/sessions/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/sessions`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(403);
    expect(authRevokeSessions).not.toHaveBeenCalled();
  });
});

/**
 * F-21: the admin create and the display-name edit share the name rule
 * (`user-name.ts`). A line break or bidi control is a 400 `invalid_body`
 * before anything is written; an accepted name is mirrored to Better Auth in
 * its canonical spelling.
 */
describe("F-21: the admin user writes refuse a name that breaks the rule", () => {
  it.each([
    ["a line break", "Ann\nLee"],
    ["a bidi override", "Ann \u202egnp.exe"],
  ])("POST /users refuses a name with %s, before creating anything", async (_label, name) => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.create"));
    const { POST } = await import("@/app/api/administrator/users/route");
    const res = await POST(
      makeRequest("http://test.local/api/administrator/users", {
        method: "POST",
        body: JSON.stringify({ email: "new@x.com", password: "Password#123", name }),
      }),
    );
    expect(res.status).toBe(400);
    expect(authCreateUser).not.toHaveBeenCalled();
  });

  async function patch(body: object) {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.update"));
    dbMock.mockResolvedValue(targetRow);
    authUpdateUser.mockResolvedValue({});
    const { PATCH } = await import("@/app/api/administrator/users/[id]/route");
    return PATCH(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
  }

  it("PATCH /users/[id] refuses a displayName with a tab, before any write", async () => {
    const res = await patch({ displayName: "Ann\tLee" });
    expect(res.status).toBe(400);
    expect(authUpdateUser).not.toHaveBeenCalled();
  });

  it("PATCH /users/[id] mirrors the canonical spelling to Better Auth", async () => {
    const res = await patch({ displayName: "  Ada \u00a0 Lovelace " });
    expect(res.status).toBe(200);
    expect(authUpdateUser).toHaveBeenCalledWith({
      userId: "ba-target",
      data: { name: "Ada Lovelace" },
    });
  });
});

describe("DELETE /api/administrator/users/[id] (soft delete)", () => {
  it("requires admin.users.delete (403 + audit otherwise)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { DELETE } = await import("@/app/api/administrator/users/[id]/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(403);
    expect(authBan).not.toHaveBeenCalled();
  });

  it("bans Better Auth then soft-deletes + audits", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.delete"));
    dbMock.mockResolvedValue(targetRow);
    authBan.mockResolvedValue({ ok: true });
    const { DELETE } = await import("@/app/api/administrator/users/[id]/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: "spam-account" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(200);
    // Better Auth ban issued first (so the user can't sign in even if
    // the app-side update fails), naming the caller so a self-delete is
    // refused (F-13).
    expect(authBan).toHaveBeenCalledWith({
      userId: "ba-target",
      banReason: "spam-account",
      actorBetterAuthUserId: "ba-1",
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.soft_deleted",
        outcome: "success",
        reason: "spam-account",
      }),
    );
  });

  /**
   * REVOKE-2 (review #444). The soft-delete cascade blocks EVERY membership the
   * target holds — the same transition `PATCH/DELETE …/memberships` refuses
   * with 409 — and `targetOutranksActor` exempts a superadmin actor outright,
   * so this is what stops the platform's last superadmin from soft-deleting
   * themselves and leaving nobody able to administer it.
   */
  it("returns 409 last_superadmin when the cascade would strip the last global superuser", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.delete"));
    dbMock.mockResolvedValue(targetRow);
    authBan.mockResolvedValue({ ok: true });
    cascadeStripsLastMock.mockResolvedValue(true);
    const { DELETE } = await import("@/app/api/administrator/users/[id]/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ error: "last_superadmin" }));
    // The ban was already applied when the refusal fired, so the saga must have
    // compensated it — the account has to be left exactly as it was.
    expect(authUnban).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.superuser.revocation_denied",
        outcome: "denied",
        reason: "last_global_superuser",
      }),
    );
    // NOT the generic 500-class cascade failure.
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.soft_delete_failed" }),
    );
  });

  it("returns 403 when a non-superadmin soft-deletes a user shared with other orgs (AUTHZ-2)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.delete"));
    dbMock.mockResolvedValue(targetRow);
    requiresSuperadminMock.mockResolvedValue(true); // target is shared
    const { DELETE } = await import("@/app/api/administrator/users/[id]/route");
    const res = await DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, {
        method: "DELETE",
        body: JSON.stringify({ reason: "spam-account" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(403);
    expect(authBan).not.toHaveBeenCalled();
  });
});

describe("GET /api/administrator/users/[id]/sessions — SessionItem projection (review #67/#194)", () => {
  it("returns id + metadata only: no `token` (or any other raw key) ever leaves the server", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.sessions"));
    dbMock.mockResolvedValue(targetRow);
    authListSessions.mockResolvedValue({ sessions: [RAW_SESSION, { ...RAW_SESSION, id: "s2" }] });
    const { GET } = await import("@/app/api/administrator/users/[id]/sessions/route");
    const res = await GET(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/sessions`),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SESSION_TOKEN_SECRET);
    const body = JSON.parse(text) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(2);
    for (const item of body.sessions) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "expiresAt",
        "id",
        "impersonatedBy",
        "ipAddress",
        "updatedAt",
        "userAgent",
      ]);
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("userId");
    }
    expect(body.sessions[0]).toEqual({
      id: SESSION_ID,
      createdAt: "2026-09-05T10:00:00.000Z",
      updatedAt: "2026-09-05T10:05:00.000Z",
      expiresAt: "2026-09-05T18:00:00.000Z",
      ipAddress: "203.0.113.9",
      userAgent: "UA/1",
      impersonatedBy: null,
    });
  });
});

describe("DELETE /api/administrator/users/[id]/sessions/[sessionId] (revoke by id, review #67/#194)", () => {
  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.sessions"));
    dbMock.mockResolvedValue(targetRow);
    authRevokeSession.mockResolvedValue({ ok: true });
  });

  async function revoke(sessionId: string) {
    const { DELETE } =
      await import("@/app/api/administrator/users/[id]/sessions/[sessionId]/route");
    return DELETE(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/sessions/${sessionId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: TARGET_ID, sessionId }) },
    );
  }

  it("resolves the id to the token server-side (scoped to the target's own sessions) and revokes it", async () => {
    authListSessions.mockResolvedValue([
      { ...RAW_SESSION, id: "other", token: "other-token" },
      RAW_SESSION,
    ]);
    const res = await revoke(SESSION_ID);
    expect(res.status).toBe(200);
    expect(authListSessions).toHaveBeenCalledWith("ba-target");
    expect(authRevokeSession).toHaveBeenCalledTimes(1);
    expect(authRevokeSession.mock.calls[0]![0]).toBe(SESSION_TOKEN_SECRET);
    // The session token must not appear in `metadata` (the only field
    // `auditEvent` persists as JSON in `app_audit_events.metadata`); the
    // opaque id is recorded instead.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.session_revoked",
        metadata: { sessionId: SESSION_ID },
      }),
    );
    for (const call of auditMock.mock.calls) {
      const arg = call[0] as { metadata?: Record<string, unknown> };
      expect(JSON.stringify(arg?.metadata ?? {})).not.toContain(SESSION_TOKEN_SECRET);
    }
  });

  it("an id that is not one of the target's sessions is 404 and nothing is revoked", async () => {
    authListSessions.mockResolvedValue([RAW_SESSION]);
    const res = await revoke("sess-of-someone-else");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(expect.objectContaining({ error: "session_not_found" }));
    expect(authRevokeSession).not.toHaveBeenCalled();
  });

  it("the OLD contract is closed: passing the token itself as the id no longer revokes", async () => {
    authListSessions.mockResolvedValue([RAW_SESSION]);
    const res = await revoke(SESSION_TOKEN_SECRET);
    expect(res.status).toBe(404);
    expect(authRevokeSession).not.toHaveBeenCalled();
  });

  it("a failed session lookup is a 502 with an audited failure, before any revoke", async () => {
    authListSessions.mockRejectedValue(new Error("auth down"));
    const res = await revoke(SESSION_ID);
    expect(res.status).toBe(502);
    expect(authRevokeSession).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.session_revoke_failed",
        outcome: "failure",
        reason: "auth_list_sessions_failed",
      }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Privilege ordering — target outranks actor (review #7)                     */
/* -------------------------------------------------------------------------- */

/**
 * Every account-level action on ANOTHER user must refuse a non-SUPERADMIN
 * actor whose target outranks them. The exploit this pins: dev-init's
 * `orgadmin@<org>` (all `admin.*`, no `superuser`) and `superuser@<org>` share
 * ONE org, so the target passes `canAccessUser` and the AUTHZ-2 shared-target
 * test — only the rank check stands between an org admin and "set the
 * superadmin's password, sign in with global authority".
 *
 * Three scenarios per route:
 *   - org admin  vs superadmin target → 403 `forbidden` + `admin.user.
 *     action_denied` (`denied`, reason `target_outranks_actor`), side effect
 *     NOT invoked;
 *   - superadmin vs anyone (here: a target who also holds superuser) → allowed;
 *   - org admin  vs plain member (subset of the actor's permissions) → allowed.
 */
interface GuardedRoute {
  name: string;
  perm: string;
  /** The Better Auth / mutation-core side effect that must not run on deny. */
  effect: () => ReturnType<typeof vi.fn>;
  /** DB row returned for the target lookup (restore needs `deactivated`). */
  row?: typeof targetRow;
  invoke: () => Promise<Response>;
}

// A session ID (what the route takes since review #67/#194) — never a token.
const SESSION_ID = "sess-id-abc";
const SESSION_TOKEN_SECRET = "sup3r-secret-session-token-AbCdEf";
/** A raw Better Auth row as `listUserSessions` returns it — token included. */
const RAW_SESSION = {
  id: SESSION_ID,
  token: SESSION_TOKEN_SECRET,
  userId: "ba-target",
  createdAt: new Date("2026-09-05T10:00:00.000Z"),
  updatedAt: new Date("2026-09-05T10:05:00.000Z"),
  expiresAt: new Date("2026-09-05T18:00:00.000Z"),
  ipAddress: "203.0.113.9",
  userAgent: "UA/1",
  impersonatedBy: null,
};

const guardedRoutes: GuardedRoute[] = [
  {
    name: "POST /users/[id]/password (mode=set)",
    perm: "admin.users.setPassword",
    effect: () => authSetPassword,
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
      return POST(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
          method: "POST",
          body: JSON.stringify({ mode: "set", password: "supersecret-pw-123" }),
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    // Rank-gated too: a reset email on an out-ranking target is the first hop
    // of a two-request chain (trigger reset → read the live link from the
    // email outbox with `admin.email.read` → set the password), and a
    // superadmin can self-serve a reset from the sign-in page.
    name: "POST /users/[id]/password (mode=reset_email)",
    perm: "admin.users.setPassword",
    effect: () => authForget,
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
      return POST(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
          method: "POST",
          body: JSON.stringify({ mode: "reset_email" }),
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "POST /users/[id]/ban",
    perm: "admin.users.ban",
    effect: () => authBan,
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/users/[id]/ban/route");
      return POST(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/ban`, {
          method: "POST",
          body: JSON.stringify({ reason: "spam" }),
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "POST /users/[id]/unban",
    perm: "admin.users.ban",
    effect: () => authUnban,
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/users/[id]/unban/route");
      return POST(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/unban`, {
          method: "POST",
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "DELETE /users/[id] (soft delete)",
    perm: "admin.users.delete",
    effect: () => authBan,
    invoke: async () => {
      const { DELETE } = await import("@/app/api/administrator/users/[id]/route");
      return DELETE(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}`, {
          method: "DELETE",
          body: JSON.stringify({ reason: "gone" }),
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "POST /users/[id]/restore",
    perm: "admin.users.delete",
    effect: () => authUnban,
    row: { ...targetRow, status: "deactivated" },
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/users/[id]/restore/route");
      return POST(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/restore`, {
          method: "POST",
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "POST /users/[id]/status",
    perm: "admin.users.manage",
    effect: () => statusChangeMock,
    invoke: async () => {
      const { POST } = await import("@/app/api/administrator/users/[id]/status/route");
      return POST(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/status`, {
          method: "POST",
          body: JSON.stringify({ action: "suspend", reason: "policy" }),
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "GET /users/[id]/sessions (list)",
    perm: "admin.users.sessions",
    effect: () => authListSessions,
    invoke: async () => {
      const { GET } = await import("@/app/api/administrator/users/[id]/sessions/route");
      return GET(makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/sessions`), {
        params: Promise.resolve({ id: TARGET_ID }),
      });
    },
  },
  {
    name: "DELETE /users/[id]/sessions (revoke all)",
    perm: "admin.users.sessions",
    effect: () => authRevokeSessions,
    invoke: async () => {
      const { DELETE } = await import("@/app/api/administrator/users/[id]/sessions/route");
      return DELETE(
        makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/sessions`, {
          method: "DELETE",
        }),
        { params: Promise.resolve({ id: TARGET_ID }) },
      );
    },
  },
  {
    name: "DELETE /users/[id]/sessions/[sessionId]",
    perm: "admin.users.sessions",
    effect: () => authRevokeSession,
    invoke: async () => {
      const { DELETE } =
        await import("@/app/api/administrator/users/[id]/sessions/[sessionId]/route");
      return DELETE(
        makeRequest(
          `http://test.local/api/administrator/users/${TARGET_ID}/sessions/${SESSION_ID}`,
          { method: "DELETE" },
        ),
        { params: Promise.resolve({ id: TARGET_ID, sessionId: SESSION_ID }) },
      );
    },
  },
];

const ACTOR_BA = "ba-1";
const withSuperuser = (perm: string) => ({
  ...grantedAccess(perm),
  permissions: [perm, "superuser"],
});

function armEffects() {
  authSetPassword.mockResolvedValue({ ok: true });
  authForget.mockResolvedValue({ ok: true });
  authBan.mockResolvedValue({ ok: true });
  authUnban.mockResolvedValue({ ok: true });
  // The single-session revoke resolves SESSION_ID → token through this list.
  authListSessions.mockResolvedValue([RAW_SESSION]);
  authRevokeSessions.mockResolvedValue({ ok: true });
  authRevokeSession.mockResolvedValue({ ok: true });
}

describe.each(guardedRoutes)("$name — target-outranks-actor guard (review #7)", (route) => {
  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_BA } });
    dbMock.mockResolvedValue(route.row ?? targetRow);
    armEffects();
  });

  it("org admin vs superadmin target → 403 forbidden + denied audit, no side effect", async () => {
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_BA ? grantedAccess(route.perm) : withSuperuser(route.perm),
    );
    const res = await route.invoke();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expect.objectContaining({ error: "forbidden" }));
    expect(route.effect()).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.action_denied",
        outcome: "denied",
        reason: "target_outranks_actor",
        actorBetterAuthUserId: ACTOR_BA,
        appUserId: TARGET_ID,
      }),
    );
    // The target is evaluated in the ACTOR's org (bound-org path — the
    // `{ organizationId }` argument), never via the request's active_org
    // cookie.
    expect(accessGetter).toHaveBeenCalledWith("ba-target", { organizationId: "o-1" });
  });

  it("F-09: org admin vs a superadmin whose grant is ASLEEP in a suspended org → 403, no side effect", async () => {
    // While the tenant holding the target's `superuser` grant is suspended, the
    // target resolves in the actor's org as a plain member — the subset test
    // alone would let this through, and reactivating the tenant would then
    // hand the actor (say, via a password they set) a platform superadmin.
    superuserGrantMock.mockResolvedValue(true);
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_BA
        ? { ...grantedAccess(route.perm), permissions: [route.perm, "shell.view"] }
        : { ...grantedAccess(route.perm), permissions: ["shell.view"] },
    );
    const res = await route.invoke();
    expect(res.status).toBe(403);
    expect(route.effect()).not.toHaveBeenCalled();
    expect(superuserGrantMock).toHaveBeenCalledWith(TARGET_ID);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.action_denied",
        reason: "target_outranks_actor",
      }),
    );
  });

  it("org admin vs a more-privileged peer (strict superset) → 403", async () => {
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_BA
        ? grantedAccess(route.perm)
        : { ...grantedAccess(route.perm), permissions: [route.perm, "admin.roles.update"] },
    );
    const res = await route.invoke();
    expect(res.status).toBe(403);
    expect(route.effect()).not.toHaveBeenCalled();
  });

  it("superadmin vs anyone (even another superadmin) → allowed", async () => {
    accessGetter.mockImplementation(() => withSuperuser(route.perm));
    const res = await route.invoke();
    expect(res.status).toBe(200);
    expect(route.effect()).toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.action_denied" }),
    );
  });

  it("org admin vs plain member (subset of the actor's permissions) → allowed", async () => {
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_BA
        ? { ...grantedAccess(route.perm), permissions: [route.perm, "shell.view"] }
        : { ...grantedAccess(route.perm), permissions: ["shell.view"] },
    );
    const res = await route.invoke();
    expect(res.status).toBe(200);
    expect(route.effect()).toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.action_denied" }),
    );
  });
});

describe("POST /users/[id]/password — rank guard precedes body parsing", () => {
  it("an out-ranking target is refused before the body is read (no 400 on a bad body)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_BA } });
    dbMock.mockResolvedValue(targetRow);
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_BA
        ? grantedAccess("admin.users.setPassword")
        : withSuperuser("admin.users.setPassword"),
    );
    const { POST } = await import("@/app/api/administrator/users/[id]/password/route");
    const request = makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/password`, {
      method: "POST",
      body: JSON.stringify({ mode: "bogus" }),
    });
    const jsonSpy = vi.spyOn(request, "json");
    const res = await POST(request, { params: Promise.resolve({ id: TARGET_ID }) });
    expect(res.status).toBe(403);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(authForget).not.toHaveBeenCalled();
    expect(authSetPassword).not.toHaveBeenCalled();
  });
});

/**
 * REVOKE-2 (review #444) — `POST /users/[id]/status` maps the shared core's
 * `last_superadmin` refusal onto 409, not the catch-all 404.
 *
 * The rank guard on this route keeps an org admin off a superadmin target, but
 * it exempts a SUPERADMIN actor outright, so `block` / `suspend` was the one
 * request that could still empty the platform's superadmin set — the same
 * unrecoverable state the four revocation routes refuse. The refusal itself and
 * its audit row live in `performAdminStatusChange` (admin-status-action.test.ts
 * covers them); what is pinned here is that the route does not swallow it.
 */
describe("POST /api/administrator/users/[id]/status — last superadmin (REVOKE-2)", () => {
  async function postStatus() {
    const { POST } = await import("@/app/api/administrator/users/[id]/status/route");
    return POST(
      makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/status`, {
        method: "POST",
        body: JSON.stringify({ action: "block" }),
      }),
      { params: Promise.resolve({ id: TARGET_ID }) },
    );
  }

  beforeEach(() => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    dbMock.mockResolvedValue(targetRow);
  });

  it("returns 409 last_superadmin when the core refuses", async () => {
    statusChangeMock.mockResolvedValue({ ok: false, error: "last_superadmin" });
    const res = await postStatus();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ error: "last_superadmin" }));
  });

  it("still returns 404 for a genuinely missing target", async () => {
    statusChangeMock.mockResolvedValue({ ok: false, error: "not_found" });
    const res = await postStatus();
    expect(res.status).toBe(404);
  });
});
