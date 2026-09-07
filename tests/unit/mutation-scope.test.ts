import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The mutation-testing scope is declared in FOUR places that must agree, and
 * until now nothing checked them against each other (must-fix review of the
 * #229 work): `docs/testing.md` was rewritten to claim the SSO handoff codec
 * was mutation-tested while `stryker.config.mjs` explicitly excludes it, so
 * the reference doc operators read for "what has a proven mutation score"
 * asserted assertion-strength coverage that does not exist.
 *
 * The four:
 *  1. `stryker.config.mjs`'s `mutate` — the source of truth for what runs.
 *  2. `scripts/check-mutation-floors.mjs`'s `FLOORS` — the per-file ratchet;
 *     a mutated file with no floor joins the ratchet unmeasured.
 *  3. `.github/workflows/mutation.yml`'s `paths:` filter — a mutated file
 *     missing here does not even trigger the advisory job when it changes.
 *  4. `docs/testing.md`'s scope list — what a human is told is covered.
 *
 * These are parsed as TEXT rather than imported: `tsconfig.json` sets
 * `allowJs: false`, so a `.ts` test cannot import the `.mjs` config without
 * pulling it into the root `tsc` program.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/**
 * The string literals inside `mutate: [ … ]`, one per line. Comment lines are
 * skipped rather than regex-matched away: the `//` notes inside the array
 * contain apostrophes ("a route's requirement"), which a naive quote match
 * would read as literals.
 */
function strykerMutateTargets(): string[] {
  const source = read("stryker.config.mjs");
  const start = source.indexOf("mutate: [");
  expect(start, "stryker.config.mjs declares a `mutate: [` array").toBeGreaterThan(-1);
  const end = source.indexOf("\n  ],", start);
  expect(end, "the `mutate` array is closed").toBeGreaterThan(start);
  const out: string[] = [];
  for (const line of source.slice(start, end).split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    const m = trimmed.match(/^["']([^"']+)["'],?$/);
    expect(m, `unexpected line in stryker.config.mjs's mutate array: ${line}`).not.toBeNull();
    out.push(m![1]!);
  }
  return out;
}

/** The keys of `FLOORS` in the per-file floor script. */
function mutationFloorFiles(): string[] {
  const source = read("scripts/check-mutation-floors.mjs");
  const start = source.indexOf("const FLOORS = {");
  expect(start, "check-mutation-floors.mjs declares `const FLOORS = {`").toBeGreaterThan(-1);
  const end = source.indexOf("\n};", start);
  expect(end, "the FLOORS object is closed").toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/^\s*["']([^"']+)["']\s*:/gm)].map((m) => m[1]!);
}

/** The `- "…"` entries under the `paths:` filter of the mutation workflow. */
function workflowPathFilters(): string[] {
  const source = read(".github/workflows/mutation.yml");
  const start = source.indexOf("    paths:");
  expect(start, "mutation.yml declares a `paths:` filter").toBeGreaterThan(-1);
  const rest = source.slice(start).split("\n").slice(1);
  const out: string[] = [];
  for (const line of rest) {
    const m = line.match(/^\s+-\s+["']([^"']+)["']\s*$/);
    if (!m) break; // first non-entry line ends the list
    out.push(m[1]!);
  }
  return out;
}

/**
 * The `docs/testing.md` scope bullets: the indented `` - `src/…` `` list
 * items that follow the Stryker paragraph, up to the blank line that ends it.
 */
function documentedScope(): string[] {
  const source = read("docs/testing.md");
  const start = source.indexOf("- **Stryker**");
  expect(start, "docs/testing.md documents Stryker").toBeGreaterThan(-1);
  const lines = source.slice(start).split("\n").slice(1);
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") break;
    const m = line.match(/^\s+-\s+`([^`]+)`/);
    expect(m, `unexpected line in the documented Stryker scope list: ${line}`).not.toBeNull();
    out.push(m![1]!);
  }
  return out;
}

/**
 * The one module #229 proposed and the config deliberately rejected. It must
 * stay out of every in-scope list — and stay NAMED as an exclusion, so the
 * omission reads as a decision rather than an oversight.
 */
const EXCLUDED = "src/lib/jwt-handoff.server.ts";

describe("mutation-testing scope stays consistent across config, script, workflow and docs", () => {
  const mutate = strykerMutateTargets();

  it("stryker.config.mjs mutates a non-empty set of source files", () => {
    expect(mutate.length).toBeGreaterThan(0);
    for (const target of mutate) expect(target).toMatch(/^src\/.+\.ts$/);
  });

  it("docs/testing.md lists exactly the mutated files", () => {
    expect(new Set(documentedScope())).toEqual(new Set(mutate));
  });

  it("every mutated file has a per-file floor", () => {
    expect(new Set(mutationFloorFiles())).toEqual(new Set(mutate));
  });

  it("every mutated file triggers the advisory workflow", () => {
    const paths = workflowPathFilters();
    for (const target of mutate) expect(paths, target).toContain(target);
  });

  it("the SSO handoff codec is out of scope everywhere, and documented as such", () => {
    expect(mutate).not.toContain(EXCLUDED);
    expect(mutationFloorFiles()).not.toContain(EXCLUDED);
    expect(documentedScope()).not.toContain(EXCLUDED);
    // Named as a deliberate exclusion in both the config and the doc, so a
    // reader cannot mistake the gap for coverage (or for an accident).
    expect(read("stryker.config.mjs")).toContain(`\`${EXCLUDED}\``);
    const docs = read("docs/testing.md");
    expect(docs).toContain(
      `\`${EXCLUDED}\` (the SSO handoff codec) is **deliberately OUT of scope**`,
    );
  });
});
