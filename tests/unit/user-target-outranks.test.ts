import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UserTargetModule from "@/lib/admin/user-target.server";
import type * as AccessScopeModule from "@/lib/admin/access-scope.server";

/**
 * Unit tests for `targetOutranksActor` / `refuseOutrankingTarget`
 * (docs/admin-manager.md §6, review #7).
 *
 * The rule is the impersonate route's subset test, applied to every
 * account-level action on another user: a NON-superadmin may not act on a
 * target whose effective permissions (in the actor's org) include anything
 * the actor lacks — which covers a single-org superadmin (the seeded
 * `orgadmin@<org>` vs `superuser@<org>` pair) and a more-privileged peer.
 */
const accessGetter = vi.fn();
const auditMock = vi.fn();
const globalSuperuserMock = vi.fn();

vi.mock("@/lib/auth-status", () => ({
  getUserAccessContext: (...a: unknown[]) => accessGetter(...a),
}));
// `isOrgBound` / `isSuperadmin` run for REAL — they are the rule under test.
// Only the DB-backed rank lookup is stubbed.
vi.mock("@/lib/admin/access-scope.server", async () => {
  const actual = await vi.importActual<typeof AccessScopeModule>("@/lib/admin/access-scope.server");
  return { ...actual, userIsGlobalSuperuser: (...a: unknown[]) => globalSuperuserMock(...a) };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...a: unknown[]) => auditMock(...a),
}));
// `user-target.server` imports the DB for `resolveTargetUser`; nothing under
// test here touches it, so a bare stub is enough.
vi.mock("@/db/database", () => ({ db: {} }));

let targetOutranksActor: typeof UserTargetModule.targetOutranksActor;
let refuseOutrankingTarget: typeof UserTargetModule.refuseOutrankingTarget;

const ORG = "o-1";
const targetCtx = (permissions: string[]) => ({
  appUserId: "u-target",
  primaryEmail: "t@x.com",
  status: "active",
  organizationId: ORG,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions,
});

const target = {
  appUserId: "u-target",
  betterAuthUserId: "ba-target",
  primaryEmail: "t@x.com",
  displayName: "Target",
  status: "active",
};

beforeEach(async () => {
  accessGetter.mockReset();
  auditMock.mockReset();
  globalSuperuserMock.mockReset();
  globalSuperuserMock.mockResolvedValue(false);
  ({ targetOutranksActor, refuseOutrankingTarget } =
    await import("@/lib/admin/user-target.server"));
});
afterEach(() => vi.resetModules());

describe("targetOutranksActor", () => {
  it("a SUPERADMIN actor is exempt — no target lookup at all", async () => {
    const actor = { permissions: ["superuser", "admin.users.ban"], organizationId: ORG };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(false);
    expect(accessGetter).not.toHaveBeenCalled();
  });

  it("fails CLOSED for a non-superadmin with no resolvable org", async () => {
    const actor = { permissions: ["admin.users.ban"], organizationId: null };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(true);
    expect(accessGetter).not.toHaveBeenCalled();
  });

  it("evaluates the target in the ACTOR's org via the bound-org path (never the cookie)", async () => {
    accessGetter.mockResolvedValue(targetCtx([]));
    const actor = { permissions: ["admin.users.ban"], organizationId: ORG };
    await targetOutranksActor(actor, target);
    expect(accessGetter).toHaveBeenCalledWith("ba-target", { organizationId: ORG });
  });

  it("a target holding `superuser` outranks any non-superadmin (the seeded orgadmin/superuser pair)", async () => {
    accessGetter.mockResolvedValue(targetCtx(["superuser", "shell.view"]));
    // The org admin holds the FULL admin.* catalog but not the marker.
    const actor = {
      permissions: [
        "shell.view",
        "admin.users.ban",
        "admin.users.setPassword",
        "admin.users.delete",
      ],
      organizationId: ORG,
    };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(true);
  });

  it("a target with any permission the actor lacks (strict superset / peer) outranks", async () => {
    accessGetter.mockResolvedValue(
      targetCtx(["shell.view", "admin.users.ban", "admin.roles.update"]),
    );
    const actor = { permissions: ["shell.view", "admin.users.ban"], organizationId: ORG };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(true);
  });

  it("an equal permission set does NOT outrank", async () => {
    accessGetter.mockResolvedValue(targetCtx(["shell.view", "admin.users.ban"]));
    const actor = { permissions: ["admin.users.ban", "shell.view"], organizationId: ORG };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(false);
  });

  it("a plain member (subset) does NOT outrank", async () => {
    accessGetter.mockResolvedValue(targetCtx(["shell.view"]));
    const actor = { permissions: ["shell.view", "admin.users.ban"], organizationId: ORG };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(false);
  });

  /**
   * MACHINE-2. The subset test cannot express this case. A bound SUPERUSER
   * credential's `permissions` is the whole `ADMIN_PERMISSION_CATALOG`
   * (getUserAccessContext expands the marker on the bound path too), so the
   * `isSuperadmin` exemption fires first and, even without it, the actor's set
   * is a superset of every target's. Without an explicit RANK rule, an
   * org-bound credential could set the password of — and thereby become — a
   * platform superuser who happens to be a member of its bound org.
   */
  it("an ORG-BOUND actor may NOT act on a GLOBAL SUPERUSER target, whatever its own set", async () => {
    globalSuperuserMock.mockResolvedValue(true);
    const actor = {
      permissions: ["superuser", "admin.users.setPassword", "admin.users.ban"],
      organizationId: ORG,
      orgBound: true,
    };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(true);
    expect(globalSuperuserMock).toHaveBeenCalledWith("u-target");
    // Short-circuits before the subset comparison — the target context is
    // never even resolved.
    expect(accessGetter).not.toHaveBeenCalled();
  });

  it("an ORG-BOUND actor still falls through to the subset test for an ORDINARY target", async () => {
    // Additive only: the rank rule adds a refusal, it never replaces the
    // stricter subset comparison for a bound NON-superuser actor.
    globalSuperuserMock.mockResolvedValue(false);
    accessGetter.mockResolvedValue(targetCtx(["shell.view", "admin.roles.update"]));
    const actor = {
      permissions: ["shell.view", "admin.users.ban"],
      organizationId: ORG,
      orgBound: true,
    };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(true);
    expect(accessGetter).toHaveBeenCalledWith("ba-target", { organizationId: ORG });
  });

  it("an UNBOUND superadmin pays no rank round-trip (cookie sessions unchanged)", async () => {
    const actor = { permissions: ["superuser"], organizationId: ORG };
    await expect(targetOutranksActor(actor, target)).resolves.toBe(false);
    expect(globalSuperuserMock).not.toHaveBeenCalled();
  });
});

describe("refuseOutrankingTarget", () => {
  const request = { headers: new Headers({ "x-request-id": "req-1" }) };

  it("returns null (proceed) when the target does not outrank", async () => {
    accessGetter.mockResolvedValue(targetCtx(["shell.view"]));
    const guard = {
      access: { permissions: ["shell.view", "admin.users.ban"], organizationId: ORG },
      betterAuthUserId: "ba-actor",
      requestId: "req-1",
    };
    await expect(refuseOutrankingTarget(guard, target, request, "ban")).resolves.toBeNull();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 403 `forbidden` and audits `admin.user.action_denied` when the target outranks", async () => {
    accessGetter.mockResolvedValue(targetCtx(["superuser"]));
    const guard = {
      access: { permissions: ["shell.view", "admin.users.ban"], organizationId: ORG },
      betterAuthUserId: "ba-actor",
      requestId: "req-1",
    };
    const res = await refuseOutrankingTarget(guard, target, request, "ban");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(res!.headers.get("x-request-id")).toBe("req-1");
    expect(await res!.json()).toEqual(
      expect.objectContaining({ error: "forbidden", requestId: "req-1" }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "admin.user.action_denied",
        outcome: "denied",
        actorBetterAuthUserId: "ba-actor",
        appUserId: "u-target",
        email: "t@x.com",
        reason: "target_outranks_actor",
        requestId: "req-1",
        metadata: { action: "ban", targetBetterAuthUserId: "ba-target" },
      }),
    );
  });
});
