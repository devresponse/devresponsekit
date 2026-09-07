import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "@/lib/docs/frontmatter";

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

/**
 * A URL the CSP cannot load: an absolute `https?://…` **or** the
 * protocol-relative `//host/…` form (review #215). The latter inherits the
 * page scheme, so it is every bit as remote — matching only `https?://` left
 * the lint blind to `![a](//host/x.png)`, the very input that also slipped
 * past the renderer's fallback.
 */
const REMOTE_URL = /^(?:https?:)?\/\//i;

/** Inline image: `![alt](https://…)` or `![alt](//host/…)`. */
const INLINE_REMOTE_IMAGE = /!\[[^\]]*\]\(\s*<?\s*(?:https?:)?\/\//i;
/** Raw HTML image: `<img src="https://…">` or `<img src="//host/…">`. */
const HTML_REMOTE_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i;
/** Reference-style image use: `![alt][ref]`, `![alt][]`, or `![alt]`. */
const IMAGE_REFERENCE = /!\[([^\]]*)\](?:\[([^\]]*)\])?/g;
/** Link reference definition: `[ref]: <url>`. */
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)/gm;

/**
 * Reference labels used by *images* (not plain links — a remote link is fine,
 * only a remote image is unloadable). Inline images are excluded here; they
 * are covered by {@link INLINE_REMOTE_IMAGE}.
 */
function imageReferenceLabels(body: string): Set<string> {
  const labels = new Set<string>();
  for (const match of body.matchAll(IMAGE_REFERENCE)) {
    const [whole, alt = "", explicit] = match;
    // `![alt](…)` is an inline image, not a reference.
    if (explicit === undefined && body[(match.index ?? 0) + whole.length] === "(") continue;
    const label = (explicit && explicit.trim().length > 0 ? explicit : alt).trim().toLowerCase();
    if (label.length > 0) labels.add(label);
  }
  return labels;
}

/**
 * Every remote image URL a document ships, in any Markdown/HTML spelling.
 * Returns the offending URLs so a failure names what to fix.
 */
function remoteImageUrls(body: string): string[] {
  const found: string[] = [];
  const inline = INLINE_REMOTE_IMAGE.exec(body);
  if (inline) found.push(inline[0]);
  const html = HTML_REMOTE_IMAGE.exec(body);
  if (html) found.push(html[0]);

  const labels = imageReferenceLabels(body);
  if (labels.size > 0) {
    for (const match of body.matchAll(REFERENCE_DEFINITION)) {
      const label = match[1]!.trim().toLowerCase();
      const url = match[2] ?? "";
      if (labels.has(label) && REMOTE_URL.test(url)) found.push(url);
    }
  }
  return found;
}

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

  it("keeps the moved docs-viewer design spec in docs/, hidden from the viewer by default (review #216)", () => {
    const moved = path.join(REPO_ROOT, "docs", "design-docs-viewer.md");
    expect(existsSync(moved)).toBe(true);
    // Parse the frontmatter block rather than regexing the file: the body
    // prose of this very document quotes the literal string
    // "`visibility: internal`", so a whole-file regex was satisfied even when
    // the real frontmatter said `public` — i.e. it proved nothing about
    // whether catalog.server.ts hides the spec from every `shell.view` member.
    expect(parseFrontmatter(readFileSync(moved, "utf8")).data.visibility).toBe("internal");
  });

  it("reads visibility from the frontmatter block, not from body prose (review #216)", () => {
    const proseOnly = [
      "---",
      "title: X",
      "visibility: public",
      "---",
      "",
      "`visibility: internal`",
    ];
    expect(parseFrontmatter(proseOnly.join("\n")).data.visibility).toBe("public");
  });

  it("ships no remote image references in docs/ or help/ (review #215)", () => {
    const offenders: string[] = [];
    for (const dir of CONTENT_DIRS) {
      for (const file of walk(path.join(REPO_ROOT, dir), isMarkdown)) {
        const remote = remoteImageUrls(readFileSync(file, "utf8"));
        if (remote.length > 0) {
          const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
          offenders.push(`${rel}: ${remote.join(", ")}`);
        }
      }
    }
    expect(
      offenders,
      "The app CSP is `img-src 'self' data: blob:` — a remote image can never render. " +
        "Commit the asset next to the doc and reference it relatively.",
    ).toEqual([]);
  });

  it("detects every spelling of a remote image reference (review #215)", () => {
    // The scan above passes vacuously while docs/ is clean, so pin the
    // detector itself: each of these was (or would be) a silent CSP failure.
    const offending = [
      "![a](https://cdn.example.com/x.png)",
      "![a](http://cdn.example.com/x.png)",
      "![a](//cdn.example.com/x.png)",
      '<img src="https://cdn.example.com/x.png">',
      '<img alt="a" src="//cdn.example.com/x.png" />',
      "![a][ref]\n\n[ref]: //cdn.example.com/x.png",
      "![a][ref]\n\n[ref]: https://cdn.example.com/x.png",
      "![a][]\n\n[a]: //cdn.example.com/x.png",
      "![a]\n\n[a]: https://cdn.example.com/x.png",
    ];
    for (const sample of offending) {
      expect(remoteImageUrls(sample), sample).not.toEqual([]);
    }

    const allowed = [
      "![a](images/x.png)",
      "![a](./images/x.png)",
      "![a](/api/docs/asset/x.png)",
      '<img src="images/x.png">',
      // A remote *link* is fine — only images are CSP-blocked.
      "[a](https://example.com)",
      "[a][ref]\n\n[ref]: https://example.com",
      // A definition nothing references as an image stays out of it.
      "[ref]: https://cdn.example.com/x.png",
    ];
    for (const sample of allowed) {
      expect(remoteImageUrls(sample), sample).toEqual([]);
    }
  });
});
