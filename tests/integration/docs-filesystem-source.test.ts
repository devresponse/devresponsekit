import { describe, expect, it } from "vitest";
import { FileSystemDocumentSource } from "@/lib/docs/source/filesystem-source.server";

/**
 * Integration test against the real repo `docs/` folder (the default
 * root when `DOCS_ROOT` is unset). Verifies the filesystem source builds
 * a catalog, loads a document, and refuses traversal/missing slugs.
 */
describe("FileSystemDocumentSource", () => {
  const source = new FileSystemDocumentSource();

  it("lists a catalog that includes the known repo docs", async () => {
    const catalog = await source.listCatalog();
    const slugs = catalog.map((e) => e.slug);
    expect(slugs).toContain("get-started");
    expect(slugs).toContain("setup-better-auth");
    // Every entry has the required catalog shape.
    for (const entry of catalog) {
      expect(typeof entry.title).toBe("string");
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.visibility === "public" || entry.visibility === "internal").toBe(true);
    }
  });

  it("loads a document body by slug", async () => {
    const doc = await source.getDocument("get-started");
    expect(doc).not.toBeNull();
    expect(doc!.format).toBe("md");
    expect(doc!.entry.slug).toBe("get-started");
    expect(doc!.body.length).toBeGreaterThan(0);
  });

  it("returns null for traversal and missing slugs", async () => {
    expect(await source.getDocument("../package")).toBeNull();
    expect(await source.getDocument("nope-not-here")).toBeNull();
  });
});
