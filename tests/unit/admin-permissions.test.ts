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

// `checkAdminPermissionServer` has no request object: it reads the ambient
// header store for the audit row it now writes on a denial (review #74).
const ambient = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => ambient.headers }));

function makeRequest(headers?: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  originCheck.mockReset().mockReturnValue({ ok: true });
  ambient.headers = new Headers();
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

  it("carries the session the caller authenticated with into the grant (F-10)", async () => {
    // An issuing route re-checks it behind the issuance fence.
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" }, session: { id: "sess-1" } });
    accessGetter.mockResolvedValue({
      appUserId: "u-1",
      primaryEmail: "admin@x.com",
      status: "active",
      organizationId: "o-1",
      membershipStatus: "active",
      preferredLocale: "en",
      permissions: ["admin.apikeys.manage", "shell.view"],
    });
    const { requireAdminPermission, isAdminPermissionDenial } = await load();
    const result = await requireAdminPermission(makeRequest(), "admin.apikeys.manage");
    expect(isAdminPermissionDenial(result)).toBe(false);
    if (!isAdminPermissionDenial(result)) {
      expect(result.source).toEqual({ kind: "session", sessionId: "sess-1" });
    }
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

/**
 * Review #74 - the route-handler path has always audited its denials, but the
 * RSC path (the one an operator walks into by typing a URL) silently
 * `notFound()`d, so a probe of `/app/administrator/*` left no trace while the
 * equivalent `fetch` of `/api/administrator/*` left one. Denied navigation is
 * explicitly in the audit contract (docs/admin-manager.md 12).
 */
describe("checkAdminPermissionServer - denials are audited (review #74)", () => {
  async function load() {
    return await import("@/lib/admin/permissions.server");
  }

  const ACTIVE_READER = {
    appUserId: "u-1",
    primaryEmail: "x@x.com",
    status: "active",
    organizationId: "o-1",
    membershipStatus: "active",
    preferredLocale: "en",
    permissions: ["admin.users.read"],
  };

  it("writes the same administrator.access.denied row the route path writes", async () => {
    ambient.headers = new Headers({ "x-drk-pathname": "/en/app/administrator/audit" });
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_READER);

    const { checkAdminPermissionServer } = await load();
    expect(await checkAdminPermissionServer("admin.audit.read")).toBe("denied");

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "administrator.access.denied",
        outcome: "denied",
        actorBetterAuthUserId: "ba-1",
        reason: "missing_admin_permission",
        metadata: expect.objectContaining({
          required: ["admin.audit.read"],
          surface: "rsc",
          path: "/en/app/administrator/audit",
        }),
      }),
    );
  });

  it("audits a status/membership denial with the blocking decision as the reason", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({ ...ACTIVE_READER, status: "suspended" });

    const { checkAdminPermissionServer } = await load();
    expect(await checkAdminPermissionServer("admin.users.read")).toBe("denied");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied", reason: "blocked" }),
    );
  });

  it("writes ONE row per request even though the layout and page both guard", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_READER);

    const { checkAdminPermissionServer } = await load();
    await checkAdminPermissionServer("admin.audit.read");
    await checkAdminPermissionServer("admin.audit.read");
    await checkAdminPermissionServer("admin.audit.read");
    expect(auditMock).toHaveBeenCalledTimes(1);

    // A genuinely different denial in the same request is still recorded.
    await checkAdminPermissionServer("admin.orgs.read");
    expect(auditMock).toHaveBeenCalledTimes(2);

    // ...and the next request (new headers object) starts a fresh ledger.
    ambient.headers = new Headers();
    await checkAdminPermissionServer("admin.audit.read");
    expect(auditMock).toHaveBeenCalledTimes(3);
  });

  it("writes NOTHING when there is no session (no actor to attribute)", async () => {
    sessionGetter.mockResolvedValue(null);
    const { checkAdminPermissionServer } = await load();
    expect(await checkAdminPermissionServer("admin.users.read")).toBe("unauthenticated");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("writes NOTHING on a grant", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_READER);
    const { checkAdminPermissionServer } = await load();
    expect(await checkAdminPermissionServer("admin.users.read")).not.toBe("denied");
    expect(auditMock).not.toHaveBeenCalled();
  });

  /**
   * The dedupe key is `${reason}|${required}`, so it suppresses a REPEAT of
   * the SAME guard — not a layout+page navigation. The administrator layout
   * guards on `[...ANY_ADMIN_PERMISSION]` while each page guards on a single
   * key, so the two denials carry different required sets and legitimately
   * write one row each. The docstring used to promise "ONE row, not three"
   * for exactly this sequence, which is the only one that actually happens;
   * this pins the real behaviour.
   */
  it("writes one row for the LAYOUT guard and one for the PAGE guard (different facts)", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({ ...ACTIVE_READER, permissions: [] });

    const { checkAdminPermissionServer, ANY_ADMIN_PERMISSION } = await load();
    // The real navigation: the layout guard first, then the page it wraps.
    expect(await checkAdminPermissionServer([...ANY_ADMIN_PERMISSION])).toBe("denied");
    expect(await checkAdminPermissionServer("admin.audit.read")).toBe("denied");

    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      metadata: expect.objectContaining({ required: [...ANY_ADMIN_PERMISSION] }),
    });
    expect(auditMock.mock.calls[1]?.[0]).toMatchObject({
      metadata: expect.objectContaining({ required: ["admin.audit.read"] }),
    });
    // ...and the layout guard re-running under the not-found boundary — the
    // case the dedupe DOES cover — adds nothing.
    await checkAdminPermissionServer([...ANY_ADMIN_PERMISSION]);
    expect(auditMock).toHaveBeenCalledTimes(2);
  });

  /**
   * `x-drk-pathname` is client-reachable on any path the proxy matcher does
   * not cover, and this row lands in an append-only, trigger-protected table
   * — so the value is shape-bounded before it is stored (the #74 follow-up
   * finding: it used to be read raw and written verbatim).
   */
  it("records null for a forged pathname that is not a path", async () => {
    ambient.headers = new Headers({ "x-drk-pathname": "not a path <script>alert(1)</script>" });
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_READER);

    const { checkAdminPermissionServer } = await load();
    await checkAdminPermissionServer("admin.audit.read");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ path: null }) }),
    );
  });

  it("records null rather than parking a kilobyte-long forged value in the audit row", async () => {
    ambient.headers = new Headers({ "x-drk-pathname": "/" + "a".repeat(4096) });
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_READER);

    const { checkAdminPermissionServer } = await load();
    await checkAdminPermissionServer("admin.audit.read");
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ path: null }) }),
    );
  });
});
