import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import type * as MetricsRoute from "@/app/api/administrator/metrics/route";
import type * as MetricsServer from "@/lib/admin/metrics.server";

/**
 * RBAC scoping for GET /api/administrator/metrics. The guard and the metrics
 * query layer are mocked; the REAL `isSuperadmin`/`resolveOrgScope` decide
 * scope from the crafted access context. The contract under test:
 *   - SUPERADMIN → system metrics + most-active-orgs.
 *   - ORG ADMIN  → only their org's series; never system data or other orgs.
 *   - logins require admin.audit.read.
 */
const guardResult = vi.fn();
const signupsPerOrg = vi.fn();
const dailyRegistrations = vi.fn();
const dailyLogins = vi.fn();

vi.mock("@/lib/admin/permissions.server", () => ({
  requireAdminPermission: async () => guardResult(),
  isAdminPermissionDenial: (g: unknown) => (g as { denied?: boolean })?.denied === true,
}));
vi.mock("@/lib/admin/metrics.server", async (orig) => {
  const actual = await orig<typeof MetricsServer>();
  return {
    ...actual,
    signupsPerOrg: (...a: unknown[]) => signupsPerOrg(...a),
    dailyRegistrations: (...a: unknown[]) => dailyRegistrations(...a),
    dailyLogins: (...a: unknown[]) => dailyLogins(...a),
  };
});

let GET: typeof MetricsRoute.GET;
const req = {} as NextRequest;

function access(permissions: string[], organizationId: string | null) {
  return { permissions, organizationId };
}

beforeEach(async () => {
  for (const m of [guardResult, signupsPerOrg, dailyRegistrations, dailyLogins]) m.mockReset();
  signupsPerOrg.mockResolvedValue([{ organizationId: "o-1", name: "Acme", count: 5 }]);
  dailyRegistrations.mockResolvedValue([{ date: "2026-06-17", count: 1 }]);
  dailyLogins.mockResolvedValue([{ date: "2026-06-17", count: 2 }]);
  ({ GET } = await import("@/app/api/administrator/metrics/route"));
});
afterEach(() => vi.resetModules());

describe("GET /api/administrator/metrics", () => {
  it("returns the denial response when the guard denies", async () => {
    guardResult.mockReturnValue({ denied: true, response: new Response(null, { status: 403 }) });
    const res = await GET(req);
    expect(res.status).toBe(403);
    expect(dailyRegistrations).not.toHaveBeenCalled();
  });

  it("SUPERADMIN gets system-wide metrics + most-active-orgs", async () => {
    guardResult.mockReturnValue({
      access: access(["superuser", "admin.users.read", "admin.audit.read"], "o-self"),
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.scope).toBe("system");
    expect(body.organizationId).toBeNull();
    expect(body.mostActiveOrgs).toHaveLength(1);
    expect(body.registrationsDaily).toBeDefined();
    expect(body.loginsDaily).toBeDefined();
    // System-wide → called with NO org id.
    expect(dailyRegistrations).toHaveBeenCalledWith();
    expect(dailyLogins).toHaveBeenCalledWith();
  });

  it("ORG ADMIN gets only their org's series — never system data or most-active-orgs", async () => {
    guardResult.mockReturnValue({
      access: access(["admin.users.read", "admin.audit.read"], "org-7"),
    });
    const res = await GET(req);
    const body = await res.json();
    expect(body.scope).toBe("organization");
    expect(body.organizationId).toBe("org-7");
    expect(body.mostActiveOrgs).toBeUndefined();
    // Org-scoped → called WITH their org id, not the system (no-arg) form.
    expect(dailyRegistrations).toHaveBeenCalledWith("org-7");
    expect(dailyLogins).toHaveBeenCalledWith("org-7");
    expect(signupsPerOrg).not.toHaveBeenCalled();
  });

  it("omits logins for a caller without admin.audit.read", async () => {
    guardResult.mockReturnValue({ access: access(["admin.users.read"], "org-7") });
    const res = await GET(req);
    const body = await res.json();
    expect(body.registrationsDaily).toBeDefined();
    expect(body.loginsDaily).toBeUndefined();
    expect(dailyLogins).not.toHaveBeenCalled();
  });

  it("returns an empty org payload when an org admin has no resolvable org", async () => {
    guardResult.mockReturnValue({ access: access(["admin.users.read"], null) });
    const res = await GET(req);
    const body = await res.json();
    expect(body.scope).toBe("organization");
    expect(body.organizationId).toBeNull();
    expect(body.registrationsDaily).toBeUndefined();
    expect(dailyRegistrations).not.toHaveBeenCalled();
  });
});
