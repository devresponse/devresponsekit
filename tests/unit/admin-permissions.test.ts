import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Unit tests for the centralized `requireAdminPermission` helper
 * (docs/admin-manager.md §5.3 + §6.2). Pins the four authorization
 * outcomes — unauthenticated, blocked status, missing permission,
 * granted — and the audit emission for the missing-permission path.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
  getCurrentSession: () => sessionGetter(),
}));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-status")>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));

function makeRequest(): NextRequest {
  return { headers: new Headers() } as unknown as NextRequest;
}

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
});
afterEach(() => vi.resetModules());

describe("requireAdminPermission", () => {
  async function load() {
    return await import("@/lib/admin/permissions.server");
  }

  it("returns 401 when not authenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(isAdminPermissionDenial(result)).toBe(true);
    if (isAdminPermissionDenial(result)) {
      expect(result.response.status).toBe(401);
    }
  });

  it("returns 403 when user is blocked", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "blocked",
      organizationId: "o-1",
      membershipStatus: "blocked",
      preferredLocale: "en",
      permissions: ["admin.users.read"],
    });
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(isAdminPermissionDenial(result)).toBe(true);
    if (isAdminPermissionDenial(result)) {
      expect(result.response.status).toBe(403);
    }
    // No audit on status-block: we don't want to spam the audit log on
    // every single page navigation by a blocked user.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("returns 403 AND audits when permission is missing", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["shell.view"],
    });
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(isAdminPermissionDenial(result)).toBe(true);
    if (isAdminPermissionDenial(result)) {
      expect(result.response.status).toBe(403);
    }
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        actorBetterAuthUserId: "ba-1",
        reason: "missing_admin_permission",
        metadata: { required: ["admin.users.read"] },
      }),
    );
  });

  it("returns the access context on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    const ctx = {
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.read", "shell.view"],
    };
    accessGetter.mockResolvedValue(ctx);
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(isAdminPermissionDenial(result)).toBe(false);
    if (!isAdminPermissionDenial(result)) {
      expect(result.betterAuthUserId).toBe("ba-1");
      expect(result.access).toEqual(ctx);
    }
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("treats an array of permissions as 'any one matches'", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.audit.read"],
    });
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), [
      "admin.users.read",
      "admin.audit.read",
    ]);
    expect(isAdminPermissionDenial(result)).toBe(false);
  });
});

describe("ADMIN_PERMISSION_CATALOG", () => {
  it("has 24 entries with unique keys (plan §6.1)", async () => {
    const { ADMIN_PERMISSION_CATALOG } = await import("@/lib/admin/permissions.server");
    expect(ADMIN_PERMISSION_CATALOG).toHaveLength(24);
    const keys = new Set(ADMIN_PERMISSION_CATALOG.map((p) => p.key));
    expect(keys.size).toBe(24);
    // Spot-check a representative sample.
    expect(keys.has("admin.users.read")).toBe(true);
    expect(keys.has("admin.users.impersonate")).toBe(true);
    expect(keys.has("admin.audit.read")).toBe(true);
    expect(keys.has("admin.permissions.manage")).toBe(true);
  });
});

describe("checkAdminPermissionServer", () => {
  async function load() {
    return await import("@/lib/admin/permissions.server");
  }

  it("returns 'unauthenticated' when no session", async () => {
    sessionGetter.mockResolvedValue(null);
    const { checkAdminPermissionServer } = await load();
    expect(await checkAdminPermissionServer("admin.users.read")).toBe("unauthenticated");
  });

  it("returns 'denied' for status-blocked users", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "suspended",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.read"],
    });
    const { checkAdminPermissionServer } = await load();
    expect(await checkAdminPermissionServer("admin.users.read")).toBe("denied");
  });

  it("returns a grant on success", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "x@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.users.read"],
    });
    const { checkAdminPermissionServer } = await load();
    const result = await checkAdminPermissionServer("admin.users.read");
    expect(result).not.toBe("denied");
    expect(result).not.toBe("unauthenticated");
    if (typeof result === "object") {
      expect(result.betterAuthUserId).toBe("ba-1");
    }
  });
});
