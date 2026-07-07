import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Administrator overview query layer
 * (docs/admin-manager.md §8.0). The DB is stubbed; we pin:
 *   - status-grouped counts roll up into total/active/pending slices,
 *   - pg's string counts are normalized to numbers,
 *   - excluded slices are never queried (permission-driven `include`).
 */

// Typed by usage (a no-arg call returning a promise) rather than
// `ReturnType<typeof vi.fn>` — under vitest 4.1 that resolves to the
// `Mock<Procedure | Constructable>` union, which is not directly callable
// (TS2348). A `vi.fn().mockResolvedValue(...)` still assigns to this.
const executeByTable = new Map<string, () => Promise<unknown>>();
const takeFirstByTable = new Map<string, () => Promise<unknown>>();
const queriedTables: string[] = [];
/** Args passed to every `.where(...)` on the outer query, keyed by table. */
const whereArgsByTable = new Map<string, unknown[][]>();

vi.mock("@/db/database", () => ({
  db: {
    selectFrom: (table: string) => {
      queriedTables.push(table);
      // One chainable stub covers both query shapes:
      //   counts:   select(...).groupBy(...).execute() / select(...).executeTakeFirst()
      //   activity: [innerJoin(...)].select(...).orderBy(...).limit(...).execute()
      // `.where(...)` (the org-scope filter) records its args so tests can
      // assert how each table is scoped without a real database.
      const chain = {
        innerJoin: () => chain,
        select: () => chain,
        groupBy: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        where: (...args: unknown[]) => {
          const calls = whereArgsByTable.get(table) ?? [];
          calls.push(args);
          whereArgsByTable.set(table, calls);
          return chain;
        },
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
import type { OrgScope } from "@/lib/admin/access-scope.server";

const ALL = {
  users: true,
  organizations: true,
  roles: true,
  permissions: true,
  enterpriseApps: true,
};

/** SUPERADMIN: system-wide, unscoped. */
const SUPER: OrgScope = { kind: "all" };
/** ORG ADMIN: confined to org-1. */
const ORG: OrgScope = { kind: "org", organizationId: "org-1" };

beforeEach(() => {
  executeByTable.clear();
  takeFirstByTable.clear();
  queriedTables.length = 0;
  whereArgsByTable.clear();
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

    const metrics = await getAdministratorOverviewMetrics(ALL, SUPER);

    expect(metrics.users).toEqual({ total: 16, active: 12, pendingApproval: 3 });
    expect(metrics.organizations).toEqual({ total: 5 });
    expect(metrics.roles).toEqual({ total: 7 });
    expect(metrics.permissions).toEqual({ total: 24 });
    expect(metrics.enterpriseApps).toEqual({ total: 6, available: 4 });
  });

  it("returns zeroed slices for empty tables and missing rows", async () => {
    const metrics = await getAdministratorOverviewMetrics(ALL, SUPER);
    expect(metrics.users).toEqual({ total: 0, active: 0, pendingApproval: 0 });
    expect(metrics.organizations).toEqual({ total: 0 });
    expect(metrics.enterpriseApps).toEqual({ total: 0, available: 0 });
  });

  it("never queries slices excluded by the permission flags", async () => {
    const metrics = await getAdministratorOverviewMetrics(
      {
        users: true,
        organizations: false,
        roles: false,
        permissions: false,
        enterpriseApps: false,
      },
      SUPER,
    );

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

    const activity = await getAdministratorOverviewActivity(ALL_ACTIVITY, SUPER);

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
    const activity = await getAdministratorOverviewActivity(
      {
        registrations: false,
        sessions: true,
        auditEvents: false,
        organizations: false,
      },
      SUPER,
    );

    expect(queriedTables).toEqual(["session"]);
    expect(activity.sessions).toEqual([]);
    expect(activity.registrations).toBeUndefined();
    expect(activity.auditEvents).toBeUndefined();
    expect(activity.organizations).toBeUndefined();
  });
});

describe("ADR-0001 org scoping", () => {
  /** First `.where(...)` args recorded for a table, or undefined if unscoped. */
  const whereFor = (table: string) => whereArgsByTable.get(table)?.[0];

  it("SUPERADMIN scope applies NO org filter to any table (system-wide)", async () => {
    await getAdministratorOverviewMetrics(ALL, SUPER);
    await getAdministratorOverviewActivity(ALL_ACTIVITY, SUPER);
    // A superadmin's queries are unscoped — nothing calls `.where`.
    expect(whereArgsByTable.size).toBe(0);
  });

  it("ORG ADMIN metrics confine every tenant table to their org", async () => {
    await getAdministratorOverviewMetrics(ALL, ORG);

    // Users have no org column → scoped via a membership EXISTS (a callback).
    expect(whereArgsByTable.get("app_users")).toHaveLength(1);
    expect(typeof whereFor("app_users")?.[0]).toBe("function");
    // Org-columned tables filter to the caller's org directly.
    expect(whereFor("app_organizations")).toEqual(["id", "=", "org-1"]);
    expect(whereFor("app_roles")).toEqual(["organization_id", "=", "org-1"]);
    expect(whereFor("app_enterprise_applications")).toEqual(["organization_id", "=", "org-1"]);
    // Permissions are a platform-global catalog — never org-scoped.
    expect(whereArgsByTable.has("app_permissions")).toBe(false);
  });

  it("ORG ADMIN activity confines every tenant list to their org", async () => {
    await getAdministratorOverviewActivity(ALL_ACTIVITY, ORG);

    // Registrations (users) and sessions bridge to memberships via EXISTS.
    expect(typeof whereFor("app_users")?.[0]).toBe("function");
    expect(typeof whereFor("session")?.[0]).toBe("function");
    // Audit rows and organizations filter by their own org column directly.
    expect(whereFor("app_audit_events")).toEqual(["organization_id", "=", "org-1"]);
    expect(whereFor("app_organizations")).toEqual(["id", "=", "org-1"]);
  });
});
