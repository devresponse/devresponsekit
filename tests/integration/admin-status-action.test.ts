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
/**
 * REVOKE-2 (review #444). The core now runs the last-superadmin predicate
 * inside its own transaction before writing, which issues two SELECTs there:
 * the target's affected memberships, then the platform's surviving superuser
 * grants. These stubs feed both. The default `[]` grants exercise the
 * documented escape hatch — a platform with no direct-assignment superuser has
 * nothing to protect — so every pre-existing case below is unaffected.
 */
const trxMembershipRows = vi.fn(); // app_organization_memberships rows in the trx
const trxGrantRows = vi.fn(); // activeGlobalSuperuserGrants rows in the trx

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
function trxSelectChain(table: string): unknown {
  // Any-length .select().innerJoin().where()....forUpdate().execute().
  const rows = table === "app_user_roles" ? trxGrantRows : trxMembershipRows;
  const p: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "execute") return rows;
        return (...args: unknown[]) => {
          // innerJoin(cb) — exercise the join callback harmlessly.
          const cb = args[1];
          if (typeof cb === "function") {
            try {
              (cb as (x: unknown) => unknown)(trxSelectChain(table));
            } catch {
              /* join stub */
            }
          }
          return p;
        };
      },
    },
  );
  return p;
}
const dbStub = {
  selectFrom: (t: unknown) => selectChain(tableKey(t)),
  transaction: () => ({
    execute: (fn: (trx: unknown) => unknown) =>
      fn({
        selectFrom: (t: unknown) => trxSelectChain(tableKey(t)),
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
  trxMembershipRows.mockReset();
  trxMembershipRows.mockResolvedValue([{ organization_id: ORG_A }]);
  trxGrantRows.mockReset();
  trxGrantRows.mockResolvedValue([]); // no superuser grant to protect by default
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

/**
 * REVOKE-2 (review #444) — the last-superadmin invariant lives in this shared
 * core, not in the three routes above it (`POST …/users/[id]/status`, its
 * `/api/v1` twin, and the `block`/`suspend` bulk actions), because an invariant
 * enforced per-route is one the next route forgets. The rank guard those routes
 * carry keeps an ORG ADMIN off a superadmin target, but `targetOutranksActor`
 * exempts a SUPERADMIN actor outright — so this is the only thing between
 * "block a co-superadmin" and "leave the platform with nobody able to
 * administer it", including when the actor blocks themselves.
 */
describe("performAdminStatusChange — last superadmin (REVOKE-2)", () => {
  const ROLE = "44444444-4444-4444-8444-444444444444";
  beforeEach(() => {
    userExecuteTakeFirst.mockResolvedValue({ id: TARGET_ID, primary_email: "target@x.com" });
    // The target's membership in ORG_A is the platform's ONLY superuser grant.
    trxGrantRows.mockResolvedValue([
      { app_user_id: TARGET_ID, organization_id: ORG_A, role_id: ROLE },
    ]);
  });

  it.each(["blocked", "suspended"] as const)(
    "refuses a %s transition that would strip the only remaining grant",
    async (newMembershipStatus) => {
      const result = await performAdminStatusChange({
        actorBetterAuthUserId: ACTOR_ID,
        scope: ALL,
        targetAppUserId: TARGET_ID,
        newStatus: newMembershipStatus,
        newMembershipStatus,
        eventType: "admin.user.blocked",
      });
      expect(result).toEqual({ ok: false, error: "last_superadmin" });
      // Nothing was written: the refusal happens before both UPDATEs.
      expect(trxRun).not.toHaveBeenCalled();
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "admin.superuser.revocation_denied",
          outcome: "denied",
          reason: "last_global_superuser",
          appUserId: TARGET_ID,
        }),
      );
      // The success audit must NOT fire.
      expect(auditMock).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    },
  );

  it("allows the block when ANOTHER user still holds a grant", async () => {
    trxGrantRows.mockResolvedValue([
      { app_user_id: TARGET_ID, organization_id: ORG_A, role_id: ROLE },
      { app_user_id: "other-superadmin", organization_id: ORG_A, role_id: ROLE },
    ]);
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
    });
    expect(result).toEqual({ ok: true, status: "blocked" });
    expect(trxRun).toHaveBeenCalledTimes(2);
  });

  it("never gates a transition back TO active — a grant can only be added", async () => {
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
      targetAppUserId: TARGET_ID,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.reactivated",
    });
    expect(result).toEqual({ ok: true, status: "active" });
    // The predicate is not even consulted.
    expect(trxGrantRows).not.toHaveBeenCalled();
  });

  it("an ORG-SCOPED actor measures only THEIR org's membership (AUTHZ-1)", async () => {
    // The grant lives in ORG_B; the org admin is confined to ORG_A, so their
    // block cannot destroy it and must be allowed.
    const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    trxMembershipRows.mockResolvedValue([{ organization_id: ORG_A }]);
    trxGrantRows.mockResolvedValue([
      { app_user_id: TARGET_ID, organization_id: ORG_B, role_id: ROLE },
    ]);
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: { kind: "org", organizationId: ORG_A },
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
    });
    expect(result).toEqual({ ok: true, status: "blocked" });
  });

  it("a platform with NO grant today is never blocked from ordinary administration", async () => {
    trxGrantRows.mockResolvedValue([]);
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
    });
    expect(result).toEqual({ ok: true, status: "blocked" });
  });
});
