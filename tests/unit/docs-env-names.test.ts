import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * I-20: every ALL_CAPS variable name that docs/ and specs.md mention is one
 * the code knows, or is named below with the reason it is not.
 *
 * Nothing compared the two, so a variable could leave `src/lib/env.ts` while
 * the docs went on telling operators to set it: specs.md listed the retired
 * `SSO_HANDOFF_JWT_SECRET` as REQUIRED, and signed with it, long after review
 * #5 replaced it with an Ed25519 key.
 *
 * The docs spell code constants the same way (`ADMIN_PERMISSION_CATALOG`,
 * `DEFAULT_ADMIN_BULK_LIMIT`), so the spelling cannot tell a variable from a
 * constant. Each name is resolved against the code instead: it passes when a
 * file under src/, scripts/ or vercel-cli/src/, or a root `*.config.*` file,
 * spells it OUTSIDE a comment. That covers env.ts's schema keys, the
 * `process.env.X` reads (OUTBOX_DRAIN_LIMIT is read only by
 * scripts/drain-outbox.ts), helper reads such as `timeoutFromEnv(env, "X")`,
 * and constants. Comments do not count, because a retired variable lives on in
 * exactly those ("SEED_DEFAULT_ORGANIZATION_SLUG is gone", F-40), and that is
 * how the docs outlived it. Every other name is listed in {@link EXTERNAL} or
 * {@link UNREAD}.
 *
 * A name needs an underscore to be seen: single words (`TZ`, `CI`) cannot be
 * told apart from `HTTP` or `JSON`. A wildcard family (`SENTRY_*`) is not a
 * name, and nor is a Mermaid node id.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");

/** An ALL_CAPS name with at least one underscore. */
const NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/**
 * Variables that something other than this app reads. The docs name them
 * because an operator sets them, but no code here does.
 */
const EXTERNAL: Readonly<Record<string, string>> = {
  POSTGRES_DB: "the postgres image's own setting (docker-compose.yml); the app reads DATABASE_URL",
  POSTGRES_USER: "the postgres image's own setting (docker-compose.yml)",
  POSTGRES_PASSWORD: "the postgres image's own setting (docker-compose.yml)",
  NEXT_MANUAL_SIG_HANDLE:
    "read by Next.js itself; docs/docker.md says not to set it (src/lib/shutdown.server.ts)",
  GIT_SHA: "the operator's shell variable in docs/docker.md's build commands",
  API_TOKEN: "the reader's own variable in docs/api.md's client example",
  INVALID_EMAIL_OR_PASSWORD:
    "Better Auth's own error code, logged as a failed sign-in's reason (docs/troubleshooting.md, F-55)",
  INVALID_EMAIL:
    "Better Auth's own error code, logged as a failed sign-in's reason (docs/troubleshooting.md, F-55)",
  VALIDATION_ERROR:
    "Better Auth's own error code, logged as a failed sign-in's reason (docs/troubleshooting.md, F-55)",
};

/**
 * Variables this app does not read at all. The docs may keep them as history,
 * but every paragraph that mentions one must say so ({@link MARKED}), so none
 * of them reads as a setting that still works.
 */
const UNREAD: Readonly<Record<string, string>> = {
  SSO_HANDOFF_JWT_SECRET:
    "retired by review #5: the issuer signs with SSO_HANDOFF_PRIVATE_KEY (Ed25519) and satellites verify its JWKS",
  SEED_DEFAULT_ORGANIZATION_SLUG:
    "removed by F-40: nothing read it; the default organization is the row marked is_default",
  DOCS_ALLOW_MDX_EXECUTION: "removed by I-06: parsed and read nowhere",
  NEXT_PUBLIC_PRIMARY_HOST: "specified by specs.md §8 and never read by the shipped app",
  NEXT_PUBLIC_DEFAULT_LOCALE:
    "kept in .env.example for reference; the default locale lives in src/config/i18n-config.ts",
  NEXT_PUBLIC_SUPPORTED_LOCALES:
    "kept in .env.example for reference; the locale list lives in src/config/i18n-config.ts",
};

/** The words that mark a paragraph's mention of an {@link UNREAD} variable as not current. */
const MARKED = /\b(?:historical|retired|removed|former|gone|replaced|not read)\b/i;

const CODE_ROOTS = ["src", "scripts", "vercel-cli/src"];
const isCode = (name: string) => /\.(?:[cm]?[jt]sx?)$/.test(name) && !name.endsWith(".d.ts");
const isMarkdown = (name: string) => /\.mdx?$/i.test(name);

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");

/**
 * The names one source file spells in code: identifiers, and the text of its
 * string and template literals. Walking the TypeScript AST leaves comments
 * out, JSDoc included.
 */
function codeNames(fileName: string, source: string): Set<string> {
  const kind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(fileName)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const match of node.text.matchAll(NAME)) names.add(match[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** A fenced Mermaid diagram: its node ids (`API_CLIENT[...]`) are not names. */
const MERMAID_BLOCK = /^```mermaid\n[\s\S]*?^```/gm;

/**
 * Each name a Markdown document mentions, with every paragraph (a run of
 * non-blank lines: a table, a list, a code-block group) it appears in.
 */
function docMentions(markdown: string): Map<string, string[]> {
  const mentions = new Map<string, string[]>();
  const body = markdown.replace(/\r\n/g, "\n").replace(MERMAID_BLOCK, "");
  for (const paragraph of body.split(/\n[ \t]*\n/)) {
    for (const name of new Set(Array.from(paragraph.matchAll(NAME), (match) => match[0]))) {
      mentions.set(name, [...(mentions.get(name) ?? []), paragraph]);
    }
  }
  return mentions;
}

const codeFiles = [
  ...CODE_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root), isCode)),
  ...readdirSync(REPO_ROOT)
    .filter((name) => /\.config\.(?:[cm]?js|ts)$/.test(name))
    .map((name) => path.join(REPO_ROOT, name)),
];
const known = new Set(
  codeFiles.flatMap((file) => [...codeNames(file, readFileSync(file, "utf8"))]),
);

const docFiles = [
  ...walk(path.join(REPO_ROOT, "docs"), isMarkdown),
  path.join(REPO_ROOT, "specs.md"),
];
/** name -> [{ file, paragraph }] across every scanned document. */
const mentions = new Map<string, Array<{ file: string; paragraph: string }>>();
for (const file of docFiles) {
  for (const [name, paragraphs] of docMentions(readFileSync(file, "utf8"))) {
    const found = paragraphs.map((paragraph) => ({ file: relative(file), paragraph }));
    mentions.set(name, [...(mentions.get(name) ?? []), ...found]);
  }
}

describe("variable names in docs/ and specs.md (I-20)", () => {
  it("scans the code and the docs it claims to", () => {
    // A path typo would make the scan vacuous: no code means every name is
    // unknown, no docs means none is checked.
    expect(known.has("BETTER_AUTH_SECRET")).toBe(true); // env.ts schema key
    expect(known.has("OUTBOX_DRAIN_LIMIT")).toBe(true); // scripts/drain-outbox.ts
    expect(known.has("VERCEL_TOKEN")).toBe(true); // vercel-cli/src
    expect(mentions.get("SSO_HANDOFF_ISSUER")?.some((m) => m.file === "specs.md")).toBe(true);
    expect(mentions.get("DATABASE_URL")?.some((m) => m.file === "docs/configuration.md")).toBe(
      true,
    );
  });

  it("names only variables the code spells, or ones listed as external or unread", () => {
    const unknown = [...mentions.entries()]
      .filter(([name]) => !known.has(name) && !(name in EXTERNAL) && !(name in UNREAD))
      .map(([name, found]) => `${name} (${[...new Set(found.map((m) => m.file))].join(", ")})`)
      .sort();
    expect(
      unknown,
      "No code outside a comment spells these. Correct the name, drop a variable that no " +
        "longer exists, or list it in EXTERNAL / UNREAD with the reason.",
    ).toEqual([]);
  });

  it("marks every mention of a variable the app does not read", () => {
    const unmarked = Object.keys(UNREAD).flatMap((name) =>
      (mentions.get(name) ?? [])
        .filter(({ paragraph }) => !MARKED.test(paragraph))
        .map(({ file, paragraph }) => `${file}: ${name} in "${paragraph.trim().slice(0, 80)}…"`),
    );
    expect(
      unmarked,
      "Say in the same paragraph that the variable is historical, retired, removed or not read.",
    ).toEqual([]);
  });

  it("keeps EXTERNAL and UNREAD to names the docs mention and the code does not", () => {
    const listed = [...Object.keys(EXTERNAL), ...Object.keys(UNREAD)];
    // A name no document mentions any more is a stale entry.
    expect(listed.filter((name) => !mentions.has(name))).toEqual([]);
    // A name the code spells needs no entry, and an UNREAD one the code spells
    // is read after all.
    expect(listed.filter((name) => known.has(name))).toEqual([]);
  });

  it("reads names from code but not from comments", () => {
    const names = codeNames(
      "probe.ts",
      [
        "// LINE_COMMENT_NAME is gone",
        "/** JSDOC_NAME was removed. */",
        "/* BLOCK_COMMENT_NAME */",
        "const schema = { SCHEMA_KEY: 1 };",
        "const limit = process.env.DIRECT_READ;",
        'const other = process.env["BRACKET_READ"];',
        'timeoutFromEnv(env, "HELPER_READ", 5);',
        "const message = `set TEMPLATE_NAME=${x} and TEMPLATE_TAIL`;",
        'const url = "https://example.com"; // AFTER_URL_COMMENT',
      ].join("\n"),
    );
    expect([...names].sort()).toEqual(
      [
        "BRACKET_READ",
        "DIRECT_READ",
        "HELPER_READ",
        "SCHEMA_KEY",
        "TEMPLATE_NAME",
        "TEMPLATE_TAIL",
      ].sort(),
    );
  });

  it("finds names in prose, tables and code blocks, but not in Mermaid or a wildcard", () => {
    const found = docMentions(
      [
        "Set `PROSE_NAME` to enable it.",
        "",
        "| `TABLE_NAME` | no | unset |",
        "",
        "```bash",
        'BLOCK_NAME="x"',
        "```",
        "",
        "```mermaid",
        'flowchart LR\n  NODE_ID["Machine client"] --> ROUTES',
        "```",
        "",
        "Every `SENTRY_*` and `NEXT_PUBLIC_SENTRY_*` variable.",
      ].join("\n"),
    );
    expect([...found.keys()].sort()).toEqual(["BLOCK_NAME", "PROSE_NAME", "TABLE_NAME"]);
  });

  it("tells a marked paragraph from an unmarked one", () => {
    expect(MARKED.test('SSO_HANDOFF_JWT_SECRET="replace-with-separate-strong-secret"')).toBe(false);
    expect(MARKED.test("the former fleet-wide symmetric `SSO_HANDOFF_JWT_SECRET` is gone")).toBe(
      true,
    );
    expect(MARKED.test("**Informational only — NOT read at runtime.**")).toBe(true);
    expect(MARKED.test("# HISTORICAL (V9): SSO_HANDOFF_JWT_SECRET")).toBe(true);
  });
});
