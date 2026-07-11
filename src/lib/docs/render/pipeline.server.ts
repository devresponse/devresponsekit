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
 * input. No author JavaScript is ever executed (`allowDangerousHtml:
 * false` keeps raw HTML out; MDX expressions are dropped, not run).
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

const EXTERNAL = /^https?:\/\//i;
const DOC_LINK = /\.mdx?(?=$|[#?])/i;

/**
 * Rewrites links and images on the sanitized tree:
 *   - relative `*.md`/`*.mdx` links → `/{locale}/app/{space}/{slug}` routes
 *   - relative image `src` → the space's path-safe asset route
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
        if (!EXTERNAL.test(src) && !src.startsWith("/")) {
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
  // Scope cache entries by space — a docs and a help document may share a
  // slug (e.g. `README`) yet must never return each other's HTML.
  const scopedKey = cacheKey ? `${space}|${cacheKey}` : undefined;
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
