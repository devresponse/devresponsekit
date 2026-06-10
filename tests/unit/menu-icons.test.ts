import { describe, expect, it } from "vitest";
import { LayoutDashboard, ScrollText } from "lucide-react";
import { FALLBACK_MENU_ICON, getMenuIcon, MENU_ICONS } from "@/components/navigation/menu-icons";

/**
 * The menu API serves icon NAMES; the client resolves them through the
 * `MENU_ICONS` allow-list. These tests pin the contract: known names
 * resolve to their lucide component, unknown names fall back to a
 * generic glyph (never `undefined`, never a dynamic lookup), and items
 * without an icon stay icon-less.
 */
describe("getMenuIcon", () => {
  it("resolves known icon names from the allow-list", () => {
    expect(getMenuIcon("layout-dashboard")).toBe(LayoutDashboard);
    expect(getMenuIcon("scroll-text")).toBe(ScrollText);
  });

  it("falls back to the generic glyph for unknown names", () => {
    expect(getMenuIcon("definitely-not-an-icon")).toBe(FALLBACK_MENU_ICON);
  });

  it("returns null when the item has no icon", () => {
    expect(getMenuIcon(undefined)).toBeNull();
    expect(getMenuIcon("")).toBeNull();
  });

  it("covers every icon name used by the default shell menus", async () => {
    // Read the server manifest's icon names from the API surface: load
    // the menus with full permissions and assert every served name is
    // in the allow-list, so a server-side rename cannot silently
    // degrade to fallback glyphs.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/navigation.server.ts", "utf8");
    const served = [...source.matchAll(/icon: "([^"]+)"/g)].map((m) => m[1]!);
    expect(served.length).toBeGreaterThan(0);
    for (const name of served) {
      expect(MENU_ICONS, `icon "${name}" missing from MENU_ICONS`).toHaveProperty(name);
    }
  });
});
