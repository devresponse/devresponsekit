import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCatalogCache,
  filterCatalogForViewer,
  getCatalog,
  getViewableDocument,
} from "@/lib/docs/catalog.server";
import type * as FrontmatterModule from "@/lib/docs/frontmatter";
import { UNSATISFIABLE_REQUIREMENT } from "@/lib/docs/frontmatter";
import { resetDocsRootCache } from "@/lib/docs/safe-path.server";
import { FileSystemDocumentSource } from "@/lib/docs/source/filesystem-source.server";
import { resetDocumentSource } from "@/lib/docs/source/index.server";

/**
 * The filesystem source and the doc pages' read against a scratch content
 * root (F-86, F-87, I-18): a bad file is reported and hidden without taking
 * the catalog down, two files on one slug are both withheld, and a doc is
 * returned only when the entry actually read is one the viewer may see.
 */
const state = vi.hoisted(() => ({
  env: {
    DOCS_SOURCE: "filesystem" as const,
    DOCS_ROOT: "",
    HELP_ROOT: undefined as string | undefined,
    DOCS_INTERNAL_VISIBLE: false,
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => state.env }));

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger.server", () => ({ logger: { warn } }));

// Makes the real parseFrontmatter throw for a document containing `marker`,
// to prove the source's backstop: parseFrontmatter is built never to throw,
// but a throw it did not foresee must not reject the whole catalog either.
const parseTrap = vi.hoisted(() => ({ marker: undefined as string | undefined }));
vi.mock("@/lib/docs/frontmatter", async (importOriginal) => {
  const actual = await importOriginal<typeof FrontmatterModule>();
  return {
    ...actual,
    parseFrontmatter: (raw: string) => {
      if (parseTrap.marker && raw.includes(parseTrap.marker)) {
        throw new TypeError("unforeseen parser failure");
      }
      return actual.parseFrontmatter(raw);
    },
  };
});

let root = "";
const put = (name: string, ...lines: string[]) =>
  writeFile(path.join(root, name), lines.join("\n"));
const canary = globalThis as { __docsSourceCanary?: string };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "docs-fail-closed-"));
  state.env.DOCS_ROOT = root;
  state.env.DOCS_INTERNAL_VISIBLE = false;
  resetDocsRootCache();
  resetDocumentSource();
  clearCatalogCache();
  warn.mockClear();
  parseTrap.marker = undefined;
  delete canary.__docsSourceCanary;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileSystemDocumentSource.listCatalog with bad frontmatter (F-86, F-87)", () => {
  it("builds the catalog, hides each bad doc from every viewer and logs it", async () => {
    await put("good.md", "---", "title: Good", "---", "# Good");
    await put("broken-yaml.md", "---", "title: [unclosed", "visibility: public", "---", "# Broken");
    await put(
      "js-fenced.md",
      "---js",
      '{ title: (globalThis.__docsSourceCanary = "ran", "Pwned"), visibility: "public" }',
      "---",
      "# Fenced",
    );
    await put("bad-access.md", "---", "visibility: Public", "---", "# Bad access");

    // A throw here (broken YAML) used to reject the whole Promise.all.
    const catalog = await new FileSystemDocumentSource().listCatalog();

    expect(canary.__docsSourceCanary).toBeUndefined();
    const bySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
    expect(bySlug.get("good")).toMatchObject({ title: "Good", visibility: "public", requires: [] });
    for (const slug of ["broken-yaml", "js-fenced", "bad-access"]) {
      expect(bySlug.get(slug), slug).toMatchObject({
        visibility: "internal",
        requires: [UNSATISFIABLE_REQUIREMENT],
      });
    }
    expect(bySlug.get("js-fenced")!.title).not.toBe("Pwned");

    // Hidden even where internal docs are shown, from a viewer holding plenty.
    const visible = filterCatalogForViewer(catalog, ["shell.view", "admin.users.read"], true);
    expect(visible.map((entry) => entry.slug)).toEqual(["good"]);

    const warned = warn.mock.calls
      .map(([fields]) => fields as { kind: string; slug: string; issues: string[] })
      .filter((fields) => fields.kind === "docs-frontmatter");
    expect(warned.map((fields) => fields.slug).sort()).toEqual([
      "bad-access",
      "broken-yaml",
      "js-fenced",
    ]);
    for (const fields of warned) expect(fields.issues.length).toBeGreaterThan(0);
  });

  it("keeps the access gate when only a cosmetic field is bad", async () => {
    await put(
      "runbook.md",
      "---",
      "visibility: internal",
      "requires: admin.audit.read",
      "order: 10.5",
      "---",
      "# Runbook",
    );
    const [entry] = await new FileSystemDocumentSource().listCatalog();
    expect(entry).toMatchObject({
      slug: "runbook",
      visibility: "internal",
      requires: ["admin.audit.read"],
      order: Number.MAX_SAFE_INTEGER,
    });
    expect(filterCatalogForViewer([entry!], ["shell.view"], true)).toEqual([]);
    expect(filterCatalogForViewer([entry!], ["admin.audit.read"], true)).toEqual([entry]);
  });

  it("lists an empty (0-byte) file as a public doc instead of rejecting the catalog", async () => {
    // `touch docs/new-guide.md`, or an editor creating the file, while the
    // viewer is serving that root.
    await put("good.md", "---", "title: Good", "---", "# Good");
    await put("new-guide.md");

    const catalog = await new FileSystemDocumentSource().listCatalog();
    expect(catalog.find((entry) => entry.slug === "new-guide")).toMatchObject({
      title: "New Guide",
      visibility: "public",
      requires: [],
    });
    expect(catalog.find((entry) => entry.slug === "good")).toMatchObject({ title: "Good" });
    expect(warn).not.toHaveBeenCalled();
    expect((await getViewableDocument("new-guide", ["shell.view"]))?.body).toBe("");
  });

  it("hides a file whose load throws, and keeps the rest of the catalog (backstop)", async () => {
    parseTrap.marker = "TRAP";
    await put("good.md", "---", "title: Good", "---", "# Good");
    await put("trapped.md", "---", "visibility: public", "---", "# TRAP");

    const catalog = await new FileSystemDocumentSource().listCatalog();
    expect(catalog.find((entry) => entry.slug === "good")).toMatchObject({ title: "Good" });
    expect(catalog.find((entry) => entry.slug === "trapped")).toMatchObject({
      visibility: "internal",
      requires: [UNSATISFIABLE_REQUIREMENT],
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "docs-frontmatter",
        space: "docs",
        slug: "trapped",
        issues: [expect.stringMatching(/unforeseen parser failure/)],
      }),
      expect.any(String),
    );

    // The page read hits the same backstop: no throw, and nothing to render.
    state.env.DOCS_INTERNAL_VISIBLE = true;
    expect(await getViewableDocument("trapped", ["shell.view", "admin.users.read"])).toBeNull();
    await expect(new FileSystemDocumentSource().getDocument("trapped")).resolves.toMatchObject({
      body: "",
      entry: { visibility: "internal", requires: [UNSATISFIABLE_REQUIREMENT] },
    });
  });
});

describe("one file per slug (I-18)", () => {
  it("lists neither guide.md nor guide.mdx, serves neither, and names the slug", async () => {
    await put("guide.md", "---", "visibility: internal", "---", "# Internal guide");
    await put("guide.mdx", "---", "visibility: public", "---", "# Public guide");
    await put("other.md", "# Other");

    const catalog = await new FileSystemDocumentSource().listCatalog();
    expect(catalog.map((entry) => entry.slug)).toEqual(["other"]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "docs-duplicate-slug", space: "docs", slugs: ["guide"] }),
      expect.any(String),
    );
    expect(await getViewableDocument("guide", ["shell.view"])).toBeNull();
    expect(await getViewableDocument("other", ["shell.view"])).not.toBeNull();
  });
});

describe("getViewableDocument authorizes the entry it read (I-18)", () => {
  it("returns a doc the viewer may see", async () => {
    await put("open.md", "---", "title: Open", "---", "# Open");
    const doc = await getViewableDocument("open", ["shell.view"]);
    expect(doc?.entry).toMatchObject({ slug: "open", title: "Open" });
    expect(doc?.body).toContain("# Open");
  });

  it("refuses a doc flipped to internal after the catalog cached it as public", async () => {
    await put("flip.md", "---", "visibility: public", "---", "# Before");
    await getCatalog("docs"); // cached: flip is public for the next 30 s
    await put("flip.md", "---", "visibility: internal", "---", "# Secret after");

    expect(await getViewableDocument("flip", ["shell.view"])).toBeNull();
    state.env.DOCS_INTERNAL_VISIBLE = true;
    expect((await getViewableDocument("flip", ["shell.view"]))?.body).toContain("Secret after");
  });

  it("refuses a doc that gained a requirement the viewer lacks after it was cached", async () => {
    await put("gated.md", "# Gated");
    await getCatalog("docs");
    await put("gated.md", "---", "requires: admin.audit.read", "---", "# Gated now");

    expect(await getViewableDocument("gated", ["shell.view"])).toBeNull();
    expect(await getViewableDocument("gated", ["shell.view", "admin.audit.read"])).not.toBeNull();
  });

  it("never reads a doc the catalog already hides", async () => {
    await put("hidden.md", "---", "visibility: internal", "---", "# Hidden");
    const read = vi.spyOn(FileSystemDocumentSource.prototype, "getDocument");
    try {
      expect(await getViewableDocument("hidden", ["shell.view"])).toBeNull();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});
