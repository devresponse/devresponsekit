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
/** Called once the transaction callback resolves: the stub's COMMIT (F-147). */
const txCommitted = vi.fn();
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
const trxClaim = vi.fn(); // the If-Match compare-and-swap claim (review #44)
/**
 * F-57: the account status the core reads back under the row lock, inside the
 * transaction, before it writes. Default `active`; `deactivated` is refused.
 */
const trxAccountRow = vi.fn();
/** The builder calls made on that locked read, so the lock itself is pinned. */
const trxAccountCalls: string[] = [];

vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
/**
 * F-147: the session revocation a block or suspend runs after its commit —
 * Better Auth's `deleteUserSessions` plus the `impersonatedBy` sweep, behind
 * the revoke-all wrapper. Its real behaviour against Postgres is pinned in
 * tests/db/status-session-revocation.db.test.ts.
 */
const revokeAllSessions = vi.fn();
vi.mock("@/lib/admin/auth-admin.server", () => ({
  revokeAllBetterAuthUserSessions: (...args: unknown[]) => revokeAllSessions(...args),
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
function trxAccountChain(): unknown {
  // F-57: .select("status").where(...).forUpdate().executeTakeFirst().
  const p: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "executeTakeFirst") return trxAccountRow;
        return () => {
          trxAccountCalls.push(String(prop));
          return p;
        };
      },
    },
  );
  return p;
}
function trxSelectChain(table: string): unknown {
  if (table === "app_users") return trxAccountChain();
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
    execute: async (fn: (trx: unknown) => unknown) => {
      const result = await fn({
        selectFrom: (t: unknown) => trxSelectChain(tableKey(t)),
        updateTable: () => {
          // Any-length .set().where()....execute() routes to trxRun; the
          // claim's .executeTakeFirst() routes to trxClaim.
          const p: unknown = new Proxy(
            {},
            {
              get(_t, prop) {
                if (prop === "execute") return trxRun;
                if (prop === "executeTakeFirst") return trxClaim;
                return () => p;
              },
            },
          );
          return p;
        },
      });
      txCommitted();
      return result;
    },
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
  txCommitted.mockReset();
  userExecuteTakeFirst.mockReset();
  sharedExecuteTakeFirst.mockReset();
  sharedExecuteTakeFirst.mockResolvedValue(undefined); // not shared by default
  trxMembershipRows.mockReset();
  trxMembershipRows.mockResolvedValue([{ organization_id: ORG_A }]);
  trxGrantRows.mockReset();
  trxGrantRows.mockResolvedValue([]); // no superuser grant to protect by default
  trxClaim.mockReset();
  trxClaim.mockResolvedValue({ numUpdatedRows: 1n }); // the claim wins by default
  trxAccountRow.mockReset();
  trxAccountRow.mockResolvedValue({ status: "active" });
  trxAccountCalls.length = 0;
  revokeAllSessions.mockReset();
  revokeAllSessions.mockResolvedValue({ success: true });
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
    // Not refused, though the target holds the only grant…
    expect(result).toEqual({ ok: true, status: "active" });
    // …but the grant read still runs, for its locks, before the first write
    // (F-56 lock order: this writes the `app_users` and membership rows a
    // concurrent guarded read locks, so it must not take them first).
    expect(trxGrantRows).toHaveBeenCalledTimes(1);
    expect(trxGrantRows.mock.invocationCallOrder[0]).toBeLessThan(
      trxRun.mock.invocationCallOrder[0]!,
    );
  });

  it("with If-Match, reads the grants before the claim, and a lost claim still answers 412 before a 409", async () => {
    // F-56 lock order: the claim writes the target's `app_users` row, which the
    // grant read locks last, so claiming first could deadlock with a
    // concurrent guarded read (tests/db/last-superadmin-sign-in.db.test.ts).
    const input = {
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
      expectedUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    } as const;
    // The target holds the only grant, so this block is refused…
    await expect(performAdminStatusChange(input)).resolves.toEqual({
      ok: false,
      error: "last_superadmin",
    });
    expect(trxGrantRows.mock.invocationCallOrder[0]).toBeLessThan(
      trxClaim.mock.invocationCallOrder[0]!,
    );
    expect(trxRun).not.toHaveBeenCalled();

    // …unless the version is stale: the lost claim still wins, as before.
    trxClaim.mockResolvedValue({ numUpdatedRows: 0n });
    await expect(performAdminStatusChange(input)).resolves.toEqual({
      ok: false,
      error: "precondition_failed",
    });
    expect(trxRun).not.toHaveBeenCalled();
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

/**
 * F-57 — a soft-deleted account leaves `deactivated` only through restore.
 * Approving one used to make it `active` while its Better Auth ban, its
 * `deactivated_*` columns and its membership snapshot stayed (a user who
 * still could not sign in, and whom restore then refused); block and suspend
 * left the same stale state behind. The core decides it inside its own
 * transaction, from the account row it locks, so both status routes and the
 * bulk status actions refuse it the same way.
 */
describe("performAdminStatusChange — a soft-deleted target (F-57)", () => {
  beforeEach(() => {
    userExecuteTakeFirst.mockResolvedValue({ id: TARGET_ID, primary_email: "target@x.com" });
    trxAccountRow.mockResolvedValue({ status: "deactivated" });
  });

  it.each([
    ["active", "active", "admin.user.approved"],
    ["blocked", "blocked", "admin.user.blocked"],
    ["suspended", "suspended", "admin.user.suspended"],
    ["active", "active", "admin.user.reactivated"],
  ] as const)(
    "refuses a move to %s (%s) with use_restore and writes nothing",
    async (newStatus, newMembershipStatus, eventType) => {
      const result = await performAdminStatusChange({
        actorBetterAuthUserId: ACTOR_ID,
        scope: ALL,
        targetAppUserId: TARGET_ID,
        newStatus,
        newMembershipStatus,
        eventType,
      });
      expect(result).toEqual({ ok: false, error: "use_restore" });
      expect(trxRun).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    },
  );

  it("refuses it for an org admin confined to their org too", async () => {
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: { kind: "org", organizationId: ORG_A },
      targetAppUserId: TARGET_ID,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.approved",
    });
    expect(result).toEqual({ ok: false, error: "use_restore" });
    expect(trxRun).not.toHaveBeenCalled();
  });

  it("reads the status under the row lock, after the grant read and the claim", async () => {
    await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
      targetAppUserId: TARGET_ID,
      newStatus: "blocked",
      newMembershipStatus: "blocked",
      eventType: "admin.user.blocked",
      expectedUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // A plain read would miss a soft-delete committing meanwhile, and the
    // write below would then overwrite it.
    expect(trxAccountCalls).toContain("forUpdate");
    const read = trxAccountRow.mock.invocationCallOrder[0]!;
    expect(trxMembershipRows.mock.invocationCallOrder[0]).toBeLessThan(read);
    expect(trxClaim.mock.invocationCallOrder[0]).toBeLessThan(read);
  });

  it("a stale If-Match still answers 412 ahead of the 409", async () => {
    trxClaim.mockResolvedValue({ numUpdatedRows: 0n });
    const result = await performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope: ALL,
      targetAppUserId: TARGET_ID,
      newStatus: "active",
      newMembershipStatus: "active",
      eventType: "admin.user.approved",
      expectedUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(result).toEqual({ ok: false, error: "precondition_failed" });
  });
});

/**
 * F-147 — block and suspend end the account's Better Auth sessions. They used
 * to write only the app's rows, so the sessions stayed valid to Better Auth:
 * `/get-session` kept refreshing them, and reactivating the account brought
 * every one back. The revocation runs after the commit and only when the
 * ACCOUNT-GLOBAL status leaves `active`; a change confined to one org of a
 * shared user, a grant and every refusal end nothing.
 */
describe("performAdminStatusChange — ends the account's sessions (F-147)", () => {
  const TARGET_BA = "ba-target";
  const ORG_SCOPE = { kind: "org", organizationId: ORG_A } as const;

  beforeEach(() => {
    userExecuteTakeFirst.mockResolvedValue({
      id: TARGET_ID,
      primary_email: "target@x.com",
      better_auth_user_id: TARGET_BA,
    });
  });

  const change = (
    newStatus: "active" | "blocked" | "suspended",
    eventType: string,
    scope: AdminStatusModule.AdminStatusChangeInput["scope"] = ALL,
  ) =>
    performAdminStatusChange({
      actorBetterAuthUserId: ACTOR_ID,
      scope,
      targetAppUserId: TARGET_ID,
      newStatus,
      newMembershipStatus: newStatus,
      eventType,
    });

  it.each([
    ["blocked", "admin.user.blocked"],
    ["suspended", "admin.user.suspended"],
  ] as const)("a move to %s ends them, after the commit, and says so", async (status, event) => {
    const result = await change(status, event);
    expect(result).toEqual({ ok: true, status });
    expect(revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(revokeAllSessions).toHaveBeenCalledWith(TARGET_BA);
    // After the commit, not inside the transaction: a refused or rolled-back
    // change signs nobody out.
    expect(txCommitted).toHaveBeenCalledTimes(1);
    expect(revokeAllSessions.mock.invocationCallOrder[0]).toBeGreaterThan(
      txCommitted.mock.invocationCallOrder[0]!,
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: event,
        outcome: "success",
        metadata: { sessionsRevoked: true },
      }),
    );
  });

  it("a single-org user blocked by their org admin is account-wide, so theirs end too", async () => {
    sharedExecuteTakeFirst.mockResolvedValue(undefined);
    await expect(change("blocked", "admin.user.blocked", ORG_SCOPE)).resolves.toEqual({
      ok: true,
      status: "blocked",
    });
    expect(revokeAllSessions).toHaveBeenCalledWith(TARGET_BA);
  });

  it("a block confined to one org of a SHARED user ends nothing (still active elsewhere)", async () => {
    sharedExecuteTakeFirst.mockResolvedValue({ id: "m-other-org" });
    await expect(change("blocked", "admin.user.blocked", ORG_SCOPE)).resolves.toEqual({
      ok: true,
      status: "blocked",
    });
    expect(revokeAllSessions).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ metadata: expect.anything() }),
    );
  });

  it.each(["admin.user.approved", "admin.user.reactivated"])("%s ends nothing", async (event) => {
    await expect(change("active", event)).resolves.toEqual({ ok: true, status: "active" });
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("a refused change ends nothing (last superadmin, soft-deleted, stale version)", async () => {
    trxGrantRows.mockResolvedValue([
      { app_user_id: TARGET_ID, organization_id: ORG_A, role_id: "r" },
    ]);
    await expect(change("blocked", "admin.user.blocked")).resolves.toMatchObject({
      error: "last_superadmin",
    });
    trxGrantRows.mockResolvedValue([]);
    trxAccountRow.mockResolvedValue({ status: "deactivated" });
    await expect(change("suspended", "admin.user.suspended")).resolves.toMatchObject({
      error: "use_restore",
    });
    trxAccountRow.mockResolvedValue({ status: "active" });
    trxClaim.mockResolvedValue({ numUpdatedRows: 0n });
    await expect(
      performAdminStatusChange({
        actorBetterAuthUserId: ACTOR_ID,
        scope: ALL,
        targetAppUserId: TARGET_ID,
        newStatus: "blocked",
        newMembershipStatus: "blocked",
        eventType: "admin.user.blocked",
        expectedUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ error: "precondition_failed" });
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("a failed revocation keeps the status, audits both, and answers auth_revoke_all_failed", async () => {
    const boom = new Error("adapter down");
    revokeAllSessions.mockRejectedValue(boom);
    const result = await change("blocked", "admin.user.blocked");
    expect(result).toEqual({ ok: false, error: "auth_revoke_all_failed", cause: boom });
    // The status is applied: both writes ran, and its success row records it,
    // without claiming the sessions ended.
    expect(trxRun).toHaveBeenCalledTimes(2);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "admin.user.blocked", outcome: "success" }),
    );
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { sessionsRevoked: true } }),
    );
    // Revoke-all's own failure event, so one filter lists every failed sweep.
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.sessions_revoke_all_failed",
        outcome: "failure",
        appUserId: TARGET_ID,
        reason: "auth_revoke_all_failed",
        metadata: {
          action: "status_change",
          statusEvent: "admin.user.blocked",
          message: "adapter down",
        },
      }),
    );
  });
});
