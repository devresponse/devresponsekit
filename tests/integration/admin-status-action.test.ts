import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AdminStatusModule from "@/lib/admin-status.server";

/**
 * Integration tests for the shared `performAdminStatusChange` core
 * (§29.6.11). The core backs `/api/administrator/users/[id]/status`
 * and the bulk endpoint; authorization (401/403 + denied audit) is
 * owned by `requireAdminPermission` at the route layer and covered by
 * its own tests.
 *
 * Verifies: missing targets are reported, valid transitions fire the
 * right audit event, and database writes happen inside a transaction.
 */

const auditMock = vi.fn();
const trxRun = vi.fn();
const userExecuteTakeFirst = vi.fn();

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

const TARGET_ID = "11111111-1111-4111-8111-111111111199";
const ACTOR_ID = "ba-admin";

let performAdminStatusChange: typeof AdminStatusModule.performAdminStatusChange;

beforeEach(async () => {
  auditMock.mockReset();
  trxRun.mockReset();
  userExecuteTakeFirst.mockReset();
  ({ performAdminStatusChange } = await import("@/lib/admin-status.server"));
});
afterEach(() => vi.resetModules());

describe("performAdminStatusChange (approve)", () => {
  it("reports not_found when the target user does not exist", async () => {
    userExecuteTakeFirst.mockResolvedValue(undefined);
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      targetAppUserId: TARGET_ID,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.approved",
    });
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(trxRun).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("approves a target user and emits the admin.user.approved audit event", async () => {
    userExecuteTakeFirst.mockResolvedValue({
      id: TARGET_ID,
      primary_email: "target@x.com",
    });
    trxRun.mockResolvedValue(undefined);

    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      targetAppUserId: TARGET_ID,
      reason: "Verified onboarding ticket",
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.approved",
    });
    expect(result).toEqual({ ok: true, status: "active" });
    expect(trxRun).toHaveBeenCalledTimes(2); // app_users + memberships
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.approved",
        outcome: "success",
        actorBetterAuthUserId: ACTOR_ID,
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
])("performAdminStatusChange ($action)", ({ newStatus, newMembershipStatus, event }) => {
  it(`audits ${event} on success`, async () => {
    userExecuteTakeFirst.mockResolvedValue({ id: TARGET_ID, primary_email: "target@x.com" });
    trxRun.mockResolvedValue(undefined);

    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      targetAppUserId: TARGET_ID,
      newStatus,
      newMembershipStatus,
      eventType: event,
    });
    expect(result).toEqual({ ok: true, status: newStatus });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: event, outcome: "success" }),
    );
  });
});
