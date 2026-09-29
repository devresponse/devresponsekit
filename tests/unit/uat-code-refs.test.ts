import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * I-16: every `file:N` citation in the UAT story set (docs/uat/*.md) names a
 * file that exists and a line that file has.
 *
 * The stories cite the code they were validated against by line number
 * (docs/uat/GENERATION-PROMPT.md), and nothing checked those numbers. By the
 * 2026-09 review they had drifted three months behind the code: a tester
 * following `reset-password/page.tsx:48` found a 35-line file, and hundreds
 * of other citations landed on unrelated lines. They were refreshed against
 * the tree; this keeps the grossest kind of drift from coming back unseen.
 *
 * What it can check is deliberately modest. A number past the end of its file
 * is certainly stale, and so is a file that is gone. A number that still falls
 * inside the file may be stale too, which only reading it can tell, so when
 * code moves, refresh the citations that point into it.
 *
 * A path is written from the repo root (`src/lib/…`, `vercel-cli/src/…`) or
 * abbreviated to a suffix of a file under the source roots
 * (`_new-user-form.tsx`, `lib/admin/orgs.server.ts`). Either way it must name a
 * file that exists, so renaming or deleting a cited file fails here however
 * the story spelled it. Only a path elided with `...` (`api/.../route.ts`) is
 * exempt: it names no one file. The line numbers are checked when the path
 * resolves to exactly one source file; a suffix several files share
 * (`route.ts`, `page.tsx`) and a bare `:N` continuation depend on the
 * surrounding prose, so their numbers are not.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const UAT_DIR = path.join(REPO_ROOT, "docs/uat");

/** `<path>.<ext>:<N>[-<M>][,<N>…]`, the citation form the stories use. */
const CITATION =
  /((?:[\w.()[\]@-]+\/)*[\w.()[\]@-]+\.(?:tsx|ts|mjs|cjs|js|sql|json|css)):(\d+(?:[-–]\d+)?(?:,\s?\d+(?:[-–]\d+)?)*)/g;

interface Citation {
  doc: string;
  docLine: number;
  path: string;
  numbers: number[];
}

function extractCitations(doc: string, text: string): Citation[] {
  const out: Citation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [, cited = "", numbers = ""] of line.matchAll(CITATION)) {
      out.push({
        doc,
        docLine: i + 1,
        path: cited,
        numbers: numbers.split(/[-–,]\s?/).map(Number),
      });
    }
  });
  return out;
}

type Resolution =
  { kind: "one"; file: string } | { kind: "several" } | { kind: "none" } | { kind: "elided" };

/** A path with a `...` segment stands for a directory the prose leaves out. */
const ELIDED = /(^|\/)\.\.\.(\/|$)/;

/** Which of `files` the cited path names: one, several, none, or it is elided. */
function resolveCitedFile(cited: string, files: readonly string[]): Resolution {
  if (ELIDED.test(cited)) return { kind: "elided" };
  if (files.includes(cited)) return { kind: "one", file: cited };
  const matches = files.filter((f) => f.endsWith(`/${cited}`));
  const [first] = matches;
  if (first === undefined) return { kind: "none" };
  return matches.length === 1 ? { kind: "one", file: first } : { kind: "several" };
}

/** The roots the stories cite into. */
const SOURCE_ROOTS = ["src", "scripts", "tests"];

function walk(rel: string): string[] {
  return readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(child);
    return [child];
  });
}

const sourceFiles = SOURCE_ROOTS.flatMap(walk);

const citations = readdirSync(UAT_DIR)
  .filter((f) => f.endsWith(".md"))
  .flatMap((f) => extractCitations(`docs/uat/${f}`, readFileSync(path.join(UAT_DIR, f), "utf8")));

const lineCounts = new Map<string, number>();
function lineCount(file: string): number {
  let n = lineCounts.get(file);
  if (n === undefined) {
    // A final newline ends the last line; it does not start another.
    n = readFileSync(path.join(REPO_ROOT, file), "utf8")
      .replace(/\r?\n$/, "")
      .split(/\r?\n/).length;
    lineCounts.set(file, n);
  }
  return n;
}

describe("UAT code citations (I-16)", () => {
  it("finds the story set's citations and resolves most of them", () => {
    // A sanity floor: a broken regex or an empty directory would pass the
    // checks below vacuously.
    expect(citations.length).toBeGreaterThan(400);
    const resolved = citations.filter((c) => resolveCitedFile(c.path, sourceFiles).kind === "one");
    expect(resolved.length).toBeGreaterThan(citations.length / 2);
  });

  it("every citation names a file that exists", () => {
    // Written from the repo root, it is looked up on disk (that also covers a
    // root outside the walked ones, such as vercel-cli/); abbreviated, it must
    // be the suffix of at least one source file. Elided paths are exempt.
    const missing = citations
      .filter((c) => resolveCitedFile(c.path, sourceFiles).kind === "none")
      .filter((c) => !existsSync(path.join(REPO_ROOT, c.path)))
      .map((c) => `${c.doc}:${c.docLine} ${c.path}`);
    expect(missing).toEqual([]);
  });

  it("every resolvable citation points inside its file", () => {
    const pastTheEnd: string[] = [];
    for (const c of citations) {
      const resolution = resolveCitedFile(c.path, sourceFiles);
      if (resolution.kind !== "one") continue;
      const { file } = resolution;
      const length = lineCount(file);
      const bad = c.numbers.filter((n) => n < 1 || n > length);
      if (bad.length > 0) {
        pastTheEnd.push(
          `${c.doc}:${c.docLine} ${c.path}:${bad.join(",")} (${file} has ${length} lines)`,
        );
      }
    }
    expect(pastTheEnd).toEqual([]);
  });

  it("parses the citation forms the stories use", () => {
    const text = [
      "guard (`src/lib/auth-guard.ts:181-205`) and `route.ts:189`,`:194`",
      "(`api/administrator/organizations/[id]/route.ts:326,374`) and `access-scope.server.ts:94-96,257-262`",
    ].join("\n");
    expect(
      extractCitations("x.md", text).map((c) => `${c.docLine} ${c.path} ${c.numbers.join("/")}`),
    ).toEqual([
      "1 src/lib/auth-guard.ts 181/205",
      "1 route.ts 189",
      "2 api/administrator/organizations/[id]/route.ts 326/374",
      "2 access-scope.server.ts 94/96/257/262",
    ]);
  });

  it("resolves a path to one file, several, none, or leaves an elided one alone", () => {
    const files = ["src/a/route.ts", "src/b/route.ts", "src/b/_form.tsx"];
    expect(resolveCitedFile("src/a/route.ts", files)).toEqual({
      kind: "one",
      file: "src/a/route.ts",
    });
    expect(resolveCitedFile("_form.tsx", files)).toEqual({ kind: "one", file: "src/b/_form.tsx" });
    expect(resolveCitedFile("b/route.ts", files)).toEqual({ kind: "one", file: "src/b/route.ts" });
    expect(resolveCitedFile("route.ts", files)).toEqual({ kind: "several" });
    // A renamed or deleted file, full or abbreviated: the existence test fails it.
    expect(resolveCitedFile("gone.ts", files)).toEqual({ kind: "none" });
    expect(resolveCitedFile("src/b/_gone.tsx", files)).toEqual({ kind: "none" });
    expect(resolveCitedFile("src/.../route.ts", files)).toEqual({ kind: "elided" });
    expect(resolveCitedFile("...route.ts", files)).toEqual({ kind: "none" });
  });
});
