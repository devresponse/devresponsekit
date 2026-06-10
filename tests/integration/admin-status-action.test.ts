import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminStatusModule from "@/lib/admin-status.server";
import type * as AuthStatusModule from "@/lib/auth-status";
import type { NextRequest } from "next/server";

/**
 * Integration tests for the shared `applyAdminStatusAction` helper
 * (§29.6.11). The helper backs `/api/administrator/users/[id]/status`
 * and the bulk endpoint.
 *
 * Verifies the contract: callers without `admin.users.manage` are
 * denied AND audited with `denied`, valid transitions fire the right
 * audit event, and database writes happen inside a transaction.
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

const ADMIN_ACCESS = {
  appUserId: "admin-1",
  primaryEmail: "admin@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  permissions: ["admin.users.manage"],
};

const TARGET_ID = "11111111-1111-4111-8111-111111111199";

let applyAdminStatusAction: typeof AdminStatusModule.applyAdminStatusAction;

beforeEach(async () => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  trxRun.mockReset();
  userExecuteTakeFirst.mockReset();
  ({ applyAdminStatusAction } = await import("@/lib/admin-status.server"));
});
afterEach(() => vi.resetModules());

function approveInput(body: unknown) {
  return {
    request: makeRequest(body),
    newStatus: "active" as const,
    newMembershipStatus: "active" as const,
    eventOverride: "admin.user.approved",
  };
}

describe("applyAdminStatusAction (approve)", () => {
  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await applyAdminStatusAction(approveInput({ appUserId: TARGET_ID }));
    expect(res.status).toBe(401);
  });

  it("returns 403 and audits a denied attempt for non-admins", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      ...ADMIN_ACCESS,
      permissions: ["shell.view"], // no admin.users.manage
    });
    const res = await applyAdminStatusAction(approveInput({ appUserId: TARGET_ID }));
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        reason: "missing_admin_permission",
      }),
    );
  });

  it("returns 400 for invalid bodies", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ADMIN_ACCESS);
    const res = await applyAdminStatusAction(approveInput({ appUserId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when target user does not exist", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ADMIN_ACCESS);
    userExecuteTakeFirst.mockResolvedValue(undefined);
    const res = await applyAdminStatusAction(approveInput({ appUserId: TARGET_ID }));
    expect(res.status).toBe(404);
  });

  it("approves a target user and emits the admin.user.approved audit event", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ADMIN_ACCESS);
    userExecuteTakeFirst.mockResolvedValue({
      id: TARGET_ID,
      primary_email: "target@x.com",
    });
    trxRun.mockResolvedValue(undefined);

    const res = await applyAdminStatusAction(
      approveInput({ appUserId: TARGET_ID, reason: "Verified onboarding ticket" }),
    );
    expect(res.status).toBe(200);
    expect(trxRun).toHaveBeenCalledTimes(2); // app_users + memberships
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.approved",
        outcome: "success",
        appUserId: TARGET_ID,
        email: "target@x.com",
        reason: "Verified onboarding ticket",
      }),
    );
  });
});

describe.each([
  {
    action: "block",
    newStatus: "blocked" as const,
    newMembershipStatus: "blocked" as const,
    event: "admin.user.blocked",
  },
  {
    action: "suspend",
    newStatus: "suspended" as const,
    newMembershipStatus: "suspended" as const,
    event: "admin.user.suspended",
  },
  {
    action: "reactivate",
    newStatus: "active" as const,
    newMembershipStatus: "active" as const,
    event: "admin.user.reactivated",
  },
])("applyAdminStatusAction ($action)", ({ newStatus, newMembershipStatus, event }) => {
  it(`audits ${event} on success`, async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-admin" } });
    accessGetter.mockResolvedValue(ADMIN_ACCESS);
    userExecuteTakeFirst.mockResolvedValue({ id: TARGET_ID, primary_email: "target@x.com" });
    trxRun.mockResolvedValue(undefined);

    const res = await applyAdminStatusAction({
      request: makeRequest({ appUserId: TARGET_ID }),
      newStatus,
      newMembershipStatus,
      eventOverride: event,
    });
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: event, outcome: "success" }),
    );
  });
});
