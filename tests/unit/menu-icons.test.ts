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

  it("covers every icon name used by the navigation manifests", async () => {
    // Scan every manifest that serves icon names and assert each name
    // is in the allow-list, so a manifest-side rename cannot silently
    // degrade to fallback glyphs.
    const { readFileSync } = await import("node:fs");
    const manifests = [
      "src/lib/navigation.server.ts",
      "src/app/[locale]/(secure)/app/administrator/_components/administrator-navigation.ts",
    ];
    for (const file of manifests) {
      const source = readFileSync(file, "utf8");
      const served = [...source.matchAll(/icon: "([^"]+)"/g)].map((m) => m[1]!);
      expect(served.length, `${file} serves no icon names`).toBeGreaterThan(0);
      for (const name of served) {
        expect(MENU_ICONS, `icon "${name}" (${file}) missing from MENU_ICONS`).toHaveProperty(name);
      }
    }
  });
});
