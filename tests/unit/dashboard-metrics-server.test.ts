import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DashboardModule from "@/lib/admin/dashboard-metrics.server";
import type * as MetricsServer from "@/lib/admin/metrics.server";

/**
 * RBAC scoping for `selectDashboardMetrics` — the single function that both
 * GET /api/administrator/metrics and the server-rendered dashboard use to
 * decide what a caller may see. The metric query layer is mocked; the REAL
 * `isSuperadmin`/`resolveOrgScope` decide scope from the crafted access
 * context. Contract:
 *   - SUPERADMIN → system-wide series + most-active-orgs, by the marker alone
 *     (no explicit per-area permission needed).
 *   - ORG ADMIN  → only their org's series; never system data or other orgs.
 *   - registrations need `admin.users.read`, logins need `admin.audit.read`
 *     (so the dashboard, reachable with any admin permission, shows nothing it
 *     shouldn't).
 */
const signupsPerOrg = vi.fn();
const dailyRegistrations = vi.fn();
const dailyLogins = vi.fn();
const dailyAuditEvents = vi.fn();

vi.mock("@/lib/admin/metrics.server", async (orig) => {
  const actual = await orig<typeof MetricsServer>();
  return {
    ...actual,
    signupsPerOrg: (...a: unknown[]) => signupsPerOrg(...a),
    dailyRegistrations: (...a: unknown[]) => dailyRegistrations(...a),
    dailyLogins: (...a: unknown[]) => dailyLogins(...a),
    dailyAuditEvents: (...a: unknown[]) => dailyAuditEvents(...a),
  };
});

let selectDashboardMetrics: typeof DashboardModule.selectDashboardMetrics;

const access = (permissions: string[], organizationId: string | null) => ({
  permissions,
  organizationId,
});

beforeEach(async () => {
  for (const m of [signupsPerOrg, dailyRegistrations, dailyLogins, dailyAuditEvents]) m.mockReset();
  signupsPerOrg.mockResolvedValue([{ organizationId: "o-1", name: "Acme", count: 5 }]);
  dailyRegistrations.mockResolvedValue([{ date: "2026-06-17", count: 1 }]);
  dailyLogins.mockResolvedValue([{ date: "2026-06-17", count: 2 }]);
  dailyAuditEvents.mockResolvedValue([{ date: "2026-06-17", count: 9 }]);
  ({ selectDashboardMetrics } = await import("@/lib/admin/dashboard-metrics.server"));
});
afterEach(() => vi.resetModules());

describe("selectDashboardMetrics", () => {
  it("SUPERADMIN sees system-wide series + most-active-orgs by the marker alone", async () => {
    const result = await selectDashboardMetrics(access(["superuser"], "o-self"));

    expect(result.scope).toBe("system");
    expect(result.organizationId).toBeNull();
    expect(result.mostActiveOrgs).toHaveLength(1);
    expect(result.registrationsDaily).toBeDefined();
    // The superuser marker implies every capability, so logins + total audit
    // volume appear even without an explicit admin.audit.read entry.
    expect(result.loginsDaily).toBeDefined();
    expect(result.auditEventsDaily).toBeDefined();
    expect(dailyRegistrations).toHaveBeenCalledWith();
    expect(dailyLogins).toHaveBeenCalledWith();
    expect(dailyAuditEvents).toHaveBeenCalledWith();
  });

  it("ORG ADMIN is confined to their org — never cross-org data", async () => {
    const result = await selectDashboardMetrics(
      access(["admin.users.read", "admin.audit.read"], "org-7"),
    );

    expect(result.scope).toBe("organization");
    expect(result.organizationId).toBe("org-7");
    expect(result.mostActiveOrgs).toBeUndefined();
    expect(dailyRegistrations).toHaveBeenCalledWith("org-7");
    expect(dailyLogins).toHaveBeenCalledWith("org-7");
    expect(signupsPerOrg).not.toHaveBeenCalled();
    // Total audit volume is SUPERADMIN-only — an org admin never gets it, even
    // holding admin.audit.read (which grants them the org-scoped logins series).
    expect(result.auditEventsDaily).toBeUndefined();
    expect(dailyAuditEvents).not.toHaveBeenCalled();
  });

  it("omits logins for an org admin without admin.audit.read", async () => {
    const result = await selectDashboardMetrics(access(["admin.users.read"], "org-7"));

    expect(result.registrationsDaily).toBeDefined();
    expect(result.loginsDaily).toBeUndefined();
    expect(dailyLogins).not.toHaveBeenCalled();
  });

  it("shows no series to an admin who lacks both read permissions", async () => {
    // The dashboard is reachable with ANY admin permission (e.g. orgs.read),
    // so a caller without users.read / audit.read must get an empty series set.
    const result = await selectDashboardMetrics(access(["admin.orgs.read"], "org-7"));

    expect(result.scope).toBe("organization");
    expect(result.organizationId).toBe("org-7");
    expect(result.registrationsDaily).toBeUndefined();
    expect(result.loginsDaily).toBeUndefined();
    expect(dailyRegistrations).not.toHaveBeenCalled();
    expect(dailyLogins).not.toHaveBeenCalled();
  });

  it("returns an empty payload when an org admin has no resolvable org", async () => {
    const result = await selectDashboardMetrics(access(["admin.users.read"], null));

    expect(result.scope).toBe("organization");
    expect(result.organizationId).toBeNull();
    expect(result.registrationsDaily).toBeUndefined();
    expect(dailyRegistrations).not.toHaveBeenCalled();
  });
});
