import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Mod from "@/lib/admin/user-actions.server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";

/**
 * Unit tests for the per-user bulk action executor (was 4% covered).
 * Each action MUST route to the correct Better Auth / status / DB call and
 * return the `{ ok, error? }` outcome shape — and a failure in one step
 * must surface as a structured failure, never an unhandled throw, so the
 * bulk loop can aggregate per-row results. (A database fault in a read, such
 * as the shared-target check, is not a per-row outcome.)
 */
const performStatusChange = vi.fn();
const banMock = vi.fn();
const unbanMock = vi.fn();
const auditMock = vi.fn();
const txRun = vi.fn();
const requiresSuperadminMock = vi.fn();
// Review #7 privilege-ordering guard (targetOutranksActor). Default false.
const outranksMock = vi.fn();
// REVOKE-2 (review #444, F-56) — would the ban (on its own, or the one the
// soft-delete applies) leave no superadmin who can sign in? Default false,
// i.e. the platform has other superadmins.
const banStripsLastMock = vi.fn();
// F-57: undoing a ban, or restoring a soft-delete, puts back the ban it
// replaced (`restoreBetterAuthBan`) rather than lifting every ban.
const restoreBanMock = vi.fn();
// F-57: the latest `admin.user.soft_deleted` audit row, which records the ban
// the soft-delete replaced (`recordedPriorBan`). Default: none.
const auditRowMock = vi.fn();
// I-19: the soft-delete revokes the user's API keys and OAuth clients.
const revokeCredentialsMock = vi.fn();

vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: (...a: unknown[]) => performStatusChange(...a),
}));
vi.mock("@/lib/admin/access-scope.server", async () => ({
  // F-32: the real org-stamp rule (pure), so the per-row audits below are
  // filed exactly as in production.
  scopeOrganizationId: (
    await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server")
  ).scopeOrganizationId,
  requiresSuperadminForSharedTarget: (...a: unknown[]) => requiresSuperadminMock(...a),
  banStripsLastGlobalSuperuser: (...a: unknown[]) => banStripsLastMock(...a),
  // The real class, so `instanceof` in the module under test still matches.
  LastSuperadminCascadeError: class LastSuperadminCascadeError extends Error {},
  LAST_SUPERADMIN_ERROR: "last_superadmin",
  LAST_SUPERADMIN_EVENT: "admin.superuser.revocation_denied",
  LAST_SUPERADMIN_REASON: "last_global_superuser",
}));
vi.mock("@/lib/admin/user-target.server", () => ({
  targetOutranksActor: (...a: unknown[]) => outranksMock(...a),
}));
vi.mock("@/lib/admin/auth-admin.server", () => ({
  banBetterAuthUser: (...a: unknown[]) => banMock(...a),
  unbanBetterAuthUser: (...a: unknown[]) => unbanMock(...a),
  restoreBetterAuthBan: (...a: unknown[]) => restoreBanMock(...a),
}));
vi.mock("@/lib/api-auth/credential-eviction.server", () => ({
  revokeBearerCredentialsOf: (...a: unknown[]) => revokeCredentialsMock(...a),
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditMock(...a),
}));
// Every `.set(...)` payload the transaction writes, so a test can read the
// columns (F-07: who `deactivated_by` names).
const trxSets = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("@/db/database", () => {
  // Chainable trx stub. `then` MUST be undefined so awaiting the proxy
  // doesn't treat it as a never-resolving thenable; `execute()` resolves.
  const trx: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "execute") return async () => undefined;
        if (prop === "set") {
          return (payload: Record<string, unknown>) => {
            trxSets.push(payload);
            return trx;
          };
        }
        return () => trx;
      },
    },
  );
  // `recordedPriorBan`'s read: .select().where()...limit().executeTakeFirst().
  const audit: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "executeTakeFirst") return () => auditRowMock();
        return () => audit;
      },
    },
  );
  return {
    db: {
      selectFrom: () => audit,
      transaction: () => ({ execute: (cb: (t: unknown) => Promise<unknown>) => txRun(cb, trx) }),
    },
  };
});

let executeBulkUserAction: typeof Mod.executeBulkUserAction;

const target = {
  appUserId: "u1",
  betterAuthUserId: "ba1",
  primaryEmail: "u@x.com",
  status: "active",
};
/** A soft-deleted target: the only kind `restore` applies to. */
const deletedTarget = { ...target, status: "deactivated" };
const actor = {
  betterAuthUserId: "admin",
  request: { headers: new Headers() },
  scope: { kind: "all" } as const,
  access: { permissions: ["superuser"], organizationId: null },
  requestId: "req-bulk-1",
};

beforeEach(async () => {
  for (const m of [
    performStatusChange,
    banMock,
    unbanMock,
    auditMock,
    txRun,
    requiresSuperadminMock,
    outranksMock,
    banStripsLastMock,
    restoreBanMock,
    auditRowMock,
    revokeCredentialsMock,
  ])
    m.mockReset();
  trxSets.length = 0;
  outranksMock.mockResolvedValue(false);
  banStripsLastMock.mockResolvedValue(false);
  performStatusChange.mockResolvedValue({ ok: true });
  banMock.mockResolvedValue({ previousBan: null });
  unbanMock.mockResolvedValue(undefined);
  restoreBanMock.mockResolvedValue({ banned: false });
  auditRowMock.mockResolvedValue(undefined);
  revokeCredentialsMock.mockResolvedValue({ apiKeyIds: [], oauthClientIds: [] });
  // Default: target is not shared / actor is superadmin → account-global
  // actions are allowed (AUTHZ-2 gate is a no-op).
  requiresSuperadminMock.mockResolvedValue(false);
  txRun.mockImplementation(async (cb: (t: unknown) => Promise<unknown>, t: unknown) => cb(t));
  ({ executeBulkUserAction } = await import("@/lib/admin/user-actions.server"));
});
afterEach(() => vi.resetModules());

describe("status actions", () => {
  it.each([
    ["approve", "active", "admin.user.approved"],
    ["block", "blocked", "admin.user.blocked"],
    ["suspend", "suspended", "admin.user.suspended"],
    ["reactivate", "active", "admin.user.reactivated"],
  ] as const)(
    "%s routes to performAdminStatusChange with the right status",
    async (action, newStatus, eventType) => {
      const out = await executeBulkUserAction(action, target, actor);
      expect(out).toEqual({ ok: true, appUserId: "u1" });
      expect(performStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ newStatus, eventType, targetAppUserId: "u1" }),
      );
    },
  );

  it("propagates a status-change failure as a structured outcome", async () => {
    performStatusChange.mockResolvedValue({ ok: false, error: "user_not_found" });
    const out = await executeBulkUserAction("suspend", target, actor);
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "user_not_found" });
  });
});

describe("ban / unban", () => {
  it("ban requires a reason", async () => {
    const out = await executeBulkUserAction("ban", target, actor, {});
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "reason_required" });
    expect(banMock).not.toHaveBeenCalled();
  });

  it("ban forwards the reason + expiry to Better Auth and audits success", async () => {
    const out = await executeBulkUserAction("ban", target, actor, {
      reason: "abuse",
      expiresInSeconds: 3600,
    });
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    // F-13: the acting admin is named so a ban of oneself is refused; no
    // caller credentials go to the wrapper.
    expect(banMock).toHaveBeenCalledWith({
      userId: "ba1",
      banReason: "abuse",
      banExpiresIn: 3600,
      actorBetterAuthUserId: "admin",
    });
    expect(auditMock).toHaveBeenCalledWith("admin.user.banned", "success", expect.anything());
  });

  it("ban failure is recorded, not thrown", async () => {
    banMock.mockRejectedValue(new Error("be down"));
    const out = await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "auth_ban_failed" });
    expect(auditMock).toHaveBeenCalledWith("admin.user.ban_failed", "error", expect.anything());
  });

  it("ban runs the REVOKE-2 check after the ban, in a transaction, on the target (F-56)", async () => {
    await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(txRun).toHaveBeenCalledTimes(1);
    expect(banStripsLastMock).toHaveBeenCalledWith(target, expect.anything());
    expect(banMock.mock.invocationCallOrder[0]).toBeLessThan(
      banStripsLastMock.mock.invocationCallOrder[0]!,
    );
    expect(restoreBanMock).not.toHaveBeenCalled();
  });

  it("ban is REFUSED and undone when it would leave no superadmin who can sign in (F-56)", async () => {
    banStripsLastMock.mockResolvedValue(true);
    const out = await executeBulkUserAction("ban", target, actor, { reason: "x" });
    // The single-row route answers 409 with the same code.
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "last_superadmin" });
    // The ban already landed, so the saga must lift it again (back to the ban
    // it replaced: none here, F-57).
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", null);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.superuser.revocation_denied",
      "denied",
      expect.objectContaining({
        appUserId: "u1",
        reason: "last_global_superuser",
        requestId: "req-bulk-1",
        metadata: { action: "ban", bulk: true },
      }),
    );
    expect(auditMock).not.toHaveBeenCalledWith("admin.user.banned", "success", expect.anything());
  });

  it("ban is undone, not left in place, when the REVOKE-2 check itself fails (F-56)", async () => {
    txRun.mockRejectedValue(new Error("deadlock"));
    const out = await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "revocation_check_failed" });
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", null);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.ban_failed",
      "error",
      expect.objectContaining({ reason: "revocation_check_failed" }),
    );
    expect(auditMock).not.toHaveBeenCalledWith("admin.user.banned", "success", expect.anything());
  });

  it("a failed undo of a refused ban is audited, and the row still fails (F-56)", async () => {
    banStripsLastMock.mockResolvedValue(true);
    restoreBanMock.mockRejectedValue(new Error("be down"));
    const out = await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "last_superadmin" });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.ban_compensation_failed",
      "error",
      expect.objectContaining({ reason: "compensation_unban_failed" }),
    );
  });

  it("unban calls Better Auth and audits", async () => {
    const out = await executeBulkUserAction("unban", target, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(unbanMock).toHaveBeenCalledWith("ba1");
  });

  it("unban failure is structured", async () => {
    unbanMock.mockRejectedValue(new Error("nope"));
    const out = await executeBulkUserAction("unban", target, actor);
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "auth_unban_failed" });
  });
});

describe("soft_delete / restore", () => {
  it("soft_delete bans then cascades the DB deactivation", async () => {
    const out = await executeBulkUserAction("soft_delete", target, actor, { reason: "gone" });
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(banMock).toHaveBeenCalledWith({
      userId: "ba1",
      banReason: "gone",
      actorBetterAuthUserId: "admin",
    });
    expect(txRun).toHaveBeenCalledTimes(1);
  });

  it("soft_delete records the acting admin in deactivated_by", async () => {
    await executeBulkUserAction("soft_delete", target, actor, { reason: "gone" });
    expect(trxSets[0]).toMatchObject({ status: "deactivated", deactivated_by: "admin" });
  });

  it("soft_delete from an impersonated session records the HUMAN in deactivated_by (F-07)", async () => {
    // `betterAuthUserId` is the borrowed identity on an impersonated batch; the
    // column must name the admin who actually ran it.
    await executeBulkUserAction(
      "soft_delete",
      target,
      { ...actor, betterAuthUserId: "ba-borrowed", impersonatorId: "ba-human" },
      { reason: "gone" },
    );
    expect(trxSets[0]).toMatchObject({ status: "deactivated", deactivated_by: "ba-human" });
  });

  it("soft_delete aborts (no DB cascade) when the ban fails", async () => {
    banMock.mockRejectedValue(new Error("be down"));
    const out = await executeBulkUserAction("soft_delete", target, actor, {});
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "auth_ban_failed" });
    expect(txRun).not.toHaveBeenCalled();
  });

  it("soft_delete compensates the ban when the DB cascade fails", async () => {
    txRun.mockRejectedValue(new Error("deadlock"));
    const out = await executeBulkUserAction("soft_delete", target, actor, {});
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "db_cascade_failed" });
    // The Better Auth ban must be reversed so the two systems stay in sync.
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", null);
  });

  it("soft_delete is REFUSED when the cascade would strip the last global superuser (REVOKE-2)", async () => {
    banStripsLastMock.mockResolvedValue(true);
    const out = await executeBulkUserAction("soft_delete", target, actor, {});
    // Reported with the same code the single-row route answers 409 with, so
    // the bulk path cannot be used to get around it.
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "last_superadmin" });
    // The ban was already applied, so the saga must compensate it — the row
    // must be left exactly as it was.
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", null);
    expect(auditMock).toHaveBeenCalledWith(
      "admin.superuser.revocation_denied",
      "denied",
      expect.objectContaining({ reason: "last_global_superuser" }),
    );
    // NOT the generic cascade failure — an operator must be able to tell the
    // two apart.
    expect(auditMock).not.toHaveBeenCalledWith(
      "admin.user.soft_delete_failed",
      "error",
      expect.anything(),
    );
    // F-56: measured as the ban it has just applied, on the target account.
    expect(banStripsLastMock).toHaveBeenCalledWith(target, expect.anything());
  });

  it("restore unbans then reverses the cascade", async () => {
    const out = await executeBulkUserAction("restore", deletedTarget, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    // No earlier ban recorded: the soft-delete's ban is lifted.
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", null);
    expect(txRun).toHaveBeenCalledTimes(1);
  });

  it("restore failure (unban) is structured", async () => {
    restoreBanMock.mockRejectedValue(new Error("nope"));
    const out = await executeBulkUserAction("restore", deletedTarget, actor);
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "auth_unban_failed" });
    expect(txRun).not.toHaveBeenCalled();
  });

  it.each(["active", "pending_approval", "blocked", "suspended"])(
    "restore refuses a %s account, as the single-row route does, and touches nothing (F-56)",
    async (status) => {
      // Moving an active superadmin to `pending_approval` would be a loss of
      // sign-in that REVOKE-2 never sees.
      const out = await executeBulkUserAction("restore", { ...target, status }, actor);
      expect(out).toEqual({ ok: false, appUserId: "u1", error: "not_deactivated" });
      expect(restoreBanMock).not.toHaveBeenCalled();
      expect(txRun).not.toHaveBeenCalled();
    },
  );
});

describe("account-global actions refuse a shared target for a non-superadmin (AUTHZ-2)", () => {
  beforeEach(() => {
    // Org admin acting on a user shared with other orgs.
    requiresSuperadminMock.mockResolvedValue(true);
  });

  it.each(["ban", "unban", "soft_delete", "restore"] as const)(
    "%s is refused without touching Better Auth / the DB, and the row is audited (F-58)",
    async (action) => {
      const out = await executeBulkUserAction(action, target, actor, { reason: "x" });
      expect(out).toEqual({ ok: false, appUserId: "u1", error: "forbidden_shared_target" });
      expect(banMock).not.toHaveBeenCalled();
      expect(unbanMock).not.toHaveBeenCalled();
      expect(restoreBanMock).not.toHaveBeenCalled();
      expect(txRun).not.toHaveBeenCalled();
      // The single-row routes' row (`refuseSharedTarget`), marked `bulk`. The
      // batch summary counts the row as failed but names neither the user nor
      // the rule.
      expect(auditMock).toHaveBeenCalledTimes(1);
      expect(auditMock).toHaveBeenCalledWith("admin.user.action_denied", "denied", {
        request: actor.request,
        actorBetterAuthUserId: "admin",
        appUserId: "u1",
        organizationId: null,
        email: "u@x.com",
        requestId: "req-bulk-1",
        reason: "shared_target_requires_superadmin",
        metadata: { action, targetBetterAuthUserId: "ba1", bulk: true },
      });
    },
  );

  it("status actions are NOT gated here — confinement happens inside performAdminStatusChange", async () => {
    // suspend on a shared target still dispatches; the mutation core scopes it.
    const out = await executeBulkUserAction("suspend", target, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(performStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ scope: actor.scope, newStatus: "suspended" }),
    );
  });
});

describe("every action refuses a target who outranks the actor (review #7)", () => {
  beforeEach(() => {
    outranksMock.mockResolvedValue(true);
  });

  it.each([
    "approve",
    "block",
    "suspend",
    "reactivate",
    "ban",
    "unban",
    "soft_delete",
    "restore",
  ] as const)("%s is refused per row, audited, and touches nothing", async (action) => {
    const out = await executeBulkUserAction(action, target, actor, { reason: "x" });
    expect(out).toEqual({
      ok: false,
      appUserId: "u1",
      error: "forbidden_target_outranks_actor",
    });
    expect(outranksMock).toHaveBeenCalledWith(actor.access, target);
    expect(performStatusChange).not.toHaveBeenCalled();
    expect(banMock).not.toHaveBeenCalled();
    expect(unbanMock).not.toHaveBeenCalled();
    expect(txRun).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.action_denied",
      "denied",
      expect.objectContaining({
        appUserId: "u1",
        reason: "target_outranks_actor",
        // The batch's x-request-id is threaded through so a denied row can be
        // correlated with the bulk call in the audit explorer.
        requestId: "req-bulk-1",
        metadata: expect.objectContaining({ action, bulk: true }),
      }),
    );
  });

  it("the rank guard runs BEFORE the AUTHZ-2 shared-target guard", async () => {
    requiresSuperadminMock.mockResolvedValue(true);
    const out = await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(out).toEqual({
      ok: false,
      appUserId: "u1",
      error: "forbidden_target_outranks_actor",
    });
    expect(requiresSuperadminMock).not.toHaveBeenCalled();
  });
});

/**
 * F-62: the grid's header checkbox selects the admin's own row like any other,
 * so "Block selected" used to lock the admin out of an org they may be the only
 * admin of. The lockout actions refuse that row; the rest of the batch goes on.
 */
describe("a batch never blocks or suspends its own actor (F-62)", () => {
  const own = { ...target, betterAuthUserId: actor.betterAuthUserId };

  it.each(["block", "suspend"] as const)(
    "%s refuses the actor's own row and touches nothing",
    async (action) => {
      const out = await executeBulkUserAction(action, own, actor);
      expect(out).toEqual({ ok: false, appUserId: "u1", error: "cannot_act_on_self" });
      expect(performStatusChange).not.toHaveBeenCalled();
      expect(outranksMock).not.toHaveBeenCalled();
    },
  );

  it.each(["approve", "reactivate"] as const)(
    "%s still applies to the actor's own row: it can lock nobody out",
    async (action) => {
      const out = await executeBulkUserAction(action, own, actor);
      expect(out).toEqual({ ok: true, appUserId: "u1" });
      expect(performStatusChange).toHaveBeenCalledTimes(1);
    },
  );

  it("block still applies to every other row", async () => {
    const out = await executeBulkUserAction("block", target, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(performStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({ targetAppUserId: "u1", newStatus: "blocked" }),
    );
  });
});

/**
 * F-32: every per-row audit is filed under the org the batch was confined to,
 * so an org admin's bulk lockouts reach that org's audit explorer and the
 * members' Audit tabs. A superadmin batch stays a platform row: its active org
 * says nothing about which tenant each target belongs to.
 */
describe("per-row audits carry the batch's organization (F-32)", () => {
  const orgActor = {
    ...actor,
    scope: { kind: "org", organizationId: "org-a" } as const,
    access: { permissions: ["admin.users.ban", "admin.users.delete"], organizationId: "org-a" },
  };
  const superadminWithActiveOrg = {
    ...actor,
    access: { permissions: ["superuser"], organizationId: "org-a" },
  };

  it.each([
    ["ban", "admin.user.banned"],
    ["unban", "admin.user.unbanned"],
    ["soft_delete", "admin.user.soft_deleted"],
    ["restore", "admin.user.restored"],
  ] as const)("%s by an org admin is stamped with the org", async (action, eventType) => {
    const row = action === "restore" ? deletedTarget : target;
    await executeBulkUserAction(action, row, orgActor, { reason: "x" });
    expect(auditMock).toHaveBeenCalledWith(
      eventType,
      "success",
      expect.objectContaining({ appUserId: "u1", organizationId: "org-a" }),
    );
  });

  it("a failure row is stamped the same way", async () => {
    banMock.mockRejectedValue(new Error("be down"));
    await executeBulkUserAction("ban", target, orgActor, { reason: "x" });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.ban_failed",
      "error",
      expect.objectContaining({ organizationId: "org-a" }),
    );
  });

  it("the rank refusal is stamped the same way", async () => {
    outranksMock.mockResolvedValue(true);
    await executeBulkUserAction("ban", target, orgActor, { reason: "x" });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.action_denied",
      "denied",
      expect.objectContaining({ organizationId: "org-a" }),
    );
  });

  it("the shared-target refusal is stamped the same way (F-58)", async () => {
    requiresSuperadminMock.mockResolvedValue(true);
    await executeBulkUserAction("soft_delete", target, orgActor, { reason: "x" });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.action_denied",
      "denied",
      expect.objectContaining({
        organizationId: "org-a",
        reason: "shared_target_requires_superadmin",
      }),
    );
  });

  it("a superadmin batch is a platform row, never its active org", async () => {
    await executeBulkUserAction("ban", target, superadminWithActiveOrg, { reason: "x" });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.banned",
      "success",
      expect.objectContaining({ organizationId: null }),
    );
  });
});

/**
 * F-57 — a soft-deleted account leaves `deactivated` only through restore. The
 * dispatcher refuses every other transition of one per row with the code the
 * single-row routes answer 409 with, so a batch cannot half-restore a deleted
 * user (approve) or desynchronise its two flags (ban / unban).
 */
describe("a soft-deleted target takes only restore or another soft-delete (F-57)", () => {
  it.each(["approve", "block", "suspend", "reactivate", "ban", "unban"] as const)(
    "%s is refused per row with use_restore and touches nothing",
    async (action) => {
      const out = await executeBulkUserAction(action, deletedTarget, actor, { reason: "x" });
      expect(out).toEqual({ ok: false, appUserId: "u1", error: "use_restore" });
      expect(performStatusChange).not.toHaveBeenCalled();
      expect(banMock).not.toHaveBeenCalled();
      expect(unbanMock).not.toHaveBeenCalled();
      expect(restoreBanMock).not.toHaveBeenCalled();
      expect(txRun).not.toHaveBeenCalled();
    },
  );

  it.each(["soft_delete", "restore"] as const)("%s still applies", async (action) => {
    const out = await executeBulkUserAction(action, deletedTarget, actor, { reason: "x" });
    expect(out).toEqual({ ok: true, appUserId: "u1" });
  });

  it("the rank guard still answers first", async () => {
    outranksMock.mockResolvedValue(true);
    const out = await executeBulkUserAction("approve", deletedTarget, actor);
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "forbidden_target_outranks_actor" });
  });
});

/**
 * F-57 — an earlier ban survives. Every undo of a ban the app applied puts back
 * the ban it replaced, and restore puts back the ban its soft-delete replaced,
 * recorded on the `admin.user.soft_deleted` row, instead of lifting every ban:
 * undoing a delete (`admin.users.delete`) must not lift a ban its holder may
 * not lift (`admin.users.ban`).
 */
describe("a ban the soft-delete or the ban replaced comes back (F-57)", () => {
  const abuse = { reason: "abuse", expiresAt: new Date("2999-01-01T00:00:00.000Z") };

  it("a refused ban is undone back to the ban it replaced", async () => {
    banMock.mockResolvedValue({ previousBan: abuse });
    banStripsLastMock.mockResolvedValue(true);
    await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", abuse);
    expect(unbanMock).not.toHaveBeenCalled();
  });

  it("a failed soft-delete cascade is undone back to the ban it replaced", async () => {
    banMock.mockResolvedValue({ previousBan: abuse });
    txRun.mockRejectedValue(new Error("deadlock"));
    await executeBulkUserAction("soft_delete", target, actor, {});
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", abuse);
    expect(unbanMock).not.toHaveBeenCalled();
  });

  it("a refused soft-delete is undone back to the ban it replaced", async () => {
    banMock.mockResolvedValue({ previousBan: abuse });
    banStripsLastMock.mockResolvedValue(true);
    await executeBulkUserAction("soft_delete", target, actor, {});
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", abuse);
  });

  it("the soft-delete records the ban it replaced on its audit row", async () => {
    banMock.mockResolvedValue({ previousBan: abuse });
    await executeBulkUserAction("soft_delete", target, actor, { reason: "gone" });
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.soft_deleted",
      "success",
      expect.objectContaining({
        reason: "gone",
        metadata: expect.objectContaining({
          priorBan: { reason: "abuse", expiresAt: "2999-01-01T00:00:00.000Z" },
        }),
      }),
    );
  });

  it("a repeated soft-delete keeps the FIRST one's record, not the first one's own ban", async () => {
    // The ban this second soft-delete replaces is the first one's "deleted" ban.
    banMock.mockResolvedValue({ previousBan: { reason: "deleted", expiresAt: null } });
    auditRowMock.mockResolvedValue({
      metadata: { priorBan: { reason: "abuse", expiresAt: null } },
    });
    await executeBulkUserAction("soft_delete", deletedTarget, actor, {});
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.soft_deleted",
      "success",
      expect.objectContaining({
        metadata: expect.objectContaining({ priorBan: { reason: "abuse", expiresAt: null } }),
      }),
    );
  });

  it("restore puts back the recorded ban and says so on its audit row", async () => {
    auditRowMock.mockResolvedValue({
      metadata: { priorBan: { reason: "abuse", expiresAt: "2999-01-01T00:00:00.000Z" } },
    });
    restoreBanMock.mockResolvedValue({ banned: true });
    const out = await executeBulkUserAction("restore", deletedTarget, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", abuse);
    expect(unbanMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.restored",
      "success",
      expect.objectContaining({ metadata: { banReinstated: true, bulk: true } }),
    );
  });

  it("restore after a soft-delete that replaced no ban, or one from before F-57, lifts it", async () => {
    auditRowMock.mockResolvedValue({ metadata: { bulk: true } });
    await executeBulkUserAction("restore", deletedTarget, actor);
    expect(restoreBanMock).toHaveBeenCalledWith("ba1", null);
  });

  it("a failed read of the recorded ban is a database fault, never an auth_ban_failed / auth_unban_failed row", async () => {
    // It fails as the shared-target read before it does (a database fault is
    // not a per-row outcome), before any Better Auth call or write.
    auditRowMock.mockRejectedValue(new Error("audit read failed"));
    await expect(executeBulkUserAction("restore", deletedTarget, actor)).rejects.toThrow(
      "audit read failed",
    );
    await expect(executeBulkUserAction("soft_delete", deletedTarget, actor, {})).rejects.toThrow(
      "audit read failed",
    );
    expect(restoreBanMock).not.toHaveBeenCalled();
    expect(banMock).not.toHaveBeenCalled();
    expect(txRun).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

/**
 * I-19 — a soft-delete revokes the user's API keys and OAuth clients once its
 * cascade has committed, so restore and approve can no longer re-arm them.
 */
describe("the soft-delete revokes the user's bearer credentials (I-19)", () => {
  const appActor = { ...actor, appUserId: "app-admin" };

  it("revokes them after the cascade, as owner_deleted, in the admin's name", async () => {
    revokeCredentialsMock.mockResolvedValue({ apiKeyIds: ["k1", "k2"], oauthClientIds: ["c1"] });
    const out = await executeBulkUserAction("soft_delete", target, appActor, { reason: "gone" });
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(revokeCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        betterAuthUserId: "ba1",
        trigger: "owner_deleted",
        actorBetterAuthUserId: "admin",
        revokedByAppUserId: "app-admin",
        requestId: "req-bulk-1",
      }),
    );
    // After the ban (which ends the sessions) and after the cascade commits.
    expect(banMock.mock.invocationCallOrder[0]).toBeLessThan(
      revokeCredentialsMock.mock.invocationCallOrder[0]!,
    );
    expect(txRun.mock.invocationCallOrder[0]).toBeLessThan(
      revokeCredentialsMock.mock.invocationCallOrder[0]!,
    );
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.soft_deleted",
      "success",
      expect.objectContaining({
        metadata: expect.objectContaining({ revokedApiKeys: 2, revokedOauthClients: 1 }),
      }),
    );
  });

  it("revokes nothing when the soft-delete is refused or its cascade fails", async () => {
    banStripsLastMock.mockResolvedValue(true);
    await executeBulkUserAction("soft_delete", target, actor, {});
    banStripsLastMock.mockResolvedValue(false);
    txRun.mockRejectedValue(new Error("deadlock"));
    await executeBulkUserAction("soft_delete", target, actor, {});
    expect(revokeCredentialsMock).not.toHaveBeenCalled();
  });

  it("a failed revocation fails the row, and the deletion's record is still written", async () => {
    revokeCredentialsMock.mockRejectedValue(new Error("still minting"));
    banMock.mockResolvedValue({ previousBan: { reason: "abuse", expiresAt: null } });
    const out = await executeBulkUserAction("soft_delete", target, actor, {});
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "credential_revocation_failed" });
    // Restore still needs the ban the soft-delete replaced.
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.soft_deleted",
      "success",
      expect.objectContaining({
        metadata: expect.objectContaining({
          priorBan: { reason: "abuse", expiresAt: null },
          credentialRevocationFailed: true,
        }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      "admin.user.soft_delete_failed",
      "error",
      expect.objectContaining({ reason: "credential_revocation_failed" }),
    );
  });

  it("restore revokes nothing", async () => {
    await executeBulkUserAction("restore", deletedTarget, actor);
    expect(revokeCredentialsMock).not.toHaveBeenCalled();
  });
});

/**
 * F-77 — an MCP agent's service account has no Better Auth user, so a row that
 * works on one (ban, unban, soft-delete, restore) is refused before Better Auth
 * is asked; it used to fail each time with `auth_ban_failed` /
 * `auth_unban_failed` and a failure row. And approving or reactivating one is
 * an agent approval, which needs `admin.clients.manage`
 * (`actor.mayActivateAgents`, the bulk route's `mayActivateAgents(guard)`).
 */
describe("an agent service account in a batch (F-77)", () => {
  const agent = {
    appUserId: "u-agent",
    betterAuthUserId: "mcp-agent:5b0c7f6e-0c1e-4a57-9d3a-1f2e3d4c5b6a",
    primaryEmail: "mcp-agent-1@agents.mcp.invalid",
    status: "active",
  };
  // The reaper expires a stale registration to `deactivated`, the one state
  // restore applies to.
  const expiredAgent = { ...agent, status: "deactivated" };

  it.each([
    ["ban", agent],
    ["unban", agent],
    ["soft_delete", agent],
    ["restore", expiredAgent],
  ] as const)(
    "%s is refused with not_applicable_to_service_account, and Better Auth is never asked",
    async (action, row) => {
      const out = await executeBulkUserAction(action, row, actor, { reason: "junk" });
      expect(out).toEqual({
        ok: false,
        appUserId: "u-agent",
        error: "not_applicable_to_service_account",
      });
      expect(banMock).not.toHaveBeenCalled();
      expect(unbanMock).not.toHaveBeenCalled();
      expect(restoreBanMock).not.toHaveBeenCalled();
      expect(txRun).not.toHaveBeenCalled();
      expect(revokeCredentialsMock).not.toHaveBeenCalled();
      // Nothing failed, so nothing is audited as a failure.
      expect(auditMock).not.toHaveBeenCalled();
    },
  );

  it.each(["approve", "reactivate"] as const)(
    "%s without admin.clients.manage is refused per row and audited as denied",
    async (action) => {
      const out = await executeBulkUserAction(
        action,
        { ...agent, status: "pending_approval" },
        {
          ...actor,
          mayActivateAgents: false,
        },
      );
      expect(out).toEqual({ ok: false, appUserId: "u-agent", error: "forbidden_agent_activation" });
      expect(performStatusChange).not.toHaveBeenCalled();
      expect(auditMock).toHaveBeenCalledWith("admin.user.action_denied", "denied", {
        request: actor.request,
        actorBetterAuthUserId: "admin",
        appUserId: "u-agent",
        organizationId: null,
        email: "mcp-agent-1@agents.mcp.invalid",
        requestId: "req-bulk-1",
        reason: "agent_requires_clients_manage",
        metadata: {
          action,
          targetBetterAuthUserId: agent.betterAuthUserId,
          required: ["admin.clients.manage"],
          bulk: true,
        },
      });
    },
  );

  it("fails closed: a caller that does not say the actor may approve agents is refused", async () => {
    const out = await executeBulkUserAction("approve", agent, actor);
    expect(out).toEqual({ ok: false, appUserId: "u-agent", error: "forbidden_agent_activation" });
    expect(performStatusChange).not.toHaveBeenCalled();
  });

  it.each(["approve", "reactivate"] as const)(
    "%s with admin.clients.manage goes to the status core",
    async (action) => {
      const out = await executeBulkUserAction(action, agent, { ...actor, mayActivateAgents: true });
      expect(out).toEqual({ ok: true, appUserId: "u-agent" });
      expect(performStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ targetAppUserId: "u-agent", newStatus: "active" }),
      );
    },
  );

  it.each(["block", "suspend"] as const)(
    "%s still applies without admin.clients.manage: it only stops the agent",
    async (action) => {
      const out = await executeBulkUserAction(action, agent, {
        ...actor,
        mayActivateAgents: false,
      });
      expect(out).toEqual({ ok: true, appUserId: "u-agent" });
      expect(performStatusChange).toHaveBeenCalledTimes(1);
    },
  );

  it("approving a person needs no admin.clients.manage", async () => {
    const out = await executeBulkUserAction("approve", target, {
      ...actor,
      mayActivateAgents: false,
    });
    expect(out).toEqual({ ok: true, appUserId: "u1" });
  });
});
