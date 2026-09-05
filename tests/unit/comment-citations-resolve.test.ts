import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Comment-citation resolver (review #130, #131, #147, #165, #172, #174–#177).
 *
 * The 2026-09 source review found that comments cite plan / design / spec
 * sections that no longer exist: `plan §4.1` pointed at a deleted
 * `docs-backup/admin-manager.md`, `design §9.1` at a section that was
 * renumbered, `setup-better-auth.md §7` at a deleted document. A stale
 * citation is worse than none — it sends the reader to an unrelated section
 * with full confidence. This scan makes every citation in `src/**` and
 * `scripts/**` resolve to a real heading, so a doc reorganisation fails CI
 * here instead of silently orphaning the comments that depend on it.
 *
 * Citation forms covered (over the whole file text — comments are where
 * they live, but a user-facing string that points at a doc must resolve
 * too):
 *
 *   1. `docs/<file>.md §N[.M]`, `<file>.md §N`, `<File> §N` (bare doc-name
 *      form, e.g. `Deployment §8`, `admin-manager §12.1`) — the section
 *      number must match a numbered heading in that document. Trailing
 *      continuations (`§5.2, §19 + §20.1 and §6.1`) are checked against the
 *      same document.
 *   2. `spec §N` / `specs.md §N` — resolves against the root `specs.md`.
 *   3. `design §N` — resolves against the design document that owns the
 *      file (`docs/design-mcp-agent-gateway.md` under the MCP surfaces,
 *      `docs/design-api-keys-and-tokens.md` everywhere else).
 *   4. `plan §N` / `decision §N` — always fail: no document is called
 *      "plan" any more; cite `docs/admin-manager.md §N` instead.
 *   5. A bare `§N` — resolves against the most recent qualified citation in
 *      the same file (sticky context), else the directory's default
 *      document (see {@link defaultDocFor}).
 *   6. `<file>.md#<anchor>` — the anchor must equal the GitHub heading slug
 *      of a heading in that file, using the same slug rules the docs viewer
 *      (`rehype-slug` → github-slugger) and the CI link checker (lychee
 *      `--include-fragments`) apply.
 *   7. `ADR-NNNN` — must be a heading somewhere under `docs/**` (today the
 *      ADRs are `####` headings in `docs/architecture.md`).
 *
 * Citations to documents outside this repository (IETF RFCs, protocol
 * revisions) are allow-listed below with a reason; the allowlist is itself
 * asserted non-stale so a dead entry cannot linger.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIRS = ["src", "scripts"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".sql"]);
const SKIP_FILES = new Set([
  // Generated Kysely types — no hand-written prose.
  "src/db/schema/generated.ts",
]);

/**
 * Citations to documents that do not live in this repository. Each entry is
 * blanked out of the scanned text BEFORE the resolver runs, so its section
 * numbers are never mistaken for a bare `§` in the surrounding document
 * context. Every entry must still match somewhere (asserted below) so the
 * list cannot rot.
 */
const EXTERNAL_CITATIONS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    // e.g. "RFC 6750 §3.1", "RFC 7591 §3.2.2" — IETF standards; the section
    // numbers are the RFC's own and are not checkable against our docs.
    pattern: /\bRFC\s?\d{3,5}\s?(?:§\s?\d+(?:\.\d+)*)(?:\s*(?:,|and|\+|\/)\s*§\s?\d+(?:\.\d+)*)*/g,
    reason: "IETF RFC section numbers refer to the published standard, not a repo document",
  },
];

/** Documents a `design §N` citation resolves against, by path prefix. */
const DESIGN_DOC_BY_PREFIX: ReadonlyArray<[prefix: string, doc: string]> = [
  ["src/lib/mcp/", "docs/design-mcp-agent-gateway.md"],
  ["src/app/api/mcp/", "docs/design-mcp-agent-gateway.md"],
  ["src/app/.well-known/", "docs/design-mcp-agent-gateway.md"],
];
const DEFAULT_DESIGN_DOC = "docs/design-api-keys-and-tokens.md";

/**
 * Document a bare `§N` (no qualifier anywhere earlier in the file) is read
 * against. Administrator surfaces cite the console specification; the
 * machine-API surfaces cite the API-keys design; everything else cites the
 * product spec. A bare `§` that does not resolve here needs a qualifier.
 */
function defaultDocFor(relPath: string): string {
  if (
    relPath.startsWith("src/app/api/administrator/") ||
    relPath.startsWith("src/lib/admin/") ||
    relPath.startsWith("src/components/admin/") ||
    relPath.startsWith("src/app/[locale]/(secure)/app/administrator/")
  ) {
    return "docs/admin-manager.md";
  }
  if (
    relPath.startsWith("src/lib/api-auth/") ||
    relPath.startsWith("src/lib/account/") ||
    relPath.startsWith("src/app/api/v1/") ||
    relPath.startsWith("src/app/api/account/")
  ) {
    return DEFAULT_DESIGN_DOC;
  }
  for (const [prefix, doc] of DESIGN_DOC_BY_PREFIX) {
    if (relPath.startsWith(prefix)) return doc;
  }
  return "specs.md";
}

// ---------------------------------------------------------------------------
// Markdown side: headings, section numbers, GitHub slugs
// ---------------------------------------------------------------------------

/**
 * GitHub heading-slug rules, as implemented by `github-slugger` (which
 * `rehype-slug` in the docs viewer uses, and which lychee's fragment check
 * assumes): lowercase, drop everything that is not a letter / number / mark /
 * space / hyphen / underscore, spaces → hyphens, and suffix `-1`, `-2`, … on
 * repeats within one document.
 */
export function githubSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/ /g, "-");
}

interface DocHeadings {
  /** Section numbers (`"8"`, `"8.1"`) of numbered headings. */
  sections: Set<string>;
  /** GitHub slugs of every heading (duplicates suffixed). */
  slugs: Set<string>;
  /** Raw heading texts, for ADR lookups. */
  texts: string[];
}

export function parseHeadings(markdown: string): DocHeadings {
  const sections = new Set<string>();
  const slugs = new Set<string>();
  const texts: string[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // A `#` inside a fenced block is a shell comment, not a heading.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const text = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (text === undefined) continue;
    texts.push(text);
    const num = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/.exec(text)?.[1];
    if (num !== undefined) sections.add(num);
    const base = githubSlug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return { sections, slugs, texts };
}

const headingCache = new Map<string, DocHeadings | null>();

/** Reads + parses a markdown document (repo-relative path); null if absent. */
function headingsOf(docRel: string): DocHeadings | null {
  if (headingCache.has(docRel)) return headingCache.get(docRel)!;
  const abs = join(REPO_ROOT, docRel);
  const parsed = existsSync(abs) ? parseHeadings(readFileSync(abs, "utf8")) : null;
  headingCache.set(docRel, parsed);
  return parsed;
}

let markdownDocs: string[] | null = null;

/** Every markdown file under docs/ (recursive) plus the root-level ones. */
function listMarkdownDocs(): string[] {
  if (markdownDocs) return markdownDocs;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else if (entry.endsWith(".md")) out.push(relative(REPO_ROOT, abs).replace(/\\/g, "/"));
    }
  };
  walk(join(REPO_ROOT, "docs"));
  for (const entry of readdirSync(REPO_ROOT)) {
    if (entry.endsWith(".md") && statSync(join(REPO_ROOT, entry)).isFile()) out.push(entry);
  }
  markdownDocs = out;
  return out;
}

/**
 * Resolves the document a citation names. `docs/x.md` and `x.md` are looked
 * up under `docs/` then the repo root; a bare word (`Deployment`,
 * `admin-manager`) is matched case-insensitively against `docs/*.md`.
 * Returns the repo-relative path, or null when nothing matches.
 */
function resolveDocName(name: string): string | null {
  const docs = listMarkdownDocs();
  const withExt = name.endsWith(".md") ? name : `${name}.md`;
  if (withExt.includes("/")) {
    const clean = withExt.replace(/^(\.\.\/|\.\/)+/, "");
    return docs.includes(clean) ? clean : null;
  }
  const lower = withExt.toLowerCase();
  const underDocs = docs.find((d) => d.toLowerCase() === `docs/${lower}`);
  if (underDocs) return underDocs;
  const atRoot = docs.find((d) => d.toLowerCase() === lower);
  return atRoot ?? null;
}

// ---------------------------------------------------------------------------
// Source side: scanning
// ---------------------------------------------------------------------------

function listSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(abs);
        continue;
      }
      const dot = entry.lastIndexOf(".");
      if (dot < 0 || !SCAN_EXTENSIONS.has(entry.slice(dot))) continue;
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      if (!SKIP_FILES.has(rel)) out.push(rel);
    }
  };
  for (const dir of SCAN_DIRS) walk(join(REPO_ROOT, dir));
  return out.sort();
}

/**
 * Joins comment continuation lines (` * `, `// `, `-- `) so a citation split
 * across lines (`docs/admin-manager.md` / `§8.1`) is seen whole, and blanks
 * out allow-listed external citations.
 */
function normalise(text: string): string {
  let out = text.replace(/\r\n/g, "\n").replace(/\n[ \t]*(?:\*\/?|\/\/|--)?[ \t]?/g, " ");
  for (const { pattern } of EXTERNAL_CITATIONS) {
    out = out.replace(pattern, (m) => " ".repeat(m.length));
  }
  return out;
}

export interface CitationFailure {
  file: string;
  citation: string;
  reason: string;
}

const SECTION = String.raw`§\s?(\d+(?:\.\d+)*)`;
// `<word>[.md] §N` — the qualifier is a path, a file name, or a keyword.
const QUALIFIED_RE = new RegExp(
  String.raw`(?<![\w./-])((?:[\w.-]+\/)*[A-Za-z][\w-]*(?:\.md)?)\s${SECTION}`,
  "g",
);
// Continuations directly after a citation: `, §19`, ` + §20.1`, ` and §6.1`, `; §21`.
const CONTINUATION_RE = new RegExp(String.raw`^\s*(?:,|\+|\/|;|and|&)?\s*${SECTION}`);
const ANCHOR_RE = /(?<![\w./-])((?:\.\.\/|\.\/)*(?:[\w.-]+\/)*[\w.-]+\.md)#([\w-]+)/g;
const ADR_RE = /\bADR-(\d{4})((?:\/\d{4})*)\b/g;
const BARE_SECTION_RE = new RegExp(SECTION, "g");

const KEYWORD_DOCS: Record<string, "spec" | "design" | "plan"> = {
  spec: "spec",
  specs: "spec",
  design: "design",
  plan: "plan",
  decision: "plan",
};

function designDocFor(relPath: string): string {
  for (const [prefix, doc] of DESIGN_DOC_BY_PREFIX) {
    if (relPath.startsWith(prefix)) return doc;
  }
  return DEFAULT_DESIGN_DOC;
}

/** Capture group `i` of a match; every group the resolver reads is non-optional. */
function g(m: RegExpMatchArray | RegExpExecArray, i: number): string {
  return m[i] ?? "";
}

function snippet(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 20), index + length + 20).trim();
}

/**
 * Scans one file's text. Returns every citation failure; `checked` counts
 * the citations that were examined so a regression that stops matching
 * anything is visible.
 */
export function scanText(
  relPath: string,
  rawText: string,
): { failures: CitationFailure[]; checked: number } {
  const text = normalise(rawText);
  const failures: CitationFailure[] = [];
  let checked = 0;
  const fail = (citation: string, reason: string) =>
    failures.push({ file: relPath, citation, reason });

  // Ranges already consumed by a qualified citation (so the bare-§ pass
  // does not re-check them) and the sticky document context.
  const consumed: Array<[number, number]> = [];
  const contextAt: Array<[index: number, doc: string]> = [];

  const checkSection = (doc: string, section: string, citation: string) => {
    checked++;
    const headings = headingsOf(doc);
    if (!headings) {
      fail(citation, `document ${doc} does not exist`);
      return;
    }
    if (!headings.sections.has(section)) {
      fail(citation, `${doc} has no heading numbered ${section}`);
    }
  };

  for (const m of text.matchAll(QUALIFIED_RE)) {
    const whole = m[0];
    const qualifier = g(m, 1);
    const section = g(m, 2);
    const start = m.index!;
    let doc: string | null = null;
    const keyword = KEYWORD_DOCS[qualifier.toLowerCase()];
    if (keyword === "spec") doc = "specs.md";
    else if (keyword === "design") doc = designDocFor(relPath);
    else if (keyword === "plan") {
      checked++;
      fail(
        snippet(text, start, whole.length),
        `"${qualifier} §" names no document — the old plan was folded into docs/admin-manager.md; cite it explicitly`,
      );
    } else if (qualifier.endsWith(".md") || qualifier.includes("/")) {
      doc = resolveDocName(qualifier);
      if (!doc) {
        checked++;
        fail(snippet(text, start, whole.length), `document ${qualifier} does not exist`);
      }
    } else {
      doc = resolveDocName(qualifier);
      // A plain word that is not a doc name (`per §23`) is not a qualifier;
      // the bare-§ pass handles its section number.
      if (!doc) continue;
    }

    // Consume the continuation run (`, §19 + §20.1 and §6.1`).
    let end = start + whole.length;
    const sections = [section];
    for (;;) {
      const cont = CONTINUATION_RE.exec(text.slice(end));
      if (!cont) break;
      sections.push(g(cont, 1));
      end += cont[0].length;
    }
    consumed.push([start, end]);
    if (!doc) continue;
    contextAt.push([start, doc]);
    for (const s of sections) checkSection(doc, s, snippet(text, start, end - start));
  }

  // Bare `§N` — sticky context, else the directory default.
  for (const m of text.matchAll(BARE_SECTION_RE)) {
    const start = m.index!;
    if (consumed.some(([a, b]) => start >= a && start < b)) continue;
    let doc = defaultDocFor(relPath);
    for (const [index, ctxDoc] of contextAt) {
      if (index < start) doc = ctxDoc;
      else break;
    }
    checkSection(doc, g(m, 1), snippet(text, start, m[0].length));
  }

  for (const m of text.matchAll(ANCHOR_RE)) {
    checked++;
    const whole = m[0];
    const file = g(m, 1);
    const anchor = g(m, 2);
    const doc = resolveDocName(file);
    const citation = snippet(text, m.index!, whole.length);
    if (!doc) {
      fail(citation, `document ${file} does not exist`);
      continue;
    }
    if (!headingsOf(doc)!.slugs.has(anchor)) {
      fail(citation, `${doc} has no heading with slug #${anchor}`);
    }
  }

  for (const m of text.matchAll(ADR_RE)) {
    const ids = [g(m, 1), ...g(m, 2).split("/").filter(Boolean)];
    for (const id of ids) {
      checked++;
      const found = listMarkdownDocs().some((doc) =>
        headingsOf(doc)!.texts.some((t) => t.includes(`ADR-${id}`)),
      );
      if (!found)
        fail(snippet(text, m.index!, m[0].length), `no heading for ADR-${id} under docs/**`);
    }
  }

  return { failures, checked };
}

function formatFailures(failures: CitationFailure[]): string {
  return failures.map((f) => `${f.file}: "${f.citation}" → ${f.reason}`).join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("comment citations resolve (review #130/#131/#147/#165/#172/#174–#177)", () => {
  const files = listSourceFiles();

  it("scans a meaningful corpus", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/lib/api-auth/v1-guard.server.ts");
    expect(files).toContain("src/db/migrations/0001-initial-schema.sql");
  });

  it("every citation in src/** and scripts/** resolves to a real heading", () => {
    const failures: CitationFailure[] = [];
    let checked = 0;
    for (const rel of files) {
      const result = scanText(rel, readFileSync(join(REPO_ROOT, rel), "utf8"));
      failures.push(...result.failures);
      checked += result.checked;
    }
    // The tree carries hundreds of citations; a scanner regression that
    // matches nothing must not pass vacuously.
    expect(checked).toBeGreaterThan(200);
    expect(formatFailures(failures)).toBe("");
  });

  it("no `plan §` / `decision §` citation survives (review #147, #177)", () => {
    // Normalised so a line-split `plan\n * §5.2` (which the raw grep in the
    // sweep missed) is caught too.
    const offenders = files.filter((rel) =>
      /\b(plan|decision) §/.test(normalise(readFileSync(join(REPO_ROOT, rel), "utf8"))),
    );
    expect(offenders).toEqual([]);
  });

  it("each external-citation allowlist entry still matches something", () => {
    const corpus = files.map((rel) => readFileSync(join(REPO_ROOT, rel), "utf8")).join("\n");
    for (const { pattern, reason } of EXTERNAL_CITATIONS) {
      const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      expect(re.test(corpus), `stale allowlist entry: ${reason}`).toBe(true);
    }
  });
});

describe("citation resolver mechanics", () => {
  it("applies GitHub heading-slug rules (github-slugger parity)", () => {
    expect(githubSlug("6.1 Permission catalog")).toBe("61-permission-catalog");
    expect(githubSlug("ADR-0001 — three tiers, one boundary module")).toBe(
      "adr-0001--three-tiers-one-boundary-module",
    );
    expect(githubSlug("Single Sign-On handoff")).toBe("single-sign-on-handoff");
    expect(githubSlug("The `account.apikeys.manage` scope")).toBe("the-accountapikeysmanage-scope");
    expect(githubSlug("Redaction & scrubbing policy")).toBe("redaction--scrubbing-policy");
  });

  it("numbers headings, suffixes duplicate slugs, and ignores fenced `#` lines", () => {
    const parsed = parseHeadings(
      [
        "# Title",
        "## 5. Operations",
        "### 5.1 Error envelope",
        "```bash",
        "# not a heading",
        "```",
        "### Matching",
        "### Matching",
        "#### ADR-0001 — three tiers",
      ].join("\n"),
    );
    expect([...parsed.sections]).toEqual(["5", "5.1"]);
    expect(parsed.slugs.has("matching")).toBe(true);
    expect(parsed.slugs.has("matching-1")).toBe(true);
    expect(parsed.slugs.has("not-a-heading")).toBe(false);
    expect(parsed.texts).toContain("ADR-0001 — three tiers");
  });

  it("resolves the real documents the sweep retargeted to", () => {
    expect(headingsOf("docs/admin-manager.md")!.sections).toContain("8.1");
    expect(headingsOf("docs/design-api-keys-and-tokens.md")!.sections).toContain("5.4");
    expect(headingsOf("docs/observability.md")!.sections).toContain("6");
    expect(headingsOf("specs.md")!.sections).toContain("21");
    expect(headingsOf("docs/configuration.md")!.slugs).toContain("single-sign-on-handoff");
    expect(resolveDocName("Deployment")).toBe("docs/deployment.md");
    expect(resolveDocName("setup-better-auth.md")).toBeNull();
  });

  it("flags every stale form the review found (not a tautology)", () => {
    const sample = [
      "/**",
      " * Lists keys (design §9.1). Soft-delete only (plan §4.1).",
      " * Hard delete is not exposed (decision §20.1.11).",
      " * Mirrors the rule (setup-better-auth.md §7).",
      " * Roadmap in docs/observability.md §5, §99.",
      " * See docs/configuration.md#no-such-anchor and ADR-0099.",
      " * RFC 6750 §3.1 is external and must not be checked.",
      " */",
    ].join("\n");
    const { failures } = scanText("src/lib/api-auth/example.ts", sample);
    const reasons = failures.map((f) => f.reason);
    expect(reasons).toEqual([
      "docs/design-api-keys-and-tokens.md has no heading numbered 9.1",
      expect.stringContaining('"plan §" names no document'),
      expect.stringContaining('"decision §" names no document'),
      "document setup-better-auth.md does not exist",
      "docs/observability.md has no heading numbered 99",
      "docs/configuration.md has no heading with slug #no-such-anchor",
      "no heading for ADR-0099 under docs/**",
    ]);
  });

  it("accepts continuations, sticky context, keyword docs and multi-line citations", () => {
    const sample = [
      "/**",
      " * Per docs/admin-manager.md §5.2, §19 + §20.1 and §6.1. Bulk (§13) too.",
      " * Design docs/design-api-keys-and-tokens.md",
      " * §8.1 and design §10.2; spec §21 rule 5; Deployment §8's role.",
      " * ADR-0001/0002 org + group scoping; docs/configuration.md#single-sign-on-handoff.",
      " */",
    ].join("\n");
    const { failures, checked } = scanText("src/lib/admin/example.ts", sample);
    expect(formatFailures(failures)).toBe("");
    expect(checked).toBe(12);
  });
});
