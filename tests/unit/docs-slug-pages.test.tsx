import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { clearCatalogCache } from "@/lib/docs/catalog.server";
import { clearRenderCache } from "@/lib/docs/render/pipeline.server";
import { resetDocsRootCache } from "@/lib/docs/safe-path.server";
import { resetDocumentSource } from "@/lib/docs/source/index.server";
import DocPage from "@/app/[locale]/(secure)/app/docs/[...slug]/page";
import HelpDocPage from "@/app/[locale]/(secure)/app/help/[...slug]/page";

/**
 * F-92: the per-document gate of the docs and help pages. The shell admits
 * every member, so these pages are what keep an `internal` or `requires`-gated
 * document from a member who may not see it; a page that stopped asking would
 * render it to everyone, and no test called either page. They run here
 * against a scratch content root through the real catalog, source and
 * renderer, with only the session, translations and formatter stubbed.
 *
 * F-90: the pages also tell the renderer which document it is rendering, so a
 * relative link in a nested document resolves against that document's
 * directory.
 */
const NOT_FOUND = "__NOT_FOUND__";
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/format/viewer-format.server", () => ({
  getAppFormatter: async () => ({ date: () => "a date" }),
}));
const viewer = vi.hoisted(() => ({ permissions: ["shell.view"] as string[] }));
vi.mock("@/lib/auth-guard", () => ({
  requireSecureSession: async () => ({ access: { permissions: viewer.permissions } }),
}));
const state = vi.hoisted(() => ({
  env: {
    DOCS_SOURCE: "filesystem" as const,
    DOCS_ROOT: "",
    HELP_ROOT: "",
    DOCS_INTERNAL_VISIBLE: false,
  },
}));
vi.mock("@/lib/env", () => ({ getServerEnv: () => state.env }));
// Client components: the page only passes them props, which is what is read.
vi.mock("@/components/docs-viewer/doc-article", () => ({ DocArticle: () => null }));
vi.mock("@/components/docs-viewer/docs-breadcrumbs", () => ({ DocsBreadcrumbs: () => null }));
vi.mock("@/components/docs-viewer/docs-toc", () => ({ DocsToc: () => null }));

type Space = "docs" | "help";
type Page = typeof DocPage;
const PAGES: ReadonlyArray<[Space, Page]> = [
  ["docs", DocPage],
  ["help", HelpDocPage],
];

// One scratch root per space, so a page that read the other space's root
// would miss its own space's document.
const roots: Record<Space, string> = { docs: "", help: "" };
async function putIn(space: Space, file: string, ...lines: string[]): Promise<void> {
  const full = path.join(roots[space], file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, lines.join("\n"));
}
async function put(file: string, ...lines: string[]): Promise<void> {
  await putIn("docs", file, ...lines);
  await putIn("help", file, ...lines);
}
const open = (page: Page, ...slug: string[]) =>
  page({ params: Promise.resolve({ locale: "en", slug }) });

/** The `html` the page hands the article component. */
function articleHtml(node: ReactNode): string | undefined {
  if (!node || typeof node !== "object" || !("props" in node)) return undefined;
  const props = (node as ReactElement<{ html?: unknown; children?: ReactNode }>).props;
  if (typeof props.html === "string") return props.html;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    const html = articleHtml(child as ReactNode);
    if (html !== undefined) return html;
  }
  return undefined;
}

beforeEach(async () => {
  roots.docs = await mkdtemp(path.join(os.tmpdir(), "docs-pages-docs-"));
  roots.help = await mkdtemp(path.join(os.tmpdir(), "docs-pages-help-"));
  state.env.DOCS_ROOT = roots.docs;
  state.env.HELP_ROOT = roots.help;
  state.env.DOCS_INTERNAL_VISIBLE = false;
  viewer.permissions = ["shell.view"];
  resetDocsRootCache();
  resetDocumentSource();
  clearCatalogCache();
  clearRenderCache();
  await put("open.md", "# Open");
  await put("internal.md", "---", "visibility: internal", "---", "# Internal");
  await put("gated.md", "---", "requires: admin.audit.read", "---", "# Gated");
  await put("guide/start.md", "# Start", "", "[next](./next.md) [up](../open.md)");
  await putIn("docs", "only-docs.md", "# Only in docs");
  await putIn("help", "only-help.md", "# Only in help");
});

afterEach(async () => {
  await rm(roots.docs, { recursive: true, force: true });
  await rm(roots.help, { recursive: true, force: true });
});

describe.each(PAGES)("the %s document page (F-92)", (space, page) => {
  it("renders a document the viewer may see", async () => {
    expect(articleHtml(await open(page, "open"))).toContain("Open");
  });

  it("404s an internal document, and renders it once internal docs are shown", async () => {
    await expect(open(page, "internal")).rejects.toThrow(NOT_FOUND);
    state.env.DOCS_INTERNAL_VISIBLE = true;
    expect(articleHtml(await open(page, "internal"))).toContain("Internal");
  });

  it("404s a document whose requirement the viewer lacks", async () => {
    await expect(open(page, "gated")).rejects.toThrow(NOT_FOUND);
    viewer.permissions = ["shell.view", "admin.audit.read"];
    expect(articleHtml(await open(page, "gated"))).toContain("Gated");
  });

  it("reads its own space's root, never the other's", async () => {
    const other: Space = space === "docs" ? "help" : "docs";
    expect(articleHtml(await open(page, `only-${space}`))).toContain(`Only in ${space}`);
    await expect(open(page, `only-${other}`)).rejects.toThrow(NOT_FOUND);
  });

  it("404s a slug with no document, and a traversal", async () => {
    await expect(open(page, "missing")).rejects.toThrow(NOT_FOUND);
    await expect(open(page, "..", "open")).rejects.toThrow(NOT_FOUND);
  });

  it("resolves a nested document's links against its own directory (F-90)", async () => {
    const html = articleHtml(await open(page, "guide", "start"));
    expect(html).toContain(`href="/en/app/${space}/guide/next"`);
    expect(html).toContain(`href="/en/app/${space}/open"`);
  });
});
