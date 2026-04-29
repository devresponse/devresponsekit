import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthStatusModule from "@/lib/auth-status";
import type { NextRequest } from "next/server";

/**
 * Route integration tests for the three navigation menu APIs (§29.6.9):
 *   - GET /api/navigation/applications
 *   - GET /api/navigation/shell-menu
 *   - GET /api/navigation/nested-apps
 *
 * All three share the same auth/permission contract: 401 when there is
 * no session, 403 (audited as `navigation.menu.denied`) when the access
 * decision is anything other than `allow`, 400 for invalid query, and
 * 200 with a `NavigationMenuResponse` envelope on success.
 */

const sessionGetter = vi.fn();
const accessGetter = vi.fn();
const auditMock = vi.fn();
const loadApplicationsMenu = vi.fn();
const loadShellMenu = vi.fn();
const loadNestedAppsMenu = vi.fn();

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
vi.mock("@/lib/navigation.server", () => ({
  loadApplicationsMenu: (...args: unknown[]) => loadApplicationsMenu(...args),
  loadShellMenu: (...args: unknown[]) => loadShellMenu(...args),
  loadNestedAppsMenu: (...args: unknown[]) => loadNestedAppsMenu(...args),
}));

function makeRequest(url: string): NextRequest {
  const u = new URL(url);
  return { nextUrl: u, url: u.toString(), headers: new Headers() } as unknown as NextRequest;
}

const ACTIVE_ACCESS = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  permissions: ["shell.view"],
};

const PENDING_ACCESS = {
  ...ACTIVE_ACCESS,
  status: "pending_approval" as const,
  membershipStatus: "pending_approval" as const,
};

beforeEach(() => {
  sessionGetter.mockReset();
  accessGetter.mockReset();
  auditMock.mockReset();
  loadApplicationsMenu.mockReset();
  loadShellMenu.mockReset();
  loadNestedAppsMenu.mockReset();
});
afterEach(() => vi.resetModules());

describe("GET /api/navigation/applications", () => {
  async function call(url: string) {
    const { GET } = await import("@/app/api/navigation/applications/route");
    return GET(makeRequest(url));
  }

  it("returns 401 unauthenticated", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await call("http://localhost/api/navigation/applications?locale=en");
    expect(res.status).toBe(401);
  });

  it("returns 403 and audits a denied attempt for non-allowed users", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(PENDING_ACCESS);
    const res = await call("http://localhost/api/navigation/applications?locale=en");
    expect(res.status).toBe(403);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "navigation.menu.denied",
        outcome: "denied",
        reason: "pending_approval",
      }),
    );
  });

  it("returns 200 with the menu envelope for active users", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_ACCESS);
    loadApplicationsMenu.mockResolvedValue({
      menuId: "applications",
      kind: "applications",
      locale: "en",
      generatedAt: "2026-01-01T00:00:00Z",
      items: [],
    });
    const res = await call("http://localhost/api/navigation/applications?locale=en");
    expect(res.status).toBe(200);
    expect(loadApplicationsMenu).toHaveBeenCalledWith(ACTIVE_ACCESS, "en");
  });

  it("falls back to default locale for unsupported locale", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_ACCESS);
    loadApplicationsMenu.mockResolvedValue({
      menuId: "applications",
      kind: "applications",
      locale: "en",
      generatedAt: "x",
      items: [],
    });
    await call("http://localhost/api/navigation/applications?locale=zz");
    expect(loadApplicationsMenu).toHaveBeenCalledWith(ACTIVE_ACCESS, "en");
  });
});

describe("GET /api/navigation/shell-menu", () => {
  async function call(url: string) {
    const { GET } = await import("@/app/api/navigation/shell-menu/route");
    return GET(makeRequest(url));
  }

  it("returns 400 when scope is missing", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    const res = await call("http://localhost/api/navigation/shell-menu?locale=en");
    expect(res.status).toBe(400);
  });

  it("returns 200 with the filtered menu", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_ACCESS);
    loadShellMenu.mockResolvedValue({
      menuId: "shell-menu:primary",
      kind: "shell-menu",
      locale: "en",
      generatedAt: "x",
      items: [],
    });
    const res = await call("http://localhost/api/navigation/shell-menu?scope=primary&locale=en");
    expect(res.status).toBe(200);
    expect(loadShellMenu).toHaveBeenCalledWith(ACTIVE_ACCESS, "primary", "en");
  });

  it("returns 403 for blocked users", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue({ ...ACTIVE_ACCESS, status: "blocked" as const });
    const res = await call("http://localhost/api/navigation/shell-menu?scope=primary");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/navigation/nested-apps", () => {
  async function call(url: string) {
    const { GET } = await import("@/app/api/navigation/nested-apps/route");
    return GET(makeRequest(url));
  }

  it("returns 400 without applicationId", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    const res = await call("http://localhost/api/navigation/nested-apps?locale=en");
    expect(res.status).toBe(400);
  });

  it("returns 401 without a session", async () => {
    sessionGetter.mockResolvedValue(null);
    const res = await call("http://localhost/api/navigation/nested-apps?applicationId=portal");
    expect(res.status).toBe(401);
  });

  it("returns 200 with the nested-apps envelope", async () => {
    sessionGetter.mockResolvedValue({ user: { id: "ba-1" } });
    accessGetter.mockResolvedValue(ACTIVE_ACCESS);
    loadNestedAppsMenu.mockResolvedValue({
      menuId: "nested-apps:portal",
      kind: "nested-apps",
      locale: "en",
      generatedAt: "x",
      items: [],
    });
    const res = await call(
      "http://localhost/api/navigation/nested-apps?applicationId=portal&locale=en",
    );
    expect(res.status).toBe(200);
    expect(loadNestedAppsMenu).toHaveBeenCalledWith(ACTIVE_ACCESS, "portal", "en");
  });
});
