import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";
import type { NextRequest } from "next/server";
import { POST as blockPost } from "@/app/api/admin/users/block/route";
import { POST as suspendPost } from "@/app/api/admin/users/suspend/route";
import { POST as reactivatePost } from "@/app/api/admin/users/reactivate/route";

/**
 * Smoke tests for the sibling admin endpoints that delegate to the
 * shared `applyAdminStatusAction` helper:
 *   - POST /api/admin/users/block
 *   - POST /api/admin/users/suspend
 *   - POST /api/admin/users/reactivate
 *
 * The shared helper is unit-tested via the approve route; here we only
 * assert the wiring (audit event name + status code on success). DB
 * writes are mocked.
 */

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const trxRun = vi.fn().mockResolvedValue(undefined);
const userTakeFirst = vi.fn();

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
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirst: userTakeFirst }),
      }),
    }),
    transaction: () => ({
      execute: (fn: (trx: unknown) => unknown) =>
        fn({
          updateTable: () => ({
            set: () => ({ where: () => ({ execute: trxRun }) }),
          }),
        }),
    }),
  },
}));

function makeRequest(body: unknown): NextRequest {
  return { json: async () => body, headers: new Headers() } as unknown as NextRequest;
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

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  userTakeFirst.mockReset();
});
afterEach(() => vi.resetModules());

describe.each([
  { route: "block", post: blockPost, event: "admin.user.blocked" },
  { route: "suspend", post: suspendPost, event: "admin.user.suspended" },
  { route: "reactivate", post: reactivatePost, event: "admin.user.reactivated" },
])("POST /api/admin/users/$route", ({ post, event }) => {
  it(`audits ${event} on success`, async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-admin" } });
    accessGetter.mockResolvedValue(ADMIN_ACCESS);
    userTakeFirst.mockResolvedValue({ id: TARGET_ID, primary_email: "target@x.com" });
    const res = await post(makeRequest({ appUserId: TARGET_ID }));
    expect(res.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: event, outcome: "success" }),
    );
  });
});
