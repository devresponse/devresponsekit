import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The root governance docs against the tree they describe (F-134, A-02).
 *
 * The 2026-09-22 review found them stale in ways no check could see: the
 * CHANGELOG stopped at 1.0.0 while three months of wire changes, migrations
 * and security fixes shipped (A-02), the README linked three documents twice
 * each and its project layout had lost half the API tree, and two docs sent
 * the reader to the maintainers' "project memory", which nobody else can
 * open (F-134). The Node prerequisite is pinned beside the other runtime
 * pins, in dependency-governance.test.ts.
 */
const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Slice from `from` to the next `to` after it; a missing marker throws. */
function sliceAt(haystack: string, from: string, to: string): string {
  const start = haystack.indexOf(from);
  if (start === -1) throw new Error(`marker not found: ${JSON.stringify(from)}`);
  const end = haystack.indexOf(to, start + from.length);
  return haystack.slice(start, end === -1 ? undefined : end);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function subdirectories(rel: string): string[] {
  return readdirSync(path.join(root, rel)).filter((name) =>
    statSync(path.join(root, rel, name)).isDirectory(),
  );
}

function markdownUnder(rel: string): string[] {
  return readdirSync(path.join(root, rel)).flatMap((name) => {
    const child = path.posix.join(rel, name);
    if (statSync(path.join(root, child)).isDirectory()) return markdownUnder(child);
    return name.endsWith(".md") ? [child] : [];
  });
}

describe("governance docs: CHANGELOG.md (A-02)", () => {
  const changelog = read("CHANGELOG.md");
  const sections = [...changelog.matchAll(/^## \[([^\]]+)\](.*)$/gm)].map((m) => ({
    name: m[1]!,
    rest: m[2]!,
  }));

  // Keep a Changelog's own rule: changes land under [Unreleased] as they
  // merge, and a release renames that section and opens a new empty one. With
  // no such section, nothing merged after 1.0.0 was ever written down.
  it("keeps one [Unreleased] section, above every release", () => {
    expect(sections[0]?.name).toBe("Unreleased");
    expect(sections.filter((s) => s.name === "Unreleased")).toHaveLength(1);
  });

  it("dates every release, newest first, and has one for package.json's version", () => {
    const releases = sections.filter((s) => s.name !== "Unreleased");
    for (const release of releases)
      expect(release.rest, release.name).toMatch(/^ - \d{4}-\d{2}-\d{2}$/);
    const dates = releases.map((release) => release.rest);
    expect([...dates].sort().reverse()).toEqual(dates);
    const { version } = JSON.parse(read("package.json")) as { version: string };
    expect(releases.map((release) => release.name)).toContain(version);
  });
});

describe("governance docs: README.md (F-134)", () => {
  const readme = read("README.md");

  it("links each document of its Documentation list once", () => {
    const list = sliceAt(readme, "\n## Documentation", "\n## ");
    const targets = [...list.matchAll(/^- \[[^\]]*\]\(([^)#]+)/gm)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target, i) => targets.indexOf(target) !== i)).toEqual([]);
  });

  it("names every API route directory and secure workspace in its project layout", () => {
    const layout = sliceAt(readme, "\n## Project layout", "\n## ");
    const expected = [
      ...subdirectories("src/app/api").map((dir) => `app/api/${dir}`),
      ...subdirectories("src/app/[locale]/(secure)/app").map(
        (dir) => `app/[locale]/(secure)/app/${dir}`,
      ),
    ];
    const missing = expected.filter(
      (entry) => !new RegExp(`^\\s+${escapeRegExp(entry)}\\s`, "m").test(layout),
    );
    expect(missing).toEqual([]);
  });
});

describe("governance docs: citations a reader can follow (F-134)", () => {
  it("never sends the reader to the maintainers' project memory", () => {
    const files = [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CHANGELOG.md",
      ...markdownUnder("docs"),
    ];
    expect(files.filter((file) => /project memory/i.test(read(file)))).toEqual([]);
  });
});
