import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NavServerModule from "@/lib/navigation.server";

/**
 * DB-backed unit tests for `navigation.server.ts > loadApplicationsMenu`,
 * `loadShellMenu`, and `loadNestedAppsMenu`. The query builder is
 * stubbed so we can assert the envelope shape, the SSO launch URL
 * encoding, and that menu items are filtered server-side.
 */

const enterpriseExecute = vi.fn();
vi.mock("@/db/database", () => ({
  db: {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          where: () => ({
            orderBy: () => ({ execute: enterpriseExecute }),
          }),
        }),
      }),
    }),
  },
}));

let mod: typeof NavServerModule;

const ACTIVE = {
  appUserId: "u-1",
  primaryEmail: "u@x.com",
  status: "active" as const,
  organizationId: "o-1",
  membershipStatus: "active" as const,
  preferredLocale: "en",
  permissions: ["shell.view", "audit.view"],
};

beforeEach(async () => {
  enterpriseExecute.mockReset();
  mod = await import("@/lib/navigation.server");
});
afterEach(() => vi.resetModules());

describe("loadApplicationsMenu", () => {
  it("returns an envelope with sso launch URLs and never raw tokens", async () => {
    enterpriseExecute.mockResolvedValue([
      {
        id: "portal",
        label: "Portal",
        description: null,
        subdomain: "portal",
        origin: "https://portal.x.com",
        sort_order: 1,
        status: "available",
      },
    ]);

    const res = await mod.loadApplicationsMenu(ACTIVE, "fr");
    expect(res.kind).toBe("applications");
    expect(res.locale).toBe("fr");
    expect(res.items[0]!.ssoLaunchUrl).toBe("/api/sso/launch?applicationId=portal&locale=fr");
    // Sanity: no token-shaped fields anywhere in the response.
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/"token"|"jwt"|"access_token"/i);
  });

  it("returns an empty items list when no apps match the filter", async () => {
    enterpriseExecute.mockResolvedValue([]);
    const res = await mod.loadApplicationsMenu({ ...ACTIVE, organizationId: null }, "en");
    expect(res.items).toEqual([]);
  });
});

describe("loadShellMenu", () => {
  it("filters items by the caller's permissions and prefixes hrefs with the locale", async () => {
    // shell.view + admin.audit.read granted; admin.users.read NOT granted.
    const res = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["shell.view", "admin.audit.read"] },
      "primary-sidebar",
      "fr",
    );
    expect(res.menuId).toBe("shell-menu:primary-sidebar");
    expect(res.locale).toBe("fr");
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain("dashboard");
    expect(ids).toContain("workspace");
    // Audit link gates on admin.audit.read (granted) → visible.
    expect(ids).toContain("admin-audit");
    // Users link gates on admin.users.read (NOT granted) → hidden.
    expect(ids).not.toContain("admin-users");
    // admin.audit.read IS an admin.* catalog permission, so the Administrator
    // launcher (anyOf ANY_ADMIN_PERMISSION) correctly surfaces.
    expect(ids).toContain("administrator");
    // hrefs are prefixed with the locale
    expect(res.items[0]!.href.startsWith("/fr/")).toBe(true);
    // every default shell item serves an icon NAME (resolved client-side
    // through the menu-icons allow-list)
    for (const item of res.items) {
      expect(item.icon, `item "${item.id}" is missing an icon name`).toBeTruthy();
    }
    expect(res.items.find((i) => i.id === "dashboard")!.icon).toBe("layout-dashboard");
  });

  it("shows no admin items to a shell-only (non-admin) caller", async () => {
    const res = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["shell.view"] },
      "primary-sidebar",
      "en",
    );
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain("dashboard");
    expect(ids).not.toContain("admin-users");
    expect(ids).not.toContain("admin-audit");
    expect(ids).not.toContain("administrator");
  });

  it("gates the Users link on admin.users.read (not admin.users.manage) so the link matches the page guard", async () => {
    // Regression (group-conferred admin role → 404): a principal that can
    // MANAGE but not READ users must NOT see the Users link, because the page
    // guard requires admin.users.read and would otherwise notFound().
    const manageOnly = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["shell.view", "admin.users.manage"] },
      "primary-sidebar",
      "en",
    );
    expect(manageOnly.items.map((i) => i.id)).not.toContain("admin-users");

    const canRead = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["shell.view", "admin.users.read"] },
      "primary-sidebar",
      "en",
    );
    expect(canRead.items.map((i) => i.id)).toContain("admin-users");
  });

  it("gates the Audit link on admin.audit.read (not the phantom audit.view)", async () => {
    // Regression: audit.view is a legacy/base key the audit page never checks.
    const phantomOnly = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["shell.view", "audit.view"] },
      "primary-sidebar",
      "en",
    );
    expect(phantomOnly.items.map((i) => i.id)).not.toContain("admin-audit");

    const canRead = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["shell.view", "admin.audit.read"] },
      "primary-sidebar",
      "en",
    );
    expect(canRead.items.map((i) => i.id)).toContain("admin-audit");
  });

  it("returns no items when caller has no permissions", async () => {
    const res = await mod.loadShellMenu({ ...ACTIVE, permissions: [] }, "primary-sidebar", "en");
    expect(res.items).toEqual([]);
  });

  it("exposes the Administrator launcher entry to any caller holding an admin.* permission", async () => {
    const res = await mod.loadShellMenu(
      { ...ACTIVE, permissions: ["admin.audit.read"] },
      "primary-sidebar",
      "en",
    );
    const admin = res.items.find((i) => i.id === "administrator");
    expect(admin).toBeDefined();
    expect(admin!.href).toBe("/en/app/administrator");
  });
});

describe("loadNestedAppsMenu", () => {
  it("scopes nested item ids by application", async () => {
    const res = await mod.loadNestedAppsMenu(ACTIVE, "portal", "en");
    expect(res.menuId).toBe("nested-apps:portal");
    expect(res.items[0]!.id.startsWith("portal:")).toBe(true);
  });
});
