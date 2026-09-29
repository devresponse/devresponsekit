import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RefusalsModule from "@/lib/admin/refusals.server";

/**
 * F-58 — the auditing refusals in src/lib/admin/refusals.server.ts. Each one
 * writes its `denied` row and returns the 403 `forbidden` envelope the handler
 * used to return bare, so a call site changes nothing a client sees.
 *
 * `auditEvent` is stubbed; the row it is handed is what these pin. The
 * `request` is passed through untouched because F-07 attribution is keyed on
 * it (tests/security/impersonation-audit-attribution.test.ts drives a refusal
 * through the real writer on an impersonated session).
 */
const auditMock = vi.fn();

vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...a: unknown[]) => auditMock(...a),
}));
// Nothing here queries; access-scope and user-target import the pool.
vi.mock("@/db/database", () => ({ db: {} }));

let refusals: typeof RefusalsModule;

const request = { headers: new Headers({ "x-request-id": "req-1" }) };
/** An org admin of o-1 (no cross-org reach). */
const orgAdmin = {
  access: { permissions: ["shell.view", "admin.groups.assign"], organizationId: "o-1" },
  betterAuthUserId: "ba-actor",
  requestId: "req-1",
};

async function expectForbidden(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(res.headers.get("x-request-id")).toBe("req-1");
  expect(await res.json()).toEqual({
    error: "forbidden",
    message: "errors.forbidden",
    requestId: "req-1",
  });
}

beforeEach(async () => {
  auditMock.mockReset();
  refusals = await import("@/lib/admin/refusals.server");
});
afterEach(() => vi.resetModules());

describe("refuseUnconferrable (AUTHZ-3 / REVOKE-1)", () => {
  it("audits admin.permission.conferral_denied under the resource's org and returns the 403", async () => {
    const res = await refusals.refuseUnconferrable(orgAdmin, request, {
      action: "group_members_add",
      organizationId: "o-group",
      unheld: ["superuser", "admin.users.delete"],
      appUserId: "u-target",
      email: "t@x.com",
      metadata: { groupId: "g-1", key: "admins" },
    });
    await expectForbidden(res);
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith({
      eventType: "admin.permission.conferral_denied",
      outcome: "denied",
      actorBetterAuthUserId: "ba-actor",
      appUserId: "u-target",
      organizationId: "o-group",
      email: "t@x.com",
      reason: "unheld_permissions",
      request,
      requestId: "req-1",
      metadata: {
        action: "group_members_add",
        groupId: "g-1",
        key: "admins",
        unheldPermissions: ["superuser", "admin.users.delete"],
      },
    });
  });

  it("names no user when the route resolved none, and metadata cannot overwrite the refused keys", async () => {
    await refusals.refuseUnconferrable(orgAdmin, request, {
      action: "role_permissions_add",
      organizationId: "o-1",
      unheld: ["superuser"],
      metadata: { roleId: "r-1", unheldPermissions: [] },
    });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appUserId: null,
        email: null,
        metadata: {
          action: "role_permissions_add",
          roleId: "r-1",
          unheldPermissions: ["superuser"],
        },
      }),
    );
  });
});

describe("refuseSharedTarget (AUTHZ-2)", () => {
  const target = { appUserId: "u-shared", betterAuthUserId: "ba-shared", primaryEmail: "s@x.com" };

  it("audits admin.user.action_denied with the shared-target reason, stamped with the actor's org", async () => {
    const res = await refusals.refuseSharedTarget(orgAdmin, target, request, "ban");
    await expectForbidden(res);
    expect(auditMock).toHaveBeenCalledWith({
      eventType: "admin.user.action_denied",
      outcome: "denied",
      actorBetterAuthUserId: "ba-actor",
      appUserId: "u-shared",
      organizationId: "o-1",
      email: "s@x.com",
      reason: "shared_target_requires_superadmin",
      request,
      requestId: "req-1",
      metadata: { action: "ban", targetBetterAuthUserId: "ba-shared" },
    });
  });

  it("writes under the rank guard's event, so one filter lists every refused action on a user", async () => {
    const { TARGET_OUTRANKS_ACTOR_EVENT } = await import("@/lib/admin/user-target.server");
    expect(refusals.USER_ACTION_DENIED_EVENT).toBe(TARGET_OUTRANKS_ACTOR_EVENT);
  });

  it("an org-bound credential's refusal is stamped with its bound org", async () => {
    const bound = {
      ...orgAdmin,
      access: { permissions: ["superuser"], organizationId: "o-bound", orgBound: true },
    };
    await refusals.refuseSharedTarget(bound, target, request, "password");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "o-bound" }));
  });
});

describe("refuseWithoutCrossOrgReach (superadmin-only actions)", () => {
  it("audits administrator.access.denied with cross_org_reach_required and the action", async () => {
    const res = await refusals.refuseWithoutCrossOrgReach(orgAdmin, request, "user_role_set", {
      requestedTargetId: "11111111-1111-4111-8111-111111111101",
    });
    await expectForbidden(res);
    expect(auditMock).toHaveBeenCalledWith({
      eventType: "administrator.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: "ba-actor",
      organizationId: "o-1",
      email: null,
      reason: "cross_org_reach_required",
      request,
      requestId: "req-1",
      metadata: {
        action: "user_role_set",
        requestedTargetId: "11111111-1111-4111-8111-111111111101",
      },
    });
  });

  it("records the action alone when the caller sent nothing else", async () => {
    await refusals.refuseWithoutCrossOrgReach(orgAdmin, request, "permission_create");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { action: "permission_create" } }),
    );
  });

  it("records the address the request named, so the explorer finds the row by email", async () => {
    await refusals.refuseWithoutCrossOrgReach(
      orgAdmin,
      request,
      "user_create",
      { role: "admin" },
      "new@x.com",
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new@x.com",
        metadata: { action: "user_create", role: "admin" },
      }),
    );
  });
});

describe("boundedRequestList (F-15: a refusal row cannot park kilobytes)", () => {
  it("keeps the first REFUSAL_LIST_MAX distinct entries and counts every distinct one", () => {
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i % 250}`);
    const bounded = refusals.boundedRequestList(ids);
    expect(refusals.REFUSAL_LIST_MAX).toBe(20);
    expect(bounded.ids).toEqual(Array.from({ length: 20 }, (_, i) => `id-${i}`));
    expect(bounded.count).toBe(250);
  });

  it("records a short list whole", () => {
    expect(refusals.boundedRequestList(["a", "b", "a"])).toEqual({ ids: ["a", "b"], count: 2 });
  });
});

describe("a refusal whose row cannot be written", () => {
  it("surfaces the audit failure instead of returning the 403 without its row", async () => {
    auditMock.mockRejectedValueOnce(new Error("audit insert failed"));
    await expect(
      refusals.refuseWithoutCrossOrgReach(orgAdmin, request, "organization_create"),
    ).rejects.toThrow("audit insert failed");
  });
});
