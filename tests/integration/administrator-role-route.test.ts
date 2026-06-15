import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * Route-integration tests for `POST /api/administrator/users/[id]/role`,
 * the Better Auth platform-role grant (`user` / `admin`).
 *
 * This route is security-critical: the Better Auth `admin` role reaches the
 * un-scoped `/api/auth/admin/*` plugin surface (list / ban / impersonate /
 * set-password across ALL organizations), bypassing the application
 * permission catalog and ADR-0001 org scoping. So the route is gated on
 * **SUPERADMIN**, not merely on the `admin.users.setRole` permission — an
 * org admin holding that permission must NOT be able to mint a platform
 * admin (cross-tenant privilege escalation). These tests pin that gate plus
 * the standard handler contract (auth, validation, target resolution,
 * audit). The Better Auth + DB layers are stubbed — this exercises the
 * route shape, not the query plan.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const dbMock = vi.fn();
const authSetRole = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
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
  setBetterAuthUserRole: (...a: unknown[]) => authSetRole(...a),
}));

function makeChain(): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === "executeTakeFirst") return dbMock;
      if (prop === "executeTakeFirstOrThrow") return dbMock;
      if (prop === "execute") return () => Promise.resolve([]);
      if (prop === "returning") return () => makeChain();
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
  },
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

/** Build an access context holding exactly `permissions`. */
const accessWith = (permissions: string[]) => ({
  appUserId: "u-self",
  primaryEmail: "admin@x.com",
  status: "active",
  organizationId: "o-1",
  membershipStatus: "active",
  preferredLocale: "en",
  permissions,
});

const targetRow = {
  id: TARGET_ID,
  better_auth_user_id: "ba-target",
  primary_email: "target@example.com",
  display_name: "Target",
  status: "active",
};

function roleRequest(body: unknown) {
  return makeRequest(`http://test.local/api/administrator/users/${TARGET_ID}/role`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ id: TARGET_ID }) };

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  dbMock.mockReset();
  authSetRole.mockReset();
});
afterEach(() => vi.resetModules());

describe("POST /api/administrator/users/[id]/role", () => {
  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { POST } = await import("@/app/api/administrator/users/[id]/role/route");
    const res = await POST(roleRequest({ role: "admin" }), params);
    expect(res.status).toBe(401);
    expect(authSetRole).not.toHaveBeenCalled();
  });

  it("returns 403 + denied audit when the caller lacks admin.users.setRole", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(accessWith(["admin.users.read"]));
    const { POST } = await import("@/app/api/administrator/users/[id]/role/route");
    const res = await POST(roleRequest({ role: "admin" }), params);
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
    expect(authSetRole).not.toHaveBeenCalled();
  });

  // sec-1: the core regression. An org admin holding admin.users.setRole but
  // NOT superuser must be blocked — otherwise they could grant the Better
  // Auth `admin` role and escape ADR-0001 tenant scoping via /api/auth/admin/*.
  it("returns 403 for a NON-superadmin holding admin.users.setRole (no platform-role minting)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(accessWith(["admin.users.setRole"]));
    const { POST } = await import("@/app/api/administrator/users/[id]/role/route");
    const res = await POST(roleRequest({ role: "admin" }), params);
    expect(res.status).toBe(403);
    // The role was never set, and the target was never even resolved.
    expect(authSetRole).not.toHaveBeenCalled();
    expect(dbMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid id with 400 (superadmin)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(accessWith(["admin.users.setRole", "superuser"]));
    const { POST } = await import("@/app/api/administrator/users/[id]/role/route");
    const res = await POST(
      makeRequest("http://test.local/api/administrator/users/not-a-uuid/role", {
        method: "POST",
        body: JSON.stringify({ role: "admin" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );
    expect(res.status).toBe(400);
    expect(authSetRole).not.toHaveBeenCalled();
  });

  it("returns 404 when the target user does not exist (superadmin)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(accessWith(["admin.users.setRole", "superuser"]));
    dbMock.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/administrator/users/[id]/role/route");
    const res = await POST(roleRequest({ role: "admin" }), params);
    expect(res.status).toBe(404);
    expect(authSetRole).not.toHaveBeenCalled();
  });

  it("sets the role + audits success for a superadmin", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(accessWith(["admin.users.setRole", "superuser"]));
    dbMock.mockResolvedValue(targetRow);
    authSetRole.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/administrator/users/[id]/role/route");
    const res = await POST(roleRequest({ role: "admin", reason: "platform onboarding" }), params);
    expect(res.status).toBe(200);
    expect(authSetRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "ba-target", role: "admin" }),
      expect.anything(),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.role_set",
        outcome: "success",
        appUserId: TARGET_ID,
      }),
    );
  });
});
