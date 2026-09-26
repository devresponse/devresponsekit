import { afterEach, describe, expect, it } from "vitest";
import { filterCatalogForViewer } from "@/lib/docs/catalog.server";
import { UNSATISFIABLE_REQUIREMENT, deriveTitle, parseFrontmatter } from "@/lib/docs/frontmatter";
import { PERMISSION_KEY_RE } from "@/lib/validation/permissions";
import type { DocCatalogEntry } from "@/lib/docs/source/types";

const doc = (...frontmatter: string[]) =>
  ["---", ...frontmatter, "---", "# Body", "", "text"].join("\n");
const HIDDEN = { visibility: "internal", requires: [UNSATISFIABLE_REQUIREMENT] };

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

  it("hides the doc when an access field is malformed, rather than throwing or making it public (F-87)", () => {
    // It used to fall back to the defaults for the WHOLE block: public, no gate.
    const raw = ["---", "visibility: 12345", "order: not-a-number", "---", "body"].join("\n");
    const { data, issues } = parseFrontmatter(raw);
    expect(data).toMatchObject(HIDDEN);
    expect(data.order).toBeUndefined();
    expect(issues).toEqual(
      expect.arrayContaining([
        "visibility: invalid value ignored",
        "order: invalid value ignored",
        "access metadata cannot be trusted; document hidden",
      ]),
    );
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
    // F-87: parseFrontmatter never throws; the refusal surfaces as an issue
    // and the unreadable block hides the doc.
    const { data, issues } = parseFrontmatter(raw);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(issues.join("\n")).toMatch(/abnormal merge sequence size/);
    expect(data).toMatchObject(HIDDEN);
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

describe("parseFrontmatter: only YAML is ever parsed (F-86)", () => {
  const canary = globalThis as { __docsFrontmatterCanary?: string };
  afterEach(() => {
    delete canary.__docsFrontmatterCanary;
  });

  // gray-matter's default `javascript` engine evals the block. A side effect
  // is the only proof that nothing ran: a refused block and an evaluated one
  // can both end up with the same (hidden) metadata.
  const payload =
    '{ title: (globalThis.__docsFrontmatterCanary = "ran", "Pwned"), visibility: "public" }';

  it.each(["js", "javascript", "JS", "JavaScript", " js "])(
    "never evaluates a ---%s block, ignores its fields and hides the doc",
    (fence) => {
      const { data, content, issues } = parseFrontmatter(
        [`---${fence}`, payload, "---", "# Body"].join("\n"),
      );
      expect(canary.__docsFrontmatterCanary).toBeUndefined();
      expect(data.title).toBeUndefined();
      expect(data).toMatchObject(HIDDEN);
      expect(content).toBe("");
      expect(issues.join("\n")).toMatch(/only YAML frontmatter is accepted/);
    },
  );

  it.each([
    ["json", '{ "title": "J", "visibility": "public" }'],
    ["coffee", 'title: "C"'],
    ["toml", 'title = "T"'],
  ])("refuses a ---%s block too, and hides the doc", (fence, block) => {
    const { data, issues } = parseFrontmatter([`---${fence}`, block, "---", "# Body"].join("\n"));
    expect(data.title).toBeUndefined();
    expect(data).toMatchObject(HIDDEN);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("hides a doc fenced as an Object.prototype member, which gray-matter's engine lookup resolves", () => {
    const { data, issues } = parseFrontmatter(
      ["---constructor", "visibility: internal", "---", "# Body"].join("\n"),
    );
    expect(data).toMatchObject(HIDDEN);
    expect(issues).toContain('frontmatter language "constructor" is not YAML');
  });

  it("still parses an explicit ---yaml / ---yml fence", () => {
    for (const fence of ["yaml", "yml", "YAML"]) {
      const { data, issues } = parseFrontmatter(
        [`---${fence}`, "title: Y", "visibility: internal", "---", "# Body"].join("\n"),
      );
      expect(issues).toEqual([]);
      expect(data).toMatchObject({ title: "Y", visibility: "internal", requires: [] });
    }
  });
});

describe("parseFrontmatter: fields fail one at a time, access fields fail closed (F-87)", () => {
  it("drops only a bad cosmetic field and keeps the access gate beside it", () => {
    // The review's scenario: a fractional `order` used to discard the whole
    // block, making an internal, `requires`-gated runbook public.
    const { data, issues } = parseFrontmatter(
      doc("title: Runbook", "visibility: internal", "requires: admin.audit.read", "order: 10.5"),
    );
    expect(data).toMatchObject({
      title: "Runbook",
      visibility: "internal",
      requires: ["admin.audit.read"],
    });
    expect(data.order).toBeUndefined();
    expect(issues).toEqual(["order: invalid value ignored"]);
  });

  it("drops each bad cosmetic field alone and keeps a public doc public", () => {
    const { data, issues } = parseFrontmatter(
      doc("title: 42", "description: ''", "group: ''", "tags: 7", "order: 3"),
    );
    expect(data).toMatchObject({ order: 3, tags: [], visibility: "public", requires: [] });
    expect(data.title).toBeUndefined();
    expect(data.description).toBeUndefined();
    expect(data.group).toBeUndefined();
    expect(issues).toEqual([
      "title: invalid value ignored",
      "description: invalid value ignored",
      "group: invalid value ignored",
      "tags: invalid value ignored",
    ]);
  });

  it.each([
    ["visibility: Internal"],
    ["visibility: 12345"],
    ["visibility:"],
    ["requires: 42"],
    ["requires: [admin.users.read, 7]"],
    ["requires:"],
  ])("hides the doc for `%s`, keeping its good cosmetic fields", (line) => {
    const { data, issues } = parseFrontmatter(doc("title: Gated", line));
    expect(data).toMatchObject({ title: "Gated", ...HIDDEN });
    expect(issues).toContain("access metadata cannot be trusted; document hidden");
  });

  it.each([
    ["a YAML syntax error", ["---", "title: [unclosed", "---", "# Body"]],
    ["a block that is not a mapping", ["---", "- a", "- b", "---", "# Body"]],
    ["a scalar block", ["---", "just text", "---", "# Body"]],
  ])("hides the doc for %s instead of throwing", (_label, lines) => {
    const parsed = parseFrontmatter(lines.join("\n"));
    expect(parsed.data).toMatchObject(HIDDEN);
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("keeps the documented defaults for ABSENT access fields", () => {
    // "" is an empty (0-byte) file: gray-matter returns early for it, without
    // the `language` it sets on every other result, and reading that used to
    // throw here and take the space's whole catalog down.
    for (const raw of ["", "# No frontmatter", "---\n---\n# Empty block", doc("title: T")]) {
      const { data, issues } = parseFrontmatter(raw);
      expect(data).toMatchObject({ visibility: "public", requires: [] });
      expect(issues).toEqual([]);
    }
  });

  it("uses a requirement no viewer can hold, even where internal docs are shown", () => {
    // Permission keys are validated against PERMISSION_KEY_RE on creation, so
    // no role can ever grant this one.
    expect(PERMISSION_KEY_RE.test(UNSATISFIABLE_REQUIREMENT)).toBe(false);
    const { visibility, requires } = parseFrontmatter(doc("visibility: nope")).data;
    const hiddenEntry: DocCatalogEntry = {
      slug: "x",
      title: "X",
      group: "General",
      order: 0,
      tags: [],
      visibility,
      requires,
    };
    expect(filterCatalogForViewer([hiddenEntry], ["shell.view", "admin.users.read"], true)).toEqual(
      [],
    );
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
