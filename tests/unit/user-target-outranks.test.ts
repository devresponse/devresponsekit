import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UserTargetModule from "@/lib/admin/user-target.server";

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

vi.mock("@/lib/auth-status", () => ({
  getUserAccessContext: (...a: unknown[]) => accessGetter(...a),
}));
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
