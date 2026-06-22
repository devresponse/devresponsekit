import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as RateLimitModule from "@/lib/admin/rate-limit.server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Integration tests for the Phase 7 endpoints
 * (docs/admin-manager.md §19 Phase 7):
 *
 *   - POST/DELETE /api/administrator/users/[id]/impersonate
 *   - POST        /api/administrator/users/bulk
 *   - GET         /api/administrator/export/[resource]
 *
 * These pin the cross-cutting handler contract — permission gate,
 * rate-limit guard, audit row written on success — using the same
 * mock surface as the existing `administrator-user-actions.test.ts`.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const dbMock = vi.fn();
const authImpersonate = vi.fn();
const authStopImpersonate = vi.fn();
const authBan = vi.fn();
const authUnban = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
  // Lightweight stand-in for the real helper (which lives in the heavy
  // auth-guard module): reads `session.session.impersonatedBy`.
  getImpersonatorId: (
    s: { session?: { impersonatedBy?: string | null; impersonated_by?: string | null } } | null,
  ) => s?.session?.impersonatedBy ?? s?.session?.impersonated_by ?? null,
}));
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
vi.mock("@/lib/admin/auth-admin.server", () => ({
  impersonateBetterAuthUser: (...a: unknown[]) => authImpersonate(...a),
  stopBetterAuthImpersonating: (...a: unknown[]) => authStopImpersonate(...a),
  banBetterAuthUser: (...a: unknown[]) => authBan(...a),
  unbanBetterAuthUser: (...a: unknown[]) => authUnban(...a),
  setBetterAuthUserPassword: vi.fn(),
  sendBetterAuthPasswordResetEmail: vi.fn(),
  setBetterAuthUserRole: vi.fn(),
  listBetterAuthUserSessions: vi.fn(),
  revokeBetterAuthUserSession: vi.fn(),
  revokeAllBetterAuthUserSessions: vi.fn(),
  createBetterAuthUser: vi.fn(),
  updateBetterAuthUser: vi.fn(),
}));
vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: vi.fn(async () => ({ ok: true, status: "active" })),
}));

// ---- DB stubbing (matches the pattern used by administrator-user-actions). --
function makeChain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "executeTakeFirst") return dbMock;
      if (prop === "executeTakeFirstOrThrow") return dbMock;
      if (prop === "execute") return () => Promise.resolve(dbExecuteResult);
      return (..._args: unknown[]) => makeChain();
    },
  };
  return new Proxy({}, handler);
}
let dbExecuteResult: unknown[] = [];

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => makeChain(),
    updateTable: () => makeChain(),
    insertInto: () => makeChain(),
    transaction: () => ({
      execute: async (cb: (trx: unknown) => Promise<unknown>) =>
        cb({ updateTable: () => makeChain(), insertInto: () => makeChain() }),
    }),
  },
}));

vi.mock("@/lib/admin/rate-limit.server", async () => {
  const actual = await vi.importActual<typeof RateLimitModule>("@/lib/admin/rate-limit.server");
  return actual;
});

const TARGET_ID = "11111111-1111-4111-8111-111111111101";
const ACTOR_ID = "22222222-2222-4222-8222-222222222202";

const targetRow = {
  id: TARGET_ID,
  better_auth_user_id: "ba-target",
  primary_email: "target@example.com",
  display_name: "Target",
  status: "active",
};

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

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  dbMock.mockReset();
  authImpersonate.mockReset();
  authStopImpersonate.mockReset();
  authBan.mockReset();
  authUnban.mockReset();
  dbExecuteResult = [];
  const rl = await import("@/lib/admin/rate-limit.server");
  rl.__resetRateLimitForTests();
});
afterEach(() => vi.resetModules());

/* -------------------------------------------------------------------------- */
/*  Impersonation                                                             */
/* -------------------------------------------------------------------------- */

describe("POST /api/administrator/users/[id]/impersonate", () => {
  const importRoute = () => import("@/app/api/administrator/users/[id]/impersonate/route");
  const url = `http://test.local/api/administrator/users/${TARGET_ID}/impersonate`;

  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 + denied audit when caller lacks admin.users.impersonate", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects self-impersonation with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-target" } }); // same as targetRow
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("cannot_impersonate_self");
    expect(authImpersonate).not.toHaveBeenCalled();
  });

  it("starts impersonation and audits success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockResolvedValue({ user: { id: "ba-target" } });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    expect(authImpersonate).toHaveBeenCalledWith("ba-target", expect.anything());
    // The impersonated-session cookies are delivered by Better Auth's
    // nextCookies plugin during the impersonateUser call, NOT forwarded by the
    // route — so the route returns a plain ok body (P3-1: the old manual
    // Set-Cookie loop was dead, since the helper omits returnHeaders).
    expect(await res.json()).toEqual({ ok: true });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_started",
        outcome: "success",
      }),
    );
  });

  it("audits failure and returns 502 when Better Auth throws", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.impersonate"));
    dbMock.mockResolvedValue(targetRow);
    authImpersonate.mockRejectedValue(new Error("boom"));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(502);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        outcome: "failure",
      }),
    );
  });

  // test-2: the privilege-escalation guard. Impersonation grants the actor
  // the target's session, so a NON-superadmin must not assume a session that
  // carries a permission they themselves lack (e.g. an org admin assuming a
  // SUPERADMIN). The attempt must be rejected 403 and audited.
  it("blocks a non-superadmin from impersonating a more-privileged target (403 + audit)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    // Actor (ACTOR_ID) holds impersonate but NOT superuser; the target
    // (ba-target) additionally holds superuser — a permission the actor lacks.
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_ID
        ? grantedAccess("admin.users.impersonate")
        : {
            ...grantedAccess("admin.users.impersonate"),
            permissions: ["admin.users.impersonate", "superuser"],
          },
    );
    dbMock.mockResolvedValue(targetRow);
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(403);
    expect(authImpersonate).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_failed",
        outcome: "failure",
        reason: "privilege_escalation",
      }),
    );
  });

  // Inverse: a non-superadmin actor whose permissions are a strict superset
  // of the target's is NOT escalating, so impersonation proceeds.
  it("allows a non-superadmin to impersonate a less-privileged (subset) target", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockImplementation((id: string) =>
      id === ACTOR_ID
        ? {
            ...grantedAccess("admin.users.impersonate"),
            permissions: ["admin.users.impersonate", "admin.users.read"],
          }
        : { ...grantedAccess("admin.users.read"), permissions: ["admin.users.read"] },
    );
    dbMock.mockResolvedValue(targetRow);
    const cookieHeaders = new Headers();
    cookieHeaders.append("set-cookie", "ba.session=imp; Path=/; HttpOnly");
    authImpersonate.mockResolvedValue({ headers: cookieHeaders });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(url, { method: "POST" }), {
      params: Promise.resolve({ id: TARGET_ID }),
    });
    expect(res.status).toBe(200);
    expect(authImpersonate).toHaveBeenCalledWith("ba-target", expect.anything());
  });
});

describe("DELETE /api/administrator/users/[id]/impersonate", () => {
  const importRoute = () => import("@/app/api/administrator/users/[id]/impersonate/route");
  const url = `http://test.local/api/administrator/users/${TARGET_ID}/impersonate`;

  // Regression: while impersonating, the live session IS the target — usually
  // a plain member with NO admin permission. Stop must NOT gate on the
  // impersonated identity's permissions (that 403'd the admin and stranded
  // them in the impersonated view). Authority comes from the session carrying
  // `impersonatedBy`, and the action is audited against the ORIGINAL admin.
  it("stops impersonation for a non-admin impersonated session, audited against the original actor", async () => {
    sessionGetter.mockResolvedValue({
      user: { id: "ba-target" }, // the impersonated member — no admin perms
      session: { impersonatedBy: ACTOR_ID }, // stamped by Better Auth at start
    });
    dbMock.mockResolvedValue(targetRow);
    authStopImpersonate.mockResolvedValue({ headers: new Headers() });
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(authStopImpersonate).toHaveBeenCalled();
    // Stop never consults the impersonated user's permissions.
    expect(accessGetter).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.impersonation_stopped",
        outcome: "success",
        actorBetterAuthUserId: ACTOR_ID,
      }),
    );
  });

  it("returns 400 not_impersonating when the session is not an impersonation session", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } }); // no impersonatedBy
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_impersonating");
    expect(authStopImpersonate).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { DELETE } = await importRoute();
    const res = await DELETE(makeRequest(url, { method: "DELETE" }));
    expect(res.status).toBe(401);
    expect(authStopImpersonate).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  Bulk                                                                       */
/* -------------------------------------------------------------------------- */

describe("POST /api/administrator/users/bulk", () => {
  const importRoute = () => import("@/app/api/administrator/users/bulk/route");
  const url = "http://test.local/api/administrator/users/bulk";

  it("returns 400 on missing/invalid body", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, { method: "POST", body: JSON.stringify({ action: "approve" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller lacks the action's permission", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "ban", ids: [TARGET_ID], reason: "spam" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects ids='*' without filters with 400", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.delete"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "soft_delete", ids: "*" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("filters_required_for_select_all");
  });

  it("returns ok with empty result when no matching ids exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    // dbExecuteResult stays empty so the in-list lookup returns no rows.
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "approve", ids: [TARGET_ID] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempted).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toBe("not_found");
  });

  // bug-8: duplicate ids in the payload must be processed once. Zod's
  // .min/.max only bound element count, not uniqueness, so without dedup a
  // repeated id would double-count attempts (and double-audit / re-apply).
  it("deduplicates repeated ids — three copies of one id collapse to a single attempt", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.manage"));
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest(url, {
        method: "POST",
        body: JSON.stringify({ action: "approve", ids: [TARGET_ID, TARGET_ID, TARGET_ID] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempted).toBe(1);
    expect(body.results).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

describe("GET /api/administrator/export/[resource]", () => {
  const importRoute = () => import("@/app/api/administrator/export/[resource]/route");

  it("returns 404 for an unknown resource", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    const { GET } = await importRoute();
    const res = await GET(makeRequest("http://test.local/api/administrator/export/nope"), {
      params: Promise.resolve({ resource: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller lacks the resource's read permission", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.audit.read"));
    const { GET } = await importRoute();
    const res = await GET(makeRequest("http://test.local/api/administrator/export/users"), {
      params: Promise.resolve({ resource: "users" }),
    });
    expect(res.status).toBe(403);
  });

  it("streams CSV with correct headers when permitted", async () => {
    sessionGetter.mockResolvedValue({ user: { id: ACTOR_ID } });
    accessGetter.mockResolvedValue(grantedAccess("admin.users.read"));
    // Empty execute result — we just want the header row + closure.
    const { GET } = await importRoute();
    const res = await GET(makeRequest("http://test.local/api/administrator/export/users"), {
      params: Promise.resolve({ resource: "users" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    // Header row should be the first non-empty line.
    const firstLine = text.split("\n")[0];
    expect(firstLine).toBe(
      "id,better_auth_user_id,primary_email,display_name,status,preferred_locale,created_at,updated_at",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  CSV escape                                                                 */
/* -------------------------------------------------------------------------- */

describe("csvEscape", () => {
  it("quotes values containing commas, quotes, or newlines", async () => {
    const { csvEscape } = await import("@/app/api/administrator/export/[resource]/route");
    expect(csvEscape("simple")).toBe("simple");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(42)).toBe("42");
  });
});
