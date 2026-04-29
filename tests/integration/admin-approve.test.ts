import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ApproveRouteModule from "@/app/api/admin/users/approve/route";
import type * as AuthStatusModule from "@/lib/auth-status";
import type { NextRequest } from "next/server";

/**
 * Route integration tests for `/api/admin/users/approve` (§29.6.11).
 *
 * Verifies the shared `applyAdminStatusAction` contract: callers without
 * `admin.users.manage` are denied AND audited with `denied`, valid
 * approvals fire the `admin.user.approved` event, and database writes
 * happen inside a transaction.
 */

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const trxRun = vi.fn();
const userExecuteTakeFirst = vi.fn();

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

const dbStub = {
  selectFrom: () => ({
    select: () => ({
      where: () => ({ executeTakeFirst: userExecuteTakeFirst }),
    }),
  }),
  transaction: () => ({
    execute: (fn: (trx: unknown) => unknown) =>
      fn({
        updateTable: () => ({
          set: () => ({
            where: () => ({ execute: trxRun }),
          }),
        }),
      }),
  }),
};
vi.mock("@/db/database", () => ({ db: dbStub }));

function makeRequest(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers(),
  } as unknown as NextRequest;
}

let POST: typeof ApproveRouteModule.POST;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  trxRun.mockReset();
  userExecuteTakeFirst.mockReset();
  ({ POST } = await import("@/app/api/admin/users/approve/route"));
});
afterEach(() => vi.resetModules());

describe("POST /api/admin/users/approve", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await POST(makeRequest({ appUserId: "11111111-1111-4111-8111-111111111101" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 and audits a denied attempt for non-admins", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["shell.view"], // no admin.users.manage
    });
    const res = await POST(makeRequest({ appUserId: "11111111-1111-4111-8111-111111111101" }));
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "navigation.menu.denied",
        outcome: "denied",
        reason: "missing_admin_permission",
      }),
    );
  });

  it("returns 400 for invalid bodies", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.manage"],
    });
    const res = await POST(makeRequest({ appUserId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when target user does not exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "u@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.manage"],
    });
    userExecuteTakeFirst.mockResolvedValue(undefined);
    const res = await POST(makeRequest({ appUserId: "11111111-1111-4111-8111-111111111101" }));
    expect(res.status).toBe(404);
  });

  it("approves a target user and emits the admin.user.approved audit event", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.manage"],
    });
    userExecuteTakeFirst.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111199",
      primary_email: "target@x.com",
    });
    trxRun.mockResolvedValue(undefined);

    const res = await POST(
      makeRequest({
        appUserId: "11111111-1111-4111-8111-111111111199",
        reason: "Verified onboarding ticket",
      }),
    );
    expect(res.status).toBe(200);
    expect(trxRun).toHaveBeenCalledTimes(2); // app_users + memberships
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.approved",
        outcome: "success",
        appUserId: "11111111-1111-4111-8111-111111111199",
        email: "target@x.com",
        reason: "Verified onboarding ticket",
      }),
    );
  });
});
