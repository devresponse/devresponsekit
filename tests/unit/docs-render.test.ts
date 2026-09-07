import { beforeEach, describe, expect, it } from "vitest";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { clearRenderCache, renderDocument } from "@/lib/docs/render/pipeline.server";
import { docsSanitizeSchema } from "@/lib/docs/render/sanitize-schema";

/**
 * The render pipeline is the XSS boundary: it must neutralize anything an
 * author could embed and only emit safe, trusted HTML. These tests assert
 * the security guarantees and the trusted transforms (ids, link/image
 * rewriting, highlighting, heading collection).
 */
describe("renderDocument", () => {
  beforeEach(() => clearRenderCache());

  it("strips scripts, event handlers, and javascript: URLs", async () => {
    const md = [
      "# Title",
      "",
      "<script>alert('xss')</script>",
      "",
      '<img src="x" onerror="alert(1)">',
      "",
      "[bad](javascript:alert(1))",
    ].join("\n");
    const { html } = await renderDocument(md, { locale: "en" });
    expect(html).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("onerror");
    expect(html.toLowerCase()).not.toContain("javascript:");
  });

  it("assigns heading ids and collects a table of contents (depths 2–4)", async () => {
    const md = ["# Page", "", "## Section A", "text", "", "### Sub B", "text"].join("\n");
    const { html, headings } = await renderDocument(md, { locale: "en" });
    expect(html).toContain('id="section-a"');
    expect(headings.map((h) => h.id)).toEqual(["section-a", "sub-b"]);
    expect(headings.map((h) => h.depth)).toEqual([2, 3]);
    // h1 is excluded from the TOC.
    expect(headings.some((h) => h.depth === 1)).toBe(false);
  });

  it("rewrites relative doc links into the locale route", async () => {
    const { html } = await renderDocument("[setup](setup-better-auth.md)", { locale: "fr" });
    expect(html).toContain('href="/fr/app/docs/setup-better-auth"');
  });

  it("marks external links with rel/target and rewrites relative images", async () => {
    const md = ["[ext](https://example.com)", "", "![pic](images/diagram.png)"].join("\n");
    const { html } = await renderDocument(md, { locale: "en" });
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('src="/api/docs/asset/images/diagram.png"');
  });

  it("highlights fenced code with the dual Shiki theme", async () => {
    const md = ["```js", "const x = 1;", "```"].join("\n");
    const { html } = await renderDocument(md, { locale: "en" });
    expect(html).toMatch(/--shiki-light/);
    expect(html).toMatch(/data-language="js"/);
  });

  it("serves a cached render on a repeat cacheKey", async () => {
    const first = await renderDocument("# Cached", { locale: "en", cacheKey: "k|1" });
    const second = await renderDocument("# DIFFERENT", { locale: "en", cacheKey: "k|1" });
    expect(second.html).toBe(first.html);
  });

  it("rewrites links and images into the help space when space is 'help'", async () => {
    const md = ["[intro](README.md)", "", "![shot](screenshots/01-landing.png)"].join("\n");
    const { html } = await renderDocument(md, { locale: "en", space: "help" });
    expect(html).toContain('href="/en/app/help/README"');
    expect(html).toContain('src="/api/help/asset/screenshots/01-landing.png"');
  });

  it("never serves one space's cached render to the other space", async () => {
    // Same cacheKey (e.g. two `README` docs with equal mtimes) — the cache
    // must still be keyed by space or the wrong HTML leaks across viewers.
    const docs = await renderDocument("[a](a.md)", { locale: "en", cacheKey: "README|1" });
    const help = await renderDocument("[a](a.md)", {
      locale: "en",
      cacheKey: "README|1",
      space: "help",
    });
    expect(docs.html).toContain('href="/en/app/docs/a"');
    expect(help.html).toContain('href="/en/app/help/a"');
  });

  it("extracts mermaid blocks into a client mount instead of highlighting them", async () => {
    const md = [
      "```mermaid",
      "erDiagram",
      "  A ||--o{ B : has",
      "```",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    const { html } = await renderDocument(md, { locale: "en" });
    // Mermaid block becomes a .mermaid mount holding the raw source...
    expect(html).toMatch(/<div class="mermaid not-prose">/);
    expect(html).toContain("erDiagram");
    expect(html).toContain("A ||--o{ B : has");
    // ...and is NOT run through the syntax highlighter.
    expect(html).not.toContain('data-language="mermaid"');
    // The adjacent js block IS still highlighted, proving only mermaid is special-cased.
    expect(html).toMatch(/data-language="js"/);
  });

  it("replaces a remote image with a visible external link instead of a CSP-blocked <img> (review #215)", async () => {
    // `img-src 'self' data: blob:` blocks remote images, so an <img> that
    // survives the renderer is an invisible failure — a broken box with no
    // explanation. The pipeline must turn it into something the reader can see
    // and act on.
    const md = "![Architecture diagram](https://cdn.example.com/arch.png)";
    const { html } = await renderDocument(md, { locale: "en" });

    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://cdn.example.com/arch.png"');
    expect(html).toContain('data-external-image="https://cdn.example.com/arch.png"');
    expect(html).toContain('rel="noopener noreferrer"');
    // Visible text carries the alt text AND the URL.
    expect(html).toContain("Architecture diagram (https://cdn.example.com/arch.png)");
    // Local images are untouched by this rule.
    const local = await renderDocument("![pic](images/a.png)", { locale: "en" });
    expect(local.html).toContain('<img src="/api/docs/asset/images/a.png"');
  });

  it("falls back to the bare URL when a remote image has no alt text (review #215)", async () => {
    const { html } = await renderDocument("![](https://cdn.example.com/x.png)", { locale: "en" });
    expect(html).toContain(">https://cdn.example.com/x.png</a>");
  });

  it("drops a plain-http image src (protocols.src is https-only, review #215)", async () => {
    const { html } = await renderDocument("![a](http://cdn.example.com/x.png)", { locale: "en" });
    // Sanitize removed the attribute, so there is no URL left to link to and
    // the browser shows the alt text.
    expect(html).not.toContain("cdn.example.com");
    expect(html).toContain('alt="a"');
  });

  it("never serves one locale's cached render to another locale", async () => {
    // The rendered HTML embeds `/{locale}/app/...` hrefs, so the cache key has
    // to include the locale or French readers follow English links.
    const en = await renderDocument("[a](a.md)", { locale: "en", cacheKey: "README|1" });
    const fr = await renderDocument("[a](a.md)", { locale: "fr", cacheKey: "README|1" });
    expect(en.html).toContain('href="/en/app/docs/a"');
    expect(fr.html).toContain('href="/fr/app/docs/a"');
  });
});

/**
 * Review #214: the sanitize schema must be exactly as wide as the pipeline
 * needs and no wider. `defaultSchema` already allows `code.language-*` (the
 * fence hint the highlighter and the Mermaid detector read); the previous
 * extension appended a BARE `"className"` to `code`/`pre`/`span`, which in
 * hast-util-sanitize means "any value" — widening the allow-list instead of
 * adding to it.
 *
 * These tests drive the schema directly (rather than through Markdown) because
 * `remark-rehype` is configured with `allowDangerousHtml: false`, so authored
 * raw HTML never reaches sanitize from the Markdown path. A Phase-2 source that
 * fed HTML in, or a future pipeline change, would — and the schema is the
 * boundary that has to hold.
 */
describe("docsSanitizeSchema (review #214)", () => {
  /** Sanitizes a hand-built hast fragment and returns the surviving classNames. */
  function classesAfterSanitize(tagName: string, className: string[]): unknown | undefined {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName,
          properties: { className },
          children: [{ type: "text", value: "x" }],
        },
      ],
    };
    const out = rehypeSanitize(docsSanitizeSchema)(tree as never) as unknown as {
      children: Array<{ properties?: Record<string, unknown> }>;
    };
    return out.children[0]?.properties?.className;
  }

  it("strips a hostile className from code, pre, and span", () => {
    for (const tag of ["code", "pre", "span"]) {
      // `code` keeps an (empty) className array because it HAS a className
      // rule; `pre`/`span` lose the property entirely. Either way nothing of
      // the author's class survives.
      expect(classesAfterSanitize(tag, ["attacker-controlled"]) ?? [], tag).toEqual([]);
    }
  });

  it("keeps the language-* fence hint that highlighting and mermaid detection need", () => {
    expect(classesAfterSanitize("code", ["language-ts"])).toEqual(["language-ts"]);
    expect(classesAfterSanitize("code", ["language-mermaid"])).toEqual(["language-mermaid"]);
    // …and only the language-* part of a mixed list survives.
    expect(classesAfterSanitize("code", ["language-ts", "attacker-controlled"])).toEqual([
      "language-ts",
    ]);
  });

  it("allows only https for src (review #215)", () => {
    expect(docsSanitizeSchema.protocols?.src).toEqual(["https"]);
  });

  it("adds no attribute allowances beyond the upstream default", () => {
    expect(docsSanitizeSchema.attributes).toEqual(defaultSchema.attributes);
  });
});
