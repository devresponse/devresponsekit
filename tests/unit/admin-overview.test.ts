import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Administrator overview query layer
 * (docs/admin-manager.md §8.1). The DB is stubbed; we pin:
 *   - status-grouped counts roll up into total/active/pending slices,
 *   - pg's string counts are normalized to numbers,
 *   - excluded slices are never queried (permission-driven `include`).
 */

const executeByTable = new Map<string, ReturnType<typeof vi.fn>>();
const takeFirstByTable = new Map<string, ReturnType<typeof vi.fn>>();
const queriedTables: string[] = [];

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      queriedTables.push(table);
      return {
        select: () => ({
          groupBy: () => ({
            execute: executeByTable.get(table) ?? vi.fn().mockResolvedValue([]),
          }),
          executeTakeFirst: takeFirstByTable.get(table) ?? vi.fn().mockResolvedValue(undefined),
        }),
      };
    },
  },
}));

import { getAdministratorOverviewMetrics } from "@/lib/admin/overview.server";

const ALL = {
  users: true,
  organizations: true,
  roles: true,
  permissions: true,
  enterpriseApps: true,
};

beforeEach(() => {
  executeByTable.clear();
  takeFirstByTable.clear();
  queriedTables.length = 0;
});

describe("getAdministratorOverviewMetrics", () => {
  it("rolls grouped status counts into totals and slices", async () => {
    executeByTable.set(
      "app_users",
      vi.fn().mockResolvedValue([
        { status: "active", count: "12" },
        { status: "pending_approval", count: "3" },
        { status: "blocked", count: "1" },
      ]),
    );
    executeByTable.set(
      "app_enterprise_applications",
      vi.fn().mockResolvedValue([
        { status: "available", count: "4" },
        { status: "offline", count: "2" },
      ]),
    );
    takeFirstByTable.set("app_organizations", vi.fn().mockResolvedValue({ count: "5" }));
    takeFirstByTable.set("app_roles", vi.fn().mockResolvedValue({ count: "7" }));
    takeFirstByTable.set("app_permissions", vi.fn().mockResolvedValue({ count: "24" }));

    const metrics = await getAdministratorOverviewMetrics(ALL);

    expect(metrics.users).toEqual({ total: 16, active: 12, pendingApproval: 3 });
    expect(metrics.organizations).toEqual({ total: 5 });
    expect(metrics.roles).toEqual({ total: 7 });
    expect(metrics.permissions).toEqual({ total: 24 });
    expect(metrics.enterpriseApps).toEqual({ total: 6, available: 4 });
  });

  it("returns zeroed slices for empty tables and missing rows", async () => {
    const metrics = await getAdministratorOverviewMetrics(ALL);
    expect(metrics.users).toEqual({ total: 0, active: 0, pendingApproval: 0 });
    expect(metrics.organizations).toEqual({ total: 0 });
    expect(metrics.enterpriseApps).toEqual({ total: 0, available: 0 });
  });

  it("never queries slices excluded by the permission flags", async () => {
    const metrics = await getAdministratorOverviewMetrics({
      users: true,
      organizations: false,
      roles: false,
      permissions: false,
      enterpriseApps: false,
    });

    expect(queriedTables).toEqual(["app_users"]);
    expect(metrics.users).toBeDefined();
    expect(metrics.organizations).toBeUndefined();
    expect(metrics.roles).toBeUndefined();
    expect(metrics.permissions).toBeUndefined();
    expect(metrics.enterpriseApps).toBeUndefined();
  });
});
