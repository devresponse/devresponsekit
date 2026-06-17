import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Mod from "@/lib/admin/user-actions.server";

/**
 * Unit tests for the per-user bulk action executor (was 4% covered).
 * Each action MUST route to the correct Better Auth / status / DB call and
 * return the `{ ok, error? }` outcome shape — and a failure in one step
 * must surface as a structured failure, never an unhandled throw, so the
 * bulk loop can aggregate per-row results.
 */
const performStatusChange = vi.fn();
const banMock = vi.fn();
const unbanMock = vi.fn();
const auditMock = vi.fn();
const txRun = vi.fn();
const requiresSuperadminMock = vi.fn();

vi.mock("@/lib/admin-status.server", () => ({
  performAdminStatusChange: (...a: unknown[]) => performStatusChange(...a),
}));
vi.mock("@/lib/admin/access-scope.server", () => ({
  requiresSuperadminForSharedTarget: (...a: unknown[]) => requiresSuperadminMock(...a),
}));
vi.mock("@/lib/admin/auth-admin.server", () => ({
  banBetterAuthUser: (...a: unknown[]) => banMock(...a),
  unbanBetterAuthUser: (...a: unknown[]) => unbanMock(...a),
}));
vi.mock("@/lib/admin/audit-helpers.server", () => ({
  auditUserAction: (...a: unknown[]) => auditMock(...a),
}));
vi.mock("@/db/database", () => {
  // Chainable trx stub. `then` MUST be undefined so awaiting the proxy
  // doesn't treat it as a never-resolving thenable; `execute()` resolves.
  const trx: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "execute") return async () => undefined;
        return () => trx;
      },
    },
  );
  return {
    db: {
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
const actor = {
  betterAuthUserId: "admin",
  request: { headers: new Headers() },
  scope: { kind: "all" } as const,
};

beforeEach(async () => {
  for (const m of [
    performStatusChange,
    banMock,
    unbanMock,
    auditMock,
    txRun,
    requiresSuperadminMock,
  ])
    m.mockReset();
  performStatusChange.mockResolvedValue({ ok: true });
  banMock.mockResolvedValue(undefined);
  unbanMock.mockResolvedValue(undefined);
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
    expect(banMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "ba1", banReason: "abuse", banExpiresIn: 3600 }),
      actor.request,
    );
    expect(auditMock).toHaveBeenCalledWith("admin.user.banned", "success", expect.anything());
  });

  it("ban failure is recorded, not thrown", async () => {
    banMock.mockRejectedValue(new Error("be down"));
    const out = await executeBulkUserAction("ban", target, actor, { reason: "x" });
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "auth_ban_failed" });
    expect(auditMock).toHaveBeenCalledWith("admin.user.ban_failed", "error", expect.anything());
  });

  it("unban calls Better Auth and audits", async () => {
    const out = await executeBulkUserAction("unban", target, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(unbanMock).toHaveBeenCalledWith("ba1", actor.request);
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
    expect(banMock).toHaveBeenCalled();
    expect(txRun).toHaveBeenCalledTimes(1);
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
    expect(unbanMock).toHaveBeenCalledWith("ba1", actor.request);
  });

  it("restore unbans then reverses the cascade", async () => {
    const out = await executeBulkUserAction("restore", target, actor);
    expect(out).toEqual({ ok: true, appUserId: "u1" });
    expect(unbanMock).toHaveBeenCalled();
    expect(txRun).toHaveBeenCalledTimes(1);
  });

  it("restore failure (unban) is structured", async () => {
    unbanMock.mockRejectedValue(new Error("nope"));
    const out = await executeBulkUserAction("restore", target, actor);
    expect(out).toEqual({ ok: false, appUserId: "u1", error: "auth_unban_failed" });
    expect(txRun).not.toHaveBeenCalled();
  });
});

describe("account-global actions refuse a shared target for a non-superadmin (AUTHZ-2)", () => {
  beforeEach(() => {
    // Org admin acting on a user shared with other orgs.
    requiresSuperadminMock.mockResolvedValue(true);
  });

  it.each(["ban", "unban", "soft_delete", "restore"] as const)(
    "%s is refused without touching Better Auth / the DB",
    async (action) => {
      const out = await executeBulkUserAction(action, target, actor, { reason: "x" });
      expect(out).toEqual({ ok: false, appUserId: "u1", error: "forbidden_shared_target" });
      expect(banMock).not.toHaveBeenCalled();
      expect(unbanMock).not.toHaveBeenCalled();
      expect(txRun).not.toHaveBeenCalled();
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
