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

  // Review #114: gray-matter's js-yaml is floored at 3.15.2 (`js-yaml@3` in
  // pnpm.overrides) — the line that patches the merge-key (`<<`) and `!!omap`
  // quadratic-CPU advisories. These pin that (a) the patched parser is the one
  // gray-matter actually loads and (b) ordinary YAML features the docs use,
  // plus the very constructs the advisories cover, still parse correctly.
  it("gray-matter parses frontmatter with the patched js-yaml 3.15.x line", async () => {
    const { createRequire } = await import("node:module");
    const requireFromGrayMatter = createRequire(
      createRequire(import.meta.url).resolve("gray-matter"),
    );
    const { version } = requireFromGrayMatter("js-yaml/package.json") as { version: string };
    const [major, minor, patch] = version.split(".").map(Number);
    expect(major).toBe(3);
    expect(minor! * 1000 + patch!).toBeGreaterThanOrEqual(15 * 1000 + 2);
  });

  it("still resolves YAML merge keys and keeps parsing the body", () => {
    const raw = [
      "---",
      "_base: &base",
      "  group: Guides",
      "  visibility: internal",
      "title: Merged",
      "<<: *base",
      "tags: [a, b]",
      "---",
      "# Merged body",
    ].join("\n");
    const { data, content } = parseFrontmatter(raw);
    expect(data.title).toBe("Merged");
    expect(data.group).toBe("Guides");
    expect(data.visibility).toBe("internal");
    expect(data.tags).toEqual(["a", "b"]);
    expect(content).toContain("# Merged body");
  });

  it("rejects an oversized merge sequence outright (GHSA-52cp-r559-cp3m guard)", () => {
    // The quadratic-CPU input: one `<<` key merging hundreds of anchors. The
    // patched 3.15.x loader caps a merge sequence at 100 entries and throws
    // `abnormal merge sequence size` instead of grinding; 3.14.x accepted it.
    const anchors = Array.from({ length: 200 }, (_, i) => `_a${i}: &a${i} { k${i}: v }`);
    const merges = `<<: [${Array.from({ length: 200 }, (_, i) => `*a${i}`).join(", ")}]`;
    const raw = ["---", ...anchors, merges, "title: Big", "---", "body"].join("\n");
    const started = Date.now();
    expect(() => parseFrontmatter(raw)).toThrow(/abnormal merge sequence size/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("parses a large !!omap block in linear time (GHSA-5p4m-2wfm-xmqj)", () => {
    // 3.14.x de-duplicated omap keys with a nested scan (O(n²)); the patched
    // line uses a hash set. Keep the budget generous so only a real
    // regression (seconds, not milliseconds) trips it.
    const omap = ["_o: !!omap", ...Array.from({ length: 5_000 }, (_, i) => `  - k${i}: ${i}`)];
    const raw = ["---", ...omap, "title: Big", "---", "body"].join("\n");
    const started = Date.now();
    const { data, content } = parseFrontmatter(raw);
    expect(data.title).toBe("Big");
    expect(content.trim()).toBe("body");
    expect(Date.now() - started).toBeLessThan(5_000);
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
