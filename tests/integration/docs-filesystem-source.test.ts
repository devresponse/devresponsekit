import { describe, expect, it } from "vitest";
import { FileSystemDocumentSource } from "@/lib/docs/source/filesystem-source.server";

/**
 * Integration test against the real repo `docs/` folder (the default
 * root when `DOCS_ROOT` is unset). Verifies the filesystem source builds
 * a catalog, loads a document, and refuses traversal/missing slugs.
 */
describe("FileSystemDocumentSource", () => {
  const source = new FileSystemDocumentSource();

  it("lists a non-empty catalog of well-formed entries", async () => {
    // Resilient to documentation reorganization: don't pin specific slugs,
    // just require a non-empty catalog where every entry has the right shape.
    const catalog = await source.listCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(typeof entry.slug).toBe("string");
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(typeof entry.title).toBe("string");
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.visibility === "public" || entry.visibility === "internal").toBe(true);
    }
  });

  it("loads a document body by a slug taken from the catalog", async () => {
    const [first] = await source.listCatalog();
    expect(first).toBeDefined();
    const doc = await source.getDocument(first!.slug);
    expect(doc).not.toBeNull();
    expect(doc!.entry.slug).toBe(first!.slug);
    expect(doc!.format === "md" || doc!.format === "mdx").toBe(true);
    expect(doc!.body.length).toBeGreaterThan(0);
  });

  it("returns null for traversal and missing slugs", async () => {
    expect(await source.getDocument("../package")).toBeNull();
    expect(await source.getDocument("nope-not-here")).toBeNull();
  });
});
