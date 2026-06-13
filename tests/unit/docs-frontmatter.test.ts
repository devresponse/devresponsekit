import { describe, expect, it } from "vitest";
import { deriveTitle, parseFrontmatter } from "@/lib/docs/frontmatter";

describe("parseFrontmatter", () => {
  it("parses and validates a full frontmatter block", () => {
    const raw = [
      "---",
      "title: Getting Started",
      "description: A quick intro",
      "group: Guides",
      "order: 2",
      "tags: [intro, setup]",
      "visibility: internal",
      'requires: ["docs.read"]',
      "---",
      "# Body heading",
      "",
      "Body text.",
    ].join("\n");

    const { data, content } = parseFrontmatter(raw);
    expect(data.title).toBe("Getting Started");
    expect(data.description).toBe("A quick intro");
    expect(data.group).toBe("Guides");
    expect(data.order).toBe(2);
    expect(data.tags).toEqual(["intro", "setup"]);
    expect(data.visibility).toBe("internal");
    expect(data.requires).toEqual(["docs.read"]);
    expect(content).toContain("# Body heading");
    expect(content).not.toContain("title: Getting Started");
  });

  it("applies safe defaults when fields are absent", () => {
    const { data } = parseFrontmatter("# Just a heading\n\nNo frontmatter here.");
    expect(data.title).toBeUndefined();
    expect(data.visibility).toBe("public");
    expect(data.tags).toEqual([]);
    expect(data.requires).toEqual([]);
  });

  it("accepts comma-separated tags/requires strings", () => {
    const raw = ["---", "tags: a, b ,c", "requires: x.read, y.read", "---", "body"].join("\n");
    const { data } = parseFrontmatter(raw);
    expect(data.tags).toEqual(["a", "b", "c"]);
    expect(data.requires).toEqual(["x.read", "y.read"]);
  });

  it("falls back to defaults on malformed frontmatter rather than throwing", () => {
    // `visibility` is not in the allowed enum → schema fails → defaults.
    const raw = ["---", "visibility: 12345", "order: not-a-number", "---", "body"].join("\n");
    const { data } = parseFrontmatter(raw);
    expect(data.visibility).toBe("public");
    expect(data.order).toBeUndefined();
  });
});

describe("deriveTitle", () => {
  it("uses the first ATX heading when present", () => {
    expect(deriveTitle("intro\n\n# Real Title\n\nmore", "x/y")).toBe("Real Title");
  });

  it("title-cases the slug's last segment as a fallback", () => {
    expect(deriveTitle("no heading here", "guides/setup-better-auth")).toBe("Setup Better Auth");
    expect(deriveTitle("", "api_and_cli_guide")).toBe("Api And Cli Guide");
  });
});
