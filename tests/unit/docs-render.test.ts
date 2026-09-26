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
    expect(html).toContain('id="user-content-section-a"');
    expect(headings.map((h) => h.id)).toEqual(["user-content-section-a", "user-content-sub-b"]);
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

  it("treats a protocol-relative image as remote, not root-relative (review #215)", async () => {
    // `//cdn.example.com/x.png` inherits the page scheme, so on an https page
    // the browser fetches https://cdn.example.com/x.png — which `img-src
    // 'self' data: blob:` blocks. It used to slip past BOTH arms of the image
    // branch (the scheme-only remote test missed it, and `startsWith("/")`
    // claimed it as root-relative) and ship as a bare <img>.
    const { html } = await renderDocument("![Diagram](//cdn.example.com/x.png)", { locale: "en" });

    expect(html).not.toContain("<img");
    expect(html).toContain('href="//cdn.example.com/x.png"');
    expect(html).toContain('data-external-image="//cdn.example.com/x.png"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Diagram (//cdn.example.com/x.png)");
    // It must NOT have been rewritten into the local asset route.
    expect(html).not.toContain("/api/docs/asset/");
  });

  it("gives a protocol-relative link the external-anchor treatment (review #215)", async () => {
    const { html } = await renderDocument("[x](//evil.example.com)", { locale: "en" });
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
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

const attrValues = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]!);

/**
 * F-90: a relative link resolves against the directory of the document it is
 * in, as on GitHub and in CI's lychee job. The viewer used to resolve it
 * against the space root, so every link in `docs/uat/README.md` lost its
 * `uat/` and `../x.md` became `/{locale}/app/x`: both 404s inside the app.
 */
describe("renderDocument relative links (F-90)", () => {
  beforeEach(() => clearRenderCache());

  it("resolves links against the document's own directory", async () => {
    const md = [
      "[story](./public-auth.md) [journeys](journeys.md?tab=1)",
      "[up](../admin-manager.md#roles) [mdx](../guide.mdx)",
    ].join("\n\n");
    const { html } = await renderDocument(md, { locale: "en", slug: "uat/README" });
    expect(attrValues(html, "href")).toEqual([
      "/en/app/docs/uat/public-auth",
      "/en/app/docs/uat/journeys?tab=1",
      "/en/app/docs/admin-manager#user-content-roles",
      "/en/app/docs/guide",
    ]);
  });

  it("turns a link the viewer cannot serve into plain text instead of an in-app 404", async () => {
    const md = [
      "[policy](../SECURITY.md) [ci](../.github/workflows/ci.yml)",
      "[spec](./openapi.json) [encoded](%2e%2e/SECURITY.md)",
    ].join("\n\n");
    const { html } = await renderDocument(md, { locale: "en", slug: "api" });
    expect(html).not.toContain("<a");
    expect(attrValues(html, "data-unlinked-href")).toEqual([
      "../SECURITY.md",
      "../.github/workflows/ci.yml",
      "./openapi.json",
      "%2e%2e/SECURITY.md",
    ]);
    // The author's link text still reads.
    expect(html).toContain('<span data-unlinked-href="../SECURITY.md">policy</span>');

    // A non-document inside a nested directory too: it is not a route.
    const nested = await renderDocument("[csv](./uat-stories.csv) [root](../../README.md)", {
      locale: "en",
      slug: "uat/README",
    });
    expect(nested.html).not.toContain("<a");
  });

  it("resolves images against the document's directory and drops one outside the root", async () => {
    const md = "![a](shot.png) ![b](../screenshots/x.png) ![c](../../outside.png) ![](../../y.png)";
    const { html } = await renderDocument(md, { locale: "en", space: "help", slug: "sub/page" });
    expect(attrValues(html, "src")).toEqual([
      "/api/help/asset/sub/shot.png",
      "/api/help/asset/screenshots/x.png",
    ]);
    // The escaping image has no URL left to load, so it is not an <img> (the
    // article would make a src-less one an "expand" button with nothing to
    // show): its alt text reads in its place.
    expect(html).toContain('<span data-unlinked-src="../../outside.png">c</span>');
    expect(html).toContain('<span data-unlinked-src="../../y.png"></span>');
    expect(html.match(/<img/g)).toHaveLength(2);
  });

  it("leaves other schemes and absolute in-app links alone", async () => {
    const md = "[mail](mailto:ops@example.com) [abs](/en/app/help/README)";
    const { html } = await renderDocument(md, { locale: "en", slug: "uat/README" });
    expect(attrValues(html, "href")).toEqual(["mailto:ops@example.com", "/en/app/help/README"]);
  });

  it("never serves one document's cached render for another slug", async () => {
    const a = await renderDocument("[x](x.md)", { locale: "en", slug: "a/doc", cacheKey: "k|1" });
    const b = await renderDocument("[x](x.md)", { locale: "en", slug: "b/doc", cacheKey: "k|1" });
    expect(a.html).toContain('href="/en/app/docs/a/x"');
    expect(b.html).toContain('href="/en/app/docs/b/x"');
  });
});

/**
 * F-91: the rendered article lives inside the shell's DOM, so its ids share a
 * namespace with the shell's. `## Navigation` (a section of all 30 help
 * pages) became a second `id="navigation"`, and the TOC entry, the heading's
 * own anchor and the skip link all jumped to the root sidebar. Footnote ids
 * were prefixed twice, so no footnote link worked, and a heading holding a
 * link was wrapped in a second anchor.
 */
describe("renderDocument ids (F-91)", () => {
  beforeEach(() => clearRenderCache());

  it("keeps heading ids off the shell's landmark ids, and in-document links follow", async () => {
    const md = ["## Navigation", "", "## Main", "", "See [nav](#navigation)."].join("\n");
    const { html, headings } = await renderDocument(md, { locale: "en", space: "help" });
    expect(attrValues(html, "id")).toEqual(["user-content-navigation", "user-content-main"]);
    expect(headings.map((h) => h.id)).toEqual(["user-content-navigation", "user-content-main"]);
    // The author's link and the heading's own anchor both reach the heading.
    expect(attrValues(html, "href")).toEqual([
      "#user-content-navigation",
      "#user-content-main",
      "#user-content-navigation",
    ]);
  });

  it("gives footnotes one prefix, so every reference and back-reference lands", async () => {
    const md = ["A claim[^1] and another[^note].", "", "[^1]: One.", "[^note]: Two."].join("\n");
    const { html } = await renderDocument(md, { locale: "en" });
    const ids = new Set(attrValues(html, "id"));
    const fragments = attrValues(html, "href").filter((href) => href.startsWith("#"));
    expect(fragments.length).toBeGreaterThanOrEqual(4);
    for (const href of fragments) expect(ids, href).toContain(href.slice(1));
    expect(html).not.toContain("user-content-user-content-");
    // aria-describedby names the (prefixed) footnote label heading.
    for (const id of attrValues(html, "aria-describedby")) expect(ids).toContain(id);
  });

  it("does not wrap a heading that already holds a link in a second anchor", async () => {
    const { html, headings } = await renderDocument(
      "#### Google — [Console](https://console.example.com)",
      { locale: "en" },
    );
    expect(html).toBe(
      '<h4 id="user-content-google--console">Google — <a href="https://console.example.com" target="_blank" rel="noopener noreferrer">Console</a></h4>',
    );
    expect(headings.map((h) => h.id)).toEqual(["user-content-google--console"]);
  });

  it("slugs and lists a heading by its own text, not a remote image's fallback link", async () => {
    // `#status-` is the id GitHub and lychee give `## Status ![build](…)`.
    const md = [
      "## Status ![build](https://img.shields.io/badge/ci-green.svg)",
      "",
      "## Plain ![](https://x.example/a.png)",
      "",
      "[jump](#status-)",
    ].join("\n");
    const { html, headings } = await renderDocument(md, { locale: "en" });
    expect(headings).toEqual([
      { depth: 2, id: "user-content-status-", text: "Status" },
      { depth: 2, id: "user-content-plain-", text: "Plain" },
    ]);
    const ids = new Set(attrValues(html, "id"));
    expect(ids).toEqual(new Set(["user-content-status-", "user-content-plain-"]));
    expect(html).toContain('href="#user-content-status-"');
    // The fallback link is the heading's only anchor: no second one wraps it.
    expect(html).toContain(
      '<h2 id="user-content-status-">Status <a href="https://img.shields.io/badge/ci-green.svg"',
    );
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
