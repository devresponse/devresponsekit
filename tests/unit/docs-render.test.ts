import { beforeEach, describe, expect, it } from "vitest";
import { clearRenderCache, renderDocument } from "@/lib/docs/render/pipeline.server";

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
});
