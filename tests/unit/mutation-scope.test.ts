import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
 * The other three are parsed as TEXT. The config is IMPORTED, because since
 * I-11 part of its `mutate` list is computed (`functionRanges` turns function
 * names into `file:start-end` targets). The specifier is built at run time, so
 * the `.mjs` never enters the root `tsc` program (`tsconfig.json` sets
 * `allowJs: false`).
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** `stryker.config.mjs`'s `mutate`, exactly as Stryker receives it. */
const strykerConfig = (await import(
  pathToFileURL(path.join(REPO_ROOT, "stryker.config.mjs")).href
)) as { default: { mutate: string[] } };

/** A mutate target: a whole file, or `file:start-end` for a line range. */
const TARGET_RE = /^(src\/[^:]+\.ts)(?::(\d+)-(\d+))?$/;

function parseTarget(target: string): { file: string; range?: [number, number] } {
  const m = TARGET_RE.exec(target);
  expect(m, `unexpected mutate target in stryker.config.mjs: ${target}`).not.toBeNull();
  return m![2] === undefined
    ? { file: m![1]! }
    : { file: m![1]!, range: [Number(m![2]), Number(m![3])] };
}

/** The FILES Stryker mutates, whether whole or by line range. */
function strykerMutatedFiles(): string[] {
  return [...new Set(strykerConfig.default.mutate.map((target) => parseTarget(target).file))];
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

/**
 * The tenant-boundary predicates the 2026-09-22 review found unmeasured (I-11):
 * the ones every org-scoping decision goes through, and the pure REVOKE-2 rule.
 * Named here so dropping one from the config fails a required check, not just
 * the advisory mutation job.
 */
const ACCESS_SCOPE = "src/lib/admin/access-scope.server.ts";
const REQUIRED_ACCESS_SCOPE_FUNCTIONS = [
  "isSuperadmin",
  "isOrgBound",
  "hasCrossOrgReach",
  "ownerOutranksActor",
  "resolveOrgScope",
  "canAccessOrg",
  "canAccessUser",
  "stripsLastGlobalSuperuser",
];

/** The name a line-range target's first line declares, or null. */
function declaredFunction(line: string | undefined): string | null {
  return /^(?:export )?(?:async )?function (\w+)/.exec(line ?? "")?.[1] ?? null;
}

describe("mutation-testing scope stays consistent across config, script, workflow and docs", () => {
  const mutate = strykerConfig.default.mutate;
  const files = strykerMutatedFiles();

  it("stryker.config.mjs mutates a non-empty set of source files", () => {
    expect(mutate.length).toBeGreaterThan(0);
    for (const target of mutate) parseTarget(target);
  });

  it("docs/testing.md lists exactly the mutated files", () => {
    expect(new Set(documentedScope())).toEqual(new Set(files));
  });

  it("every mutated file has a per-file floor", () => {
    expect(new Set(mutationFloorFiles())).toEqual(new Set(files));
  });

  it("every mutated file triggers the advisory workflow", () => {
    const paths = workflowPathFilters();
    for (const file of files) expect(paths, file).toContain(file);
  });

  /**
   * I-11: a module that also holds SQL builders joins by FUNCTION. Each ranged
   * target must be one whole top-level function, from its declaration to the
   * `}` that closes it, so a range can never start or stop mid-function; and
   * the function must build no SQL, the scope rule in stryker.config.mjs (a SQL
   * builder's mutants run against a mocked DB and cannot be killed there).
   */
  it("a line-range target is one whole top-level function that builds no SQL", () => {
    const ranged = mutate.map(parseTarget).filter((target) => target.range !== undefined);
    expect(ranged.length).toBeGreaterThan(0);
    for (const { file, range } of ranged) {
      const [start, end] = range!;
      const lines = read(file)
        .split(/\r?\n/)
        .slice(start - 1, end);
      const where = `${file}:${start}-${end}`;
      expect(declaredFunction(lines[0]), where).not.toBeNull();
      expect(lines.at(-1), where).toBe("}");
      expect(lines.slice(0, -1), `${where} spans more than one function`).not.toContain("}");
      expect(lines.join("\n"), `${where} builds SQL`).not.toMatch(
        /\b(?:db|executor|selectFrom|sql)\b/,
      );
    }
  });

  it("the tenant-boundary predicates and the SSO launch return builder stay in scope (I-11)", () => {
    const names = mutate
      .map(parseTarget)
      .filter((target) => target.file === ACCESS_SCOPE && target.range !== undefined)
      .map(({ range }) => declaredFunction(read(ACCESS_SCOPE).split(/\r?\n/)[range![0] - 1]));
    expect(names).toEqual(expect.arrayContaining(REQUIRED_ACCESS_SCOPE_FUNCTIONS));
    // The file itself is never mutated whole: its membership and grant queries
    // are SQL builders.
    expect(mutate).not.toContain(ACCESS_SCOPE);
    expect(mutate).toContain("src/lib/sso-launch-return.ts");
  });

  it("the SSO handoff codec is out of scope everywhere, and documented as such", () => {
    expect(files).not.toContain(EXCLUDED);
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
