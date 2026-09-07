import "server-only";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeStringify from "rehype-stringify";
import { docsSanitizeSchema } from "./sanitize-schema";
import type { DocSpace } from "../source/types";

/**
 * Markdown → safe HTML pipeline for the documentation viewer.
 *
 * Ordering is a security decision: untrusted content is **sanitized
 * first**, then the trusted transforms (heading ids, anchor links,
 * Shiki highlighting, link/image rewriting) run on the already-safe
 * tree. Because the highlighter runs after sanitize, the only inline
 * styles in the output come from the trusted theme — never from author
 * input. No author JavaScript is ever executed: `allowDangerousHtml:
 * false` drops raw HTML/JSX tags, and MDX expressions are never evaluated —
 * there is no MDX parser in the chain, so `{expr}` and `import` lines
 * render as literal text (review #171).
 */

export interface DocHeading {
  depth: number;
  id: string;
  text: string;
}

export interface RenderedDoc {
  html: string;
  headings: DocHeading[];
}

export interface RenderOptions {
  /** Active locale — used to rewrite relative doc links into the route. */
  locale: string;
  /** Cache key (typically `slug|updatedAt`); skips re-rendering when hit. */
  cacheKey?: string;
  /**
   * Content space the document belongs to — selects the app route base
   * (`/app/<space>`) and asset route (`/api/<space>/asset`) that relative
   * links/images are rewritten to. Defaults to the docs viewer.
   */
  space?: DocSpace;
}

/* ----------------------------- hast helpers ----------------------------- */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (!node.children) return "";
  return node.children.map(textOf).join("");
}

function walk(node: HastNode, visit: (n: HastNode) => void): void {
  visit(node);
  if (node.children) for (const child of node.children) walk(child, visit);
}

/**
 * Collects heading ids/text into `sink` (after rehype-slug has assigned
 * ids). Depths 2–4 only — h1 is the page title, deeper headings rarely
 * belong in a TOC.
 */
function rehypeCollectHeadings(sink: DocHeading[]) {
  return (tree: HastNode) => {
    walk(tree, (node) => {
      if (node.type !== "element" || !node.tagName) return;
      const match = /^h([1-6])$/.exec(node.tagName);
      if (!match) return;
      const depth = Number(match[1]);
      if (depth < 2 || depth > 4) return;
      const id = typeof node.properties?.id === "string" ? node.properties.id : "";
      if (!id) return;
      sink.push({ depth, id, text: textOf(node).trim() });
    });
  };
}

/**
 * Matches a remote URL, including the **protocol-relative** form (review #215).
 *
 * `//host/path` is remote: the browser inherits the page's scheme, so on an
 * https page it resolves to `https://host/path`. A scheme-only pattern
 * (`/^https?:\/\//`) missed it, and because `"//host/x.png".startsWith("/")`
 * is also true, such an image fell through BOTH arms of the branch below and
 * was emitted untouched — exactly the CSP-blocked broken-image box this
 * fallback exists to prevent. `hast-util-sanitize` does not catch it either:
 * its protocol check only applies when a `:` precedes the first `/`, so
 * `protocols.src: ["https"]` reads `//host/...` as a relative URL. The same
 * blind spot skipped the `target=_blank` + `rel="noopener noreferrer"`
 * treatment for `[x](//host)` anchors.
 */
const EXTERNAL = /^(?:https?:)?\/\//i;
const DOC_LINK = /\.mdx?(?=$|[#?])/i;

/**
 * Turns a remote `<img>` into a visible, working link (review #215).
 *
 * The app's CSP is `img-src 'self' data: blob:` — a remote `<img>` that
 * survives the renderer is BLOCKED by the browser and the reader just sees a
 * broken-image box with no explanation. Loosening the CSP to fetch third-party
 * images into an authenticated console is the worse trade (it hands any doc
 * author a pixel that leaks the reader's IP/`Referer` to an arbitrary host and
 * widens the exfiltration surface), so we keep the CSP closed and make the
 * failure visible instead: the node becomes an external anchor whose text is
 * the alt text (when the author supplied one) plus the URL, so the reader can
 * still see what was meant and open it deliberately.
 *
 * Locale-neutral by construction — the visible text is author content and the
 * URL, never a UI string — so the render cache stays shareable and no message
 * catalog has to grow a key.
 */
function toExternalImageFallback(node: HastNode, src: string): void {
  const alt = typeof node.properties?.alt === "string" ? node.properties.alt.trim() : "";
  node.tagName = "a";
  node.properties = {
    href: src,
    target: "_blank",
    rel: "noopener noreferrer",
    className: ["docs-external-image"],
    // Machine-readable marker so tests (and any future lint) can spot a doc
    // that ships a remote image without scraping rendered prose.
    "data-external-image": src,
  };
  node.children = [{ type: "text", value: alt ? `${alt} (${src})` : src }];
}

/**
 * Rewrites links and images on the sanitized tree:
 *   - relative `*.md`/`*.mdx` links → `/{locale}/app/{space}/{slug}` routes
 *   - relative image `src` → the space's path-safe asset route
 *   - remote image `src` (`https://…` **or** `//host/…`) → a visible
 *     external-link fallback (review #215)
 *   - external links get `target="_blank"` + `rel="noopener noreferrer"`
 *
 * Hash links and already-absolute in-app links are left untouched. Author
 * hrefs with dangerous protocols were already removed by sanitize.
 */
function rehypeRewriteLinks(locale: string, space: DocSpace) {
  return (tree: HastNode) => {
    walk(tree, (node) => {
      if (node.type !== "element") return;
      const props = node.properties ?? (node.properties = {});

      if (node.tagName === "a" && typeof props.href === "string") {
        const href = props.href;
        if (EXTERNAL.test(href)) {
          props.target = "_blank";
          props.rel = "noopener noreferrer";
        } else if (!href.startsWith("#") && !href.startsWith("/") && DOC_LINK.test(href)) {
          const clean = href.replace(/^\.\//, "").replace(DOC_LINK, "");
          props.href = `/${locale}/app/${space}/${clean}`;
        }
      }

      if (node.tagName === "img" && typeof props.src === "string") {
        const src = props.src;
        // Order matters (review #215): `//host/x.png` satisfies
        // `startsWith("/")`, so the remote test has to run first or a
        // protocol-relative image is mistaken for a root-relative one.
        if (EXTERNAL.test(src)) {
          toExternalImageFallback(node, src);
        } else if (!src.startsWith("/")) {
          const clean = src.replace(/^\.\//, "");
          props.src = `/api/${space}/asset/${clean}`;
        }
      }
    });
  };
}

/** Reads a hast `className` (array or space-separated string) as a list. */
function classList(node: HastNode): string[] {
  const cls = node.properties?.className;
  if (Array.isArray(cls)) return cls.map(String);
  if (typeof cls === "string") return cls.split(/\s+/);
  return [];
}

/** A `<pre>` is a Mermaid block when its `<code>` carries `language-mermaid`. */
function asMermaidSource(node: HastNode): string | null {
  if (node.type !== "element" || node.tagName !== "pre" || !node.children) return null;
  const code = node.children.find((c) => c.type === "element" && c.tagName === "code");
  if (!code || !classList(code).includes("language-mermaid")) return null;
  return textOf(code).replace(/\n$/, "");
}

/**
 * Converts ```mermaid fenced blocks into a `<div class="mermaid not-prose">`
 * mount point whose text content is the raw diagram source. Runs AFTER
 * sanitize (so the source is already safe text) and BEFORE the syntax
 * highlighter (which therefore skips these blocks — they are no longer
 * `pre > code`). The client `DocArticle` lazily renders these mounts with
 * Mermaid; if its JS never runs, the source stays visible as a fallback.
 */
function rehypeMermaid() {
  return (tree: HastNode) => {
    const transform = (node: HastNode): void => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const source = asMermaidSource(child);
        if (source !== null) {
          return {
            type: "element",
            tagName: "div",
            properties: { className: ["mermaid", "not-prose"] },
            children: [{ type: "text", value: source }],
          } satisfies HastNode;
        }
        transform(child);
        return child;
      });
    };
    transform(tree);
  };
}

/* ------------------------------ rendering ------------------------------- */

const renderCache = new Map<string, RenderedDoc>();

/** Test seam: clear the rendered-document cache. */
export function clearRenderCache(): void {
  renderCache.clear();
}

export async function renderDocument(body: string, options: RenderOptions): Promise<RenderedDoc> {
  const { locale, cacheKey, space = "docs" } = options;
  // Scope cache entries by space AND locale — a docs and a help document may
  // share a slug (e.g. `README`) yet must never return each other's HTML, and
  // the rendered HTML embeds `/{locale}/app/...` hrefs, so an `en` render
  // handed to an `fr` reader would send every in-doc link to the wrong locale.
  const scopedKey = cacheKey ? `${space}|${locale}|${cacheKey}` : undefined;
  if (scopedKey) {
    const hit = renderCache.get(scopedKey);
    if (hit) return hit;
  }

  const headings: DocHeading[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, docsSanitizeSchema)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(() => rehypeCollectHeadings(headings))
    .use(() => rehypeRewriteLinks(locale, space))
    .use(rehypeMermaid)
    .use(rehypePrettyCode, {
      theme: { light: "github-light", dark: "github-dark" },
      keepBackground: true,
    })
    .use(rehypeStringify)
    .process(body);

  const rendered: RenderedDoc = { html: String(file), headings };
  if (scopedKey) renderCache.set(scopedKey, rendered);
  return rendered;
}
