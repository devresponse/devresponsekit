import { describe, expect, it } from "vitest";
import { FileSystemDocumentSource } from "@/lib/docs/source/filesystem-source.server";
import { resolveAssetFile } from "@/lib/docs/safe-path.server";

/**
 * Integration test against the real repo `help/` folder (the default
 * root for the help space when `HELP_ROOT` is unset). Verifies the
 * space-parameterized filesystem source builds the walkthrough catalog,
 * loads a document, serves its screenshots through the asset resolver,
 * stays isolated from the docs space, and refuses traversal.
 */
describe("FileSystemDocumentSource (help space)", () => {
  const source = new FileSystemDocumentSource("help");

  it("lists a non-empty catalog of well-formed entries", async () => {
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
    expect(doc!.body.length).toBeGreaterThan(0);
  });

  it("is isolated from the docs space: help slugs don't resolve in docs", async () => {
    // The walkthrough's numbered screen docs exist only under help/.
    const docsSource = new FileSystemDocumentSource("docs");
    const helpCatalog = await source.listCatalog();
    const numbered = helpCatalog.find((entry) => /^\d\d-/.test(entry.slug));
    expect(numbered).toBeDefined();
    expect(await docsSource.getDocument(numbered!.slug)).toBeNull();
  });

  it("resolves a screenshot referenced by a walkthrough doc as a help asset", async () => {
    const resolved = await resolveAssetFile("screenshots/01-landing.png", "help");
    expect(resolved).not.toBeNull();
    expect(resolved!.contentType).toBe("image/png");
    // The same path must NOT resolve inside the docs root.
    expect(await resolveAssetFile("screenshots/01-landing.png", "docs")).toBeNull();
  });

  it("returns null for traversal and missing slugs", async () => {
    expect(await source.getDocument("../package")).toBeNull();
    expect(await source.getDocument("nope-not-here")).toBeNull();
    expect(await resolveAssetFile("../docs/README.md", "help")).toBeNull();
  });
});
