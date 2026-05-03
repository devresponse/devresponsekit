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
    const res = await mod.loadShellMenu(ACTIVE, "primary-sidebar", "fr");
    expect(res.menuId).toBe("shell-menu:primary-sidebar");
    expect(res.locale).toBe("fr");
    // shell.view + audit.view granted but admin.users.manage NOT granted
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain("dashboard");
    expect(ids).toContain("workspace");
    expect(ids).toContain("admin-audit");
    expect(ids).not.toContain("admin-users");
    // No admin.* permission granted, so the Administrator launcher
    // entry must not be visible.
    expect(ids).not.toContain("administrator");
    // hrefs are prefixed with the locale
    expect(res.items[0]!.href.startsWith("/fr/")).toBe(true);
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
