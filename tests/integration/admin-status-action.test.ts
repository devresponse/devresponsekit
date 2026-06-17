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
const trxRun = vi.fn(); // counts UPDATE executes inside the transaction
const userExecuteTakeFirst = vi.fn(); // app_users target lookup
const sharedExecuteTakeFirst = vi.fn(); // app_organization_memberships "outside org" probe (AUTHZ-1)

vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

function tableKey(t: unknown): string {
  return String(t).split(" ")[0] ?? "";
}
function selectChain(table: string): unknown {
  // app_organization_memberships → the userHasMembershipOutsideOrg probe;
  // everything else → the app_users target lookup. A generic proxy handles
  // any chain length (.select().where().where().limit().executeTakeFirst()).
  const takeFirst =
    table === "app_organization_memberships" ? sharedExecuteTakeFirst : userExecuteTakeFirst;
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return takeFirst;
        return () => proxy;
      },
    },
  );
  return proxy;
}
const dbStub = {
  selectFrom: (t: unknown) => selectChain(tableKey(t)),
  transaction: () => ({
    execute: (fn: (trx: unknown) => unknown) =>
      fn({
        updateTable: () => {
          // Any-length .set().where()....execute() routes to trxRun.
          const p: unknown = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === "execute") return trxRun;
                return () => p;
              },
            },
          );
          return p;
        },
      }),
  }),
};
vi.mock("@/db/database", () => ({ db: dbStub }));

const TARGET_ID = "11111111-1111-4111-8111-111111111199";
const ACTOR_ID = "ba-admin";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALL = { kind: "all" } as const;

let performAdminStatusChange: typeof AdminStatusModule.performAdminStatusChange;

beforeEach(async () => {
  auditMock.mockReset();
  trxRun.mockReset();
  trxRun.mockResolvedValue(undefined);
  userExecuteTakeFirst.mockReset();
  sharedExecuteTakeFirst.mockReset();
  sharedExecuteTakeFirst.mockResolvedValue(undefined); // not shared by default
  ({ performAdminStatusChange } = await import("@/lib/admin-status.server"));
});
afterEach(() => vi.resetModules());

describe("performAdminStatusChange (approve)", () => {
  it("reports not_found when the target user does not exist", async () => {
    userExecuteTakeFirst.mockResolvedValue(undefined);
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
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
      scope: ALL,
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
      scope: ALL,
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

describe("performAdminStatusChange — org scoping (AUTHZ-1)", () => {
  const ORG_SCOPE = { kind: "org", organizationId: ORG_A } as const;

  beforeEach(() => {
    userExecuteTakeFirst.mockResolvedValue({ id: TARGET_ID, primary_email: "target@x.com" });
  });

  it("block of a SHARED user touches ONLY the membership, not the account-global status", async () => {
    sharedExecuteTakeFirst.mockResolvedValue({ id: "m-other-org" }); // shared with another org
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ORG_SCOPE,
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
    });
    expect(result).toEqual({ ok: true, status: "blocked" });
    // Only the membership UPDATE runs — the account-global status is left alone.
    expect(trxRun).toHaveBeenCalledTimes(1);
  });

  it("block of a SINGLE-ORG user updates both account status and membership (unchanged behavior)", async () => {
    sharedExecuteTakeFirst.mockResolvedValue(undefined); // no membership outside the actor's org
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ORG_SCOPE,
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
    });
    expect(result).toEqual({ ok: true, status: "blocked" });
    expect(trxRun).toHaveBeenCalledTimes(2); // app_users + membership
  });

  it("approve of a SHARED user lifts the (pending) account AND activates the membership", async () => {
    sharedExecuteTakeFirst.mockResolvedValue({ id: "m-other-org" });
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ORG_SCOPE,
      targetAppUserId: TARGET_ID,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.approved",
    });
    expect(result).toEqual({ ok: true, status: "active" });
    // Grant lifts a pending account to active (conditional UPDATE) + membership.
    expect(trxRun).toHaveBeenCalledTimes(2);
  });
});
