import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canViewDoc,
  clearCatalogCache,
  filterCatalogForViewer,
  getViewableDocument,
  groupCatalog,
  sortEntries,
} from "@/lib/docs/catalog.server";
import type { DocCatalogEntry } from "@/lib/docs/source/types";

// canViewDoc reads the catalog from the active source and the env's
// DOCS_INTERNAL_VISIBLE; both are stubbed (the pure helpers use neither).
const source = vi.hoisted(() => ({ entries: [] as unknown[], getDocument: vi.fn() }));
vi.mock("@/lib/docs/source/index.server", () => ({
  getDocumentSource: () => ({
    listCatalog: async () => source.entries,
    getDocument: source.getDocument,
  }),
}));
const env = vi.hoisted(() => ({ DOCS_INTERNAL_VISIBLE: false }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));

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

/**
 * F-92: canViewDoc is the per-document gate the doc pages ask before they read
 * a file (through getViewableDocument). It answers from the catalog, so it
 * must refuse what filterCatalogForViewer hides, and a slug it does not know.
 */
describe("canViewDoc (F-92)", () => {
  beforeEach(() => {
    clearCatalogCache();
    env.DOCS_INTERNAL_VISIBLE = false;
    source.getDocument.mockReset();
    source.entries = [
      entry({ slug: "public" }),
      entry({ slug: "internal-doc", visibility: "internal" }),
      entry({ slug: "gated", requires: ["admin.audit.read", "admin.users.read"] }),
    ];
  });

  it("admits a public doc and refuses a slug the catalog does not list", async () => {
    expect(await canViewDoc("public", ["shell.view"])).toBe(true);
    expect(await canViewDoc("missing", ["shell.view"])).toBe(false);
  });

  it("refuses an internal doc unless internal docs are shown", async () => {
    expect(await canViewDoc("internal-doc", ["shell.view"])).toBe(false);
    env.DOCS_INTERNAL_VISIBLE = true;
    expect(await canViewDoc("internal-doc", ["shell.view"])).toBe(true);
  });

  it("refuses a gated doc until every required key is granted", async () => {
    expect(await canViewDoc("gated", ["shell.view", "admin.audit.read"])).toBe(false);
    expect(await canViewDoc("gated", ["shell.view", "admin.audit.read", "admin.users.read"])).toBe(
      true,
    );
  });

  it("never reads a document it refuses", async () => {
    expect(await getViewableDocument("internal-doc", ["shell.view"])).toBeNull();
    expect(await getViewableDocument("gated", ["shell.view", "admin.audit.read"])).toBeNull();
    expect(await getViewableDocument("missing", ["shell.view"])).toBeNull();
    expect(source.getDocument).not.toHaveBeenCalled();
  });
});
