import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANY_ADMIN_PERMISSION } from "@/lib/admin/permissions";
import { filterCatalogForViewer } from "@/lib/docs/catalog.server";
import { parseFrontmatter } from "@/lib/docs/frontmatter";
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

const REPO_ROOT = path.resolve(__dirname, "../..");
const HELP_DIR = path.join(REPO_ROOT, "help");
const SECURE_APP_DIR = path.join(REPO_ROOT, "src", "app", "[locale]", "(secure)", "app");
const ADMIN_ROUTE = "/en/app/administrator";
const ANY_ADMIN_GUARD = "[...ANY_ADMIN_PERMISSION]";

/** One `key: value` line of a help page's frontmatter (`route` and `area`, which the viewer ignores). */
function frontmatterValue(raw: string, key: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
  const line = block.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim() || undefined;
}

const helpPages = readdirSync(HELP_DIR)
  .filter((name) => name.endsWith(".md"))
  .map((name) => {
    const raw = readFileSync(path.join(HELP_DIR, name), "utf8");
    return {
      slug: name.replace(/\.md$/, ""),
      route: frontmatterValue(raw, "route"),
      area: frontmatterValue(raw, "area"),
      requires: parseFrontmatter(raw).data.requires,
    };
  });

/**
 * The permission the page serving `route` guards on: the argument of its
 * first `checkAdminPermissionServer` call (`{userId}` in a documented route is
 * the `[userId]` segment).
 */
function pageGuard(route: string): string {
  const segments = route
    .slice("/en/app/".length)
    .replace(/\{(\w+)\}/g, "[$1]")
    .split("/");
  const file = path.join(SECURE_APP_DIR, ...segments, "page.tsx");
  expect(existsSync(file), `${route} has no page at ${file}`).toBe(true);
  const guard =
    /checkAdminPermissionServer\(\s*(?:"([^"]+)"|(\[\.\.\.ANY_ADMIN_PERMISSION\]))\s*\)/.exec(
      readFileSync(file, "utf8"),
    );
  expect(guard, `${file} has no checkAdminPermissionServer guard`).not.toBeNull();
  return guard![1] ?? guard![2]!;
}

/**
 * F-89: the administrator-console walkthrough (help/30-46) had no `requires`,
 * so every member of every org could read it, screenshots of other people's
 * accounts included. Each admin page now requires the key the screen it
 * documents guards on, so the help and the console open for the same people,
 * and a page guard that changes key fails here until its help page follows.
 */
describe("admin walkthrough pages are gated like the screens they document (F-89)", () => {
  const adminPages = helpPages.filter(
    (page) => page.area === "admin" || (page.route?.startsWith(ADMIN_ROUTE) ?? false),
  );

  it("requires on every admin page the permission its screen's page guard checks", () => {
    expect(adminPages.length).toBeGreaterThanOrEqual(17);
    for (const page of adminPages) {
      expect(page.area, page.slug).toBe("admin");
      expect(page.route?.startsWith(ADMIN_ROUTE), page.slug).toBe(true);
      const guard = pageGuard(page.route!);
      if (guard === ANY_ADMIN_GUARD) {
        // The console's entry gate is ANY admin key; `requires` is ALL of its
        // keys, so the overview's page takes exactly one admin key.
        expect(page.requires, page.slug).toHaveLength(1);
        expect(ANY_ADMIN_PERMISSION, page.slug).toContain(page.requires[0]);
      } else {
        expect(page.requires, page.slug).toEqual([guard]);
      }
    }
  });

  it("lists no admin page to a plain member, every other page to them, and all to a full admin", async () => {
    const catalog = await new FileSystemDocumentSource("help").listCatalog();
    const all = catalog.map((entry) => entry.slug);
    const admin = new Set(adminPages.map((page) => page.slug));
    expect(all).toEqual(expect.arrayContaining([...admin]));

    const member = filterCatalogForViewer(catalog, ["shell.view"], false).map((e) => e.slug);
    expect(member.filter((slug) => admin.has(slug))).toEqual([]);
    expect(new Set(member)).toEqual(new Set(all.filter((slug) => !admin.has(slug))));

    const fullAdmin = filterCatalogForViewer(
      catalog,
      ["shell.view", ...ANY_ADMIN_PERMISSION],
      false,
    );
    expect(fullAdmin.map((e) => e.slug)).toEqual(all);
  });
});
