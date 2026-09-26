import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFrontmatter } from "@/lib/docs/frontmatter";
import { renderDocument } from "@/lib/docs/render/pipeline.server";
import type { DocSpace } from "@/lib/docs/source/types";

/**
 * F-90 / F-91 against the content we ship: every link the viewer renders from
 * `docs/` and `help/` must land. CI's lychee job checks the Markdown the way
 * GitHub resolves it, which is not what the viewer emitted: every story link
 * in `docs/uat/README.md` and every `../` link 404'd inside `/en/app` while
 * lychee stayed green. This renders each file with its own slug and follows
 * the output: an in-app document route must name a shipped document, a
 * `#fragment` an id in the document it points at, and an image a shipped file.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const SPACES: DocSpace[] = ["docs", "help"];

interface Rendered {
  space: DocSpace;
  slug: string;
  html: string;
  ids: Set<string>;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.mdx?$/i.test(entry)) out.push(full);
  }
  return out;
}

const attrValues = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) =>
    m[1]!.replace(/&#x26;/g, "&").replace(/&amp;/g, "&"),
  );

const rendered = new Map<string, Rendered>();
const key = (space: DocSpace, slug: string) => `${space}:${slug}`;

beforeAll(async () => {
  for (const space of SPACES) {
    const root = path.join(REPO_ROOT, space);
    for (const file of walk(root)) {
      const slug = path
        .relative(root, file)
        .split(path.sep)
        .join("/")
        .replace(/\.mdx?$/i, "");
      const { content } = parseFrontmatter(readFileSync(file, "utf8"));
      const { html } = await renderDocument(content, { locale: "en", space, slug });
      rendered.set(key(space, slug), { space, slug, html, ids: new Set(attrValues(html, "id")) });
    }
  }
}, 120_000);

describe("links rendered from shipped docs and help (F-90, F-91)", () => {
  it("renders every shipped document", () => {
    expect(rendered.size).toBeGreaterThan(50);
    expect(rendered.has("docs:uat/README")).toBe(true);
  });

  it("points every in-app document link at a shipped document and a real id in it", () => {
    const dead: string[] = [];
    let crossDoc = 0;
    for (const doc of rendered.values()) {
      for (const href of attrValues(doc.html, "href")) {
        if (/^(?:https?:|mailto:|\/\/)/i.test(href)) continue;
        const where = `${doc.space}/${doc.slug}.md -> ${href}`;
        const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
        if (href.startsWith("#")) {
          if (fragment && !doc.ids.has(decodeURIComponent(fragment))) dead.push(where);
          continue;
        }
        const route = /^\/en\/app\/(docs|help)\/([^?#]+)/.exec(href);
        if (!route) {
          // Still relative: the browser resolves it under /en/app/<space>/.
          if (!href.startsWith("/")) dead.push(where);
          continue;
        }
        crossDoc++;
        const target = rendered.get(key(route[1] as DocSpace, decodeURIComponent(route[2]!)));
        if (!target) dead.push(where);
        else if (fragment && !target.ids.has(decodeURIComponent(fragment))) dead.push(where);
      }
    }
    expect(dead).toEqual([]);
    // Guard against a vacuous pass: the shipped docs link to each other a lot,
    // and heading self-anchors alone must not meet it.
    expect(crossDoc).toBeGreaterThan(300);
  });

  it("unlinks only what leaves the space or is not a document", () => {
    const wronglyUnlinked: string[] = [];
    let unlinked = 0;
    for (const doc of rendered.values()) {
      for (const href of attrValues(doc.html, "data-unlinked-href")) {
        unlinked++;
        const target = decodeURIComponent(href.split(/[?#]/)[0]!);
        const resolved = path.posix.join(path.posix.dirname(doc.slug), target);
        const leaves = resolved === ".." || resolved.startsWith("../");
        if (!leaves && /\.mdx?$/i.test(resolved)) {
          wronglyUnlinked.push(`${doc.space}/${doc.slug}.md -> ${href}`);
        }
      }
    }
    expect(wronglyUnlinked).toEqual([]);
    // `../SECURITY.md`, `./openapi.json` and the like are shipped today.
    expect(unlinked).toBeGreaterThan(0);
  });

  it("points every image at a shipped file in its space", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const doc of rendered.values()) {
      // An image outside the space renders as its alt text only.
      for (const src of attrValues(doc.html, "data-unlinked-src")) {
        missing.push(`${doc.space}/${doc.slug}.md -> ${src}`);
      }
      for (const src of attrValues(doc.html, "src")) {
        checked++;
        const asset = /^\/api\/(docs|help)\/asset\/(.+)$/.exec(src);
        if (!asset || asset[1] !== doc.space) {
          missing.push(`${doc.space}/${doc.slug}.md -> ${src}`);
          continue;
        }
        const file = path.join(REPO_ROOT, asset[1], ...decodeURIComponent(asset[2]!).split("/"));
        if (!existsSync(file)) missing.push(`${doc.space}/${doc.slug}.md -> ${src}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });

  it("uses no id the shell owns (F-91)", () => {
    for (const doc of rendered.values()) {
      for (const id of doc.ids) expect(id, `${doc.space}/${doc.slug}.md`).toMatch(/^user-content-/);
    }
  });
});
