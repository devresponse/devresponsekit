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
      // One chainable stub covers both query shapes:
      //   counts:   select(...).groupBy(...).execute() / select(...).executeTakeFirst()
      //   activity: [innerJoin(...)].select(...).orderBy(...).limit(...).execute()
      const chain = {
        innerJoin: () => chain,
        select: () => chain,
        groupBy: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        execute: () => (executeByTable.get(table) ?? vi.fn().mockResolvedValue([]))(),
        executeTakeFirst: () =>
          (takeFirstByTable.get(table) ?? vi.fn().mockResolvedValue(undefined))(),
      };
      return chain;
    },
  },
}));

import {
  getAdministratorOverviewActivity,
  getAdministratorOverviewMetrics,
} from "@/lib/admin/overview.server";

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

const ALL_ACTIVITY = {
  registrations: true,
  sessions: true,
  auditEvents: true,
  organizations: true,
};

describe("getAdministratorOverviewActivity", () => {
  it("maps rows to the activity shapes and normalizes timestamps to ISO", async () => {
    executeByTable.set(
      "app_users",
      vi.fn().mockResolvedValue([
        {
          id: "u1",
          primary_email: "a@x.com",
          display_name: "Ada",
          status: "active",
          created_at: new Date("2026-06-01T10:00:00Z"),
        },
      ]),
    );
    executeByTable.set(
      "session",
      vi.fn().mockResolvedValue([
        {
          id: "s1",
          userEmail: "a@x.com",
          userName: "Ada",
          ipAddress: "10.0.0.1",
          // pg may surface timestamps as strings in some paths.
          createdAt: "2026-06-02T11:30:00Z",
        },
      ]),
    );
    executeByTable.set(
      "app_audit_events",
      vi.fn().mockResolvedValue([
        {
          id: "e1",
          event_type: "admin.user.approved",
          outcome: "success",
          email: "a@x.com",
          created_at: new Date("2026-06-03T12:00:00Z"),
        },
      ]),
    );
    executeByTable.set(
      "app_organizations",
      vi.fn().mockResolvedValue([
        {
          id: "o1",
          name: "Default",
          slug: "default",
          status: "active",
          created_at: new Date("2026-06-04T13:00:00Z"),
        },
      ]),
    );

    const activity = await getAdministratorOverviewActivity(ALL_ACTIVITY);

    expect(activity.registrations).toEqual([
      {
        id: "u1",
        email: "a@x.com",
        displayName: "Ada",
        status: "active",
        createdAt: "2026-06-01T10:00:00.000Z",
      },
    ]);
    expect(activity.sessions).toEqual([
      {
        id: "s1",
        userEmail: "a@x.com",
        userName: "Ada",
        ipAddress: "10.0.0.1",
        createdAt: "2026-06-02T11:30:00.000Z",
      },
    ]);
    expect(activity.auditEvents).toEqual([
      {
        id: "e1",
        eventType: "admin.user.approved",
        outcome: "success",
        email: "a@x.com",
        createdAt: "2026-06-03T12:00:00.000Z",
      },
    ]);
    expect(activity.organizations).toEqual([
      {
        id: "o1",
        name: "Default",
        slug: "default",
        status: "active",
        createdAt: "2026-06-04T13:00:00.000Z",
      },
    ]);
  });

  it("never queries lists excluded by the permission flags", async () => {
    const activity = await getAdministratorOverviewActivity({
      registrations: false,
      sessions: true,
      auditEvents: false,
      organizations: false,
    });

    expect(queriedTables).toEqual(["session"]);
    expect(activity.sessions).toEqual([]);
    expect(activity.registrations).toBeUndefined();
    expect(activity.auditEvents).toBeUndefined();
    expect(activity.organizations).toBeUndefined();
  });
});
