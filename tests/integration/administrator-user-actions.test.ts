import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Integration tests for the Phase 3 user-mutation endpoints under
 * `/api/administrator/users/[id]/*` (docs/admin-manager.md §5.2 + §17).
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

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return {
    ...actual,
    requiresSuperadminForSharedTarget: (...a: unknown[]) => requiresSuperadminMock(...a),
  };
});
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
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

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => makeChain(),
    updateTable: () => makeChain(),
    insertInto: () => makeChain(),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({
          updateTable: () => makeChain(),
          insertInto: () => makeChain(),
        }),
    }),
  },
}));

// Likewise stub the shared status-mutation core used by the /status
// route (it is exercised end-to-end by admin-status-action.test.ts).
vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: vi.fn(async () => ({ ok: true, status: "active" })),
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
    expect(authBan).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "ba-target",
        banReason: "spam",
      }),
      expect.anything(),
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
    // the app-side update fails).
    expect(authBan).toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.soft_deleted",
        outcome: "success",
        reason: "spam-account",
      }),
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

describe("DELETE /api/administrator/users/[id]/sessions/[sessionId]", () => {
  it("does not log the raw session token in audit metadata", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.sessions"));
    dbMock.mockResolvedValue(targetRow);
    authRevokeSession.mockResolvedValue({ ok: true });
    const { DELETE } =
      await import("@/app/api/administrator/users/[id]/sessions/[sessionId]/route");
    const sessionToken = "sup3r-secret-session-token-AbCdEf";
    const res = await DELETE(
      makeRequest(
        `http://test.local/api/administrator/users/${TARGET_ID}/sessions/${sessionToken}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: TARGET_ID, sessionId: sessionToken }) },
    );
    expect(res.status).toBe(200);
    // The contract is: the session token must not appear in the
    // `metadata` field (the only field `auditEvent` persists as JSON
    // in `app_audit_events.metadata`). The `request` field is consumed
    // by `auditEvent` to extract IP / user-agent and never serialized
    // verbatim into the audit row, so we scope the assertion to
    // `metadata` to match what actually hits the database.
    for (const call of auditMock.mock.calls) {
      const arg = call[0] as { metadata?: Record<string, unknown> };
      const metaBlob = JSON.stringify(arg?.metadata ?? {});
      expect(metaBlob).not.toContain(sessionToken);
    }
  });
});
