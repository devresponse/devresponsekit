import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

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
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return {
    ...actual,
    getUserAccessContext: (id: string) => accessGetter(id),
  };
});
vi.mock("@/lib/audit.server", () => ({
  auditEvent: (...args: unknown[]) => auditMock(...args),
}));
// The CSRF origin guard short-circuits under NODE_ENV=test, so its deny
// branch inside requireAdminPermission is only reachable through a mock
// (review #122 — the untrusted-origin denial path had no coverage).
const originCheck = vi.fn();
vi.mock("@/lib/admin/origin-guard.server", () => ({
  checkTrustedOrigin: (...a: unknown[]) => originCheck(...a),
}));

function makeRequest(headers?: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  originCheck.mockReset().mockReturnValue({ ok: true });
});
afterEach(() => vi.resetModules());

describe("requireAdminPermission — trusted-origin CSRF gate (review #122)", () => {
  async function load() {
    return await import("@/lib/admin/permissions.server");
  }

  it("denies an untrusted cookie origin with 403 + a denied audit row BEFORE resolving the caller", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "untrusted_origin" });
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(isAdminPermissionDenial(result)).toBe(true);
    if (isAdminPermissionDenial(result)) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as { error: string; requestId: string };
      expect(body.error).toBe("untrusted_origin");
      // The 403 and the audit row share one correlation id.
      expect(result.response.headers.get("x-request-id")).toBe(body.requestId);
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "administrator.access.denied",
          outcome: "denied",
          reason: "untrusted_origin",
          requestId: body.requestId,
          metadata: { required: ["admin.users.read"] },
        }),
      );
    }
    // No DB round-trip for a cross-origin probe.
    expect(sessionGetter).not.toHaveBeenCalled();
    expect(accessGetter).not.toHaveBeenCalled();
  });

  it("falls back to the cataloged `untrusted_origin` reason when the guard gives none", async () => {
    originCheck.mockReturnValue({ ok: false });
    const { requireAdminPermission } = await load();
    await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "untrusted_origin" }),
    );
  });

  it("skips the origin guard for a bearer credential (a token cannot be attached cross-site)", async () => {
    originCheck.mockReturnValue({ ok: false, reason: "missing_origin" });
    sessionGetter.mockResolvedValue(null);
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    // Bearer path with both machine-credential flags off in the test env →
    // the resolver yields no caller, so the guard reaches its 401 — proving
    // it went PAST the origin check rather than 403ing on it.
    const result = await requireAdminPermission(
      makeRequest({ authorization: "Bearer drk_test_x.secret" }),
      "admin.users.read",
    );
    expect(originCheck).not.toHaveBeenCalled();
    expect(isAdminPermissionDenial(result)).toBe(true);
    if (isAdminPermissionDenial(result)) {
      expect(result.response.status).toBe(401);
    }
    expect(auditMock).not.toHaveBeenCalled();
  });
});

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
        metadata: expect.objectContaining({ required: ["admin.users.read"] }),
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

  it("grants a SUPERADMIN any admin permission via short-circuit, even without the specific key", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "su@x.com",
      status: "active",
      organizationId: "o-member",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["superuser"], // global superuser; no admin.* keys in the active org
    });
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.users.read");
    expect(isAdminPermissionDenial(result)).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("ADMIN_PERMISSION_CATALOG", () => {
  it("has 35 entries with unique keys (docs/admin-manager.md §6.1 + email + credential + group governance)", async () => {
    // Import from the canonical, non-server-only source so the test
    // asserts the source of truth rather than the re-export surface.
    const { ADMIN_PERMISSION_CATALOG } = await import("@/lib/admin/permissions");
    expect(ADMIN_PERMISSION_CATALOG).toHaveLength(35);
    const keys = new Set(ADMIN_PERMISSION_CATALOG.map((p) => p.key));
    expect(keys.size).toBe(35);
    // Spot-check a representative sample.
    expect(keys.has("admin.users.read")).toBe(true);
    expect(keys.has("admin.users.impersonate")).toBe(true);
    expect(keys.has("admin.audit.read")).toBe(true);
    expect(keys.has("admin.permissions.manage")).toBe(true);
    expect(keys.has("admin.email.read")).toBe(true);
    expect(keys.has("admin.email.manage")).toBe(true);
    // Credential-governance keys (design docs/design-api-keys-and-tokens.md §9).
    expect(keys.has("admin.apikeys.read")).toBe(true);
    expect(keys.has("admin.apikeys.manage")).toBe(true);
    expect(keys.has("admin.clients.read")).toBe(true);
    expect(keys.has("admin.clients.manage")).toBe(true);
    // Group-governance keys (ADR-0002).
    expect(keys.has("admin.groups.read")).toBe(true);
    expect(keys.has("admin.groups.create")).toBe(true);
    expect(keys.has("admin.groups.update")).toBe(true);
    expect(keys.has("admin.groups.delete")).toBe(true);
    expect(keys.has("admin.groups.assign")).toBe(true);
  });

  it("is re-exported by permissions.server for callers that need it via the helper module", async () => {
    const direct = await import("@/lib/admin/permissions");
    const reexport = await import("@/lib/admin/permissions.server");
    expect(reexport.ADMIN_PERMISSION_CATALOG).toBe(direct.ADMIN_PERMISSION_CATALOG);
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

  it("grants a SUPERADMIN any admin permission via short-circuit", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "su@x.com",
      status: "active",
      organizationId: "o-member",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["superuser"], // no admin.* keys in the active org
    });
    const { checkAdminPermissionServer } = await load();
    const result = await checkAdminPermissionServer("admin.users.read");
    expect(result).not.toBe("denied");
    expect(result).not.toBe("unauthenticated");
  });
});
