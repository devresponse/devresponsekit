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

const UTC = { timeZone: "UTC" };

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
    // No zone asked for → UTC days (what the JSON API reports).
    expect(dailyRegistrations).toHaveBeenCalledWith(undefined, UTC);
    expect(dailyLogins).toHaveBeenCalledWith(undefined, UTC);
    expect(dailyAuditEvents).toHaveBeenCalledWith(UTC);
    expect(signupsPerOrg).toHaveBeenCalledWith(UTC);
  });

  it("ORG ADMIN is confined to their org — never cross-org data", async () => {
    const result = await selectDashboardMetrics(
      access(["admin.users.read", "admin.audit.read"], "org-7"),
    );

    expect(result.scope).toBe("organization");
    expect(result.organizationId).toBe("org-7");
    expect(result.mostActiveOrgs).toBeUndefined();
    expect(dailyRegistrations).toHaveBeenCalledWith("org-7", UTC);
    expect(dailyLogins).toHaveBeenCalledWith("org-7", UTC);
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

  /**
   * MACHINE-2. An ORG-BOUND bearer credential owned by a global superuser
   * carries the FULL superuser permission set (`getUserAccessContext` expands
   * the marker on the bound path too), so the only thing separating it from a
   * platform-wide report is the `hasCrossOrgReach` gate on the system branch.
   * Reverting that gate to `isSuperadmin` must fail here — otherwise a key
   * minted in one tenant reports every tenant's signups, registrations, logins
   * and audit volume through `GET /api/administrator/metrics`.
   */
  it("MACHINE-2: an ORG-BOUND superuser credential gets its OWN org, not the platform", async () => {
    const result = await selectDashboardMetrics({
      permissions: ["superuser", "admin.users.read", "admin.audit.read"],
      organizationId: "org-bound",
      orgBound: true,
    });

    expect(result.scope).toBe("organization");
    expect(result.organizationId).toBe("org-bound");
    expect(result.mostActiveOrgs).toBeUndefined();
    expect(signupsPerOrg).not.toHaveBeenCalled();
    // The per-series CAPABILITY questions still resolve via the marker, so the
    // credential does see its own tenant's numbers — scoped, never system-wide.
    expect(dailyRegistrations).toHaveBeenCalledWith("org-bound", UTC);
    expect(dailyLogins).toHaveBeenCalledWith("org-bound", UTC);
    // Total audit volume has no org-scoped variant: a bound credential, like an
    // org admin, never receives it.
    expect(result.auditEventsDaily).toBeUndefined();
    expect(dailyAuditEvents).not.toHaveBeenCalled();
  });

  it("MACHINE-2: an ORG-BOUND superuser credential with no resolvable org gets NOTHING", async () => {
    const result = await selectDashboardMetrics({
      permissions: ["superuser"],
      organizationId: null,
      orgBound: true,
    });

    expect(result.scope).toBe("organization");
    expect(result.organizationId).toBeNull();
    expect(signupsPerOrg).not.toHaveBeenCalled();
    expect(dailyRegistrations).not.toHaveBeenCalled();
    expect(dailyLogins).not.toHaveBeenCalled();
  });
});

/**
 * F-37: the Administrator overview asks for the viewer's zone, so its daily
 * charts count the same calendar days its activity lists show. Every series
 * of one payload must use that ONE zone, and a zone the database does not know
 * must cost the viewer UTC days, not the page.
 */
describe("selectDashboardMetrics — the days' time zone (F-37)", () => {
  const KATHMANDU = { timeZone: "Asia/Kathmandu" };

  it("hands the requested zone to every system series", async () => {
    await selectDashboardMetrics(access(["superuser"], "o-self"), KATHMANDU);

    expect(signupsPerOrg).toHaveBeenCalledWith(KATHMANDU);
    expect(dailyRegistrations).toHaveBeenCalledWith(undefined, KATHMANDU);
    expect(dailyLogins).toHaveBeenCalledWith(undefined, KATHMANDU);
    expect(dailyAuditEvents).toHaveBeenCalledWith(KATHMANDU);
  });

  it("hands the requested zone to an org admin's series", async () => {
    await selectDashboardMetrics(
      access(["admin.users.read", "admin.audit.read"], "org-7"),
      KATHMANDU,
    );

    expect(dailyRegistrations).toHaveBeenCalledWith("org-7", KATHMANDU);
    expect(dailyLogins).toHaveBeenCalledWith("org-7", KATHMANDU);
  });

  it("falls back to UTC days when Postgres does not know the zone (22023)", async () => {
    const unknownZone = Object.assign(new Error('time zone "Asia/Kathmandu" not recognized'), {
      code: "22023",
    });
    dailyRegistrations.mockImplementation(async (_org: unknown, range: { timeZone: string }) => {
      if (range.timeZone !== "UTC") throw unknownZone;
      return [{ date: "2026-06-17", count: 1 }];
    });

    const result = await selectDashboardMetrics(access(["superuser"], "o-self"), KATHMANDU);

    expect(result.registrationsDaily).toEqual([{ date: "2026-06-17", count: 1 }]);
    // The retry asks for UTC for EVERY series, so one payload is one calendar.
    expect(dailyRegistrations).toHaveBeenLastCalledWith(undefined, UTC);
    expect(dailyLogins).toHaveBeenLastCalledWith(undefined, UTC);
    expect(dailyAuditEvents).toHaveBeenLastCalledWith(UTC);
    expect(signupsPerOrg).toHaveBeenLastCalledWith(UTC);
  });

  it("does not swallow any other database failure", async () => {
    dailyRegistrations.mockRejectedValue(Object.assign(new Error("boom"), { code: "57P01" }));

    await expect(
      selectDashboardMetrics(access(["superuser"], "o-self"), KATHMANDU),
    ).rejects.toThrow("boom");
    expect(dailyRegistrations).toHaveBeenCalledTimes(1);
  });

  it("does not retry a UTC request that fails", async () => {
    dailyRegistrations.mockRejectedValue(Object.assign(new Error("bad"), { code: "22023" }));

    await expect(selectDashboardMetrics(access(["superuser"], "o-self"))).rejects.toThrow("bad");
    expect(dailyRegistrations).toHaveBeenCalledTimes(1);
  });
});
