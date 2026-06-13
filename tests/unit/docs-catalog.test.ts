import { describe, expect, it } from "vitest";
import { filterCatalogForViewer, groupCatalog, sortEntries } from "@/lib/docs/catalog.server";
import type { DocCatalogEntry } from "@/lib/docs/source/types";

function entry(over: Partial<DocCatalogEntry> & { slug: string }): DocCatalogEntry {
  return {
    title: over.slug,
    group: "General",
    order: Number.MAX_SAFE_INTEGER,
    tags: [],
    visibility: "public",
    requires: [],
    ...over,
  };
}

describe("sortEntries", () => {
  it("sorts by order then title", () => {
    const sorted = sortEntries([
      entry({ slug: "b", title: "Bravo", order: 2 }),
      entry({ slug: "a", title: "Alpha", order: 2 }),
      entry({ slug: "z", title: "Zero", order: 1 }),
    ]);
    expect(sorted.map((e) => e.slug)).toEqual(["z", "a", "b"]);
  });
});

describe("filterCatalogForViewer", () => {
  const entries = [
    entry({ slug: "public" }),
    entry({ slug: "internal-doc", visibility: "internal" }),
    entry({ slug: "gated", requires: ["docs.secret"] }),
  ];

  it("hides internal docs unless internalVisible is true", () => {
    const hidden = filterCatalogForViewer(entries, [], false).map((e) => e.slug);
    expect(hidden).toContain("public");
    expect(hidden).not.toContain("internal-doc");

    const shown = filterCatalogForViewer(entries, [], true).map((e) => e.slug);
    expect(shown).toContain("internal-doc");
  });

  it("hides docs whose required permissions are not all granted", () => {
    expect(filterCatalogForViewer(entries, [], false).map((e) => e.slug)).not.toContain("gated");
    expect(filterCatalogForViewer(entries, ["docs.secret"], false).map((e) => e.slug)).toContain(
      "gated",
    );
  });
});

describe("groupCatalog", () => {
  it("groups by group name and sorts groups and items", () => {
    const groups = groupCatalog([
      entry({ slug: "g2", group: "Guides", title: "Two", order: 2 }),
      entry({ slug: "g1", group: "Guides", title: "One", order: 1 }),
      entry({ slug: "a1", group: "API", title: "Keys" }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(["API", "Guides"]);
    const guides = groups.find((g) => g.group === "Guides")!;
    expect(guides.items.map((i) => i.slug)).toEqual(["g1", "g2"]);
  });
});
