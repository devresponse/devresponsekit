import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repo-level hygiene guards for shipped documentation content.
 *
 *  - Review #216: build-spec Markdown must not live inside the App Router
 *    route tree. A `.md` under `src/app/` is invisible to the viewer (the
 *    catalog only scans `DOCS_ROOT`/`HELP_ROOT`) and to CI's lychee job (which
 *    checks `docs`/`help` and the root READMEs), so its links rot unnoticed
 *    while its position implies it is somehow part of the route.
 *  - Review #215: the app's CSP is `img-src 'self' data: blob:`, so a REMOTE
 *    image in a shipped doc can never load. The renderer degrades it to a
 *    visible external link, but the right place to notice is authoring time —
 *    this test is that lint.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const APP_DIR = path.join(REPO_ROOT, "src", "app");
const CONTENT_DIRS = ["docs", "help"];

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

const isMarkdown = (name: string) => /\.mdx?$/i.test(name);

describe("documentation content hygiene", () => {
  it("keeps Markdown out of the App Router route tree (review #216)", () => {
    const stray = walk(APP_DIR, isMarkdown).map((f) =>
      path.relative(REPO_ROOT, f).split(path.sep).join("/"),
    );
    expect(
      stray,
      "Markdown under src/app/ is neither routed, catalogued, nor link-checked — " +
        "move it to docs/ (see docs/design-docs-viewer.md).",
    ).toEqual([]);
  });

  it("keeps the moved docs-viewer design spec where the catalog and lychee can see it (review #216)", () => {
    const moved = path.join(REPO_ROOT, "docs", "design-docs-viewer.md");
    expect(existsSync(moved)).toBe(true);
    // `internal` keeps it out of the viewer unless DOCS_INTERNAL_VISIBLE is on.
    expect(readFileSync(moved, "utf8")).toMatch(/^---[\s\S]*?visibility:\s*internal/);
  });

  it("ships no remote image references in docs/ or help/ (review #215)", () => {
    // Markdown `![alt](https://…)` and HTML `<img src="https://…">`.
    const remote = /!\[[^\]]*\]\(\s*https?:\/\//i;
    const remoteHtml = /<img\b[^>]*\bsrc\s*=\s*["']https?:\/\//i;
    const offenders: string[] = [];
    for (const dir of CONTENT_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir), isMarkdown)) {
        const body = readFileSync(file, "utf8");
        if (remote.test(body) || remoteHtml.test(body)) {
          offenders.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
        }
      }
    }
    expect(
      offenders,
      "The app CSP is `img-src 'self' data: blob:` — a remote image can never render. " +
        "Commit the asset next to the doc and reference it relatively.",
    ).toEqual([]);
  });
});
