import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The Edge half of `src/instrumentation.ts` must stay free of Node built-ins
 * (F-16 review follow-up).
 *
 * Next compiles `instrumentation.ts` for the Edge runtime as well as for Node
 * (the build lists `server/edge/chunks/src_instrumentation_ts_*.js` under
 * `instrumentation` in `.next/server/instrumentation/middleware-manifest.json`).
 * Its dynamic imports are guarded by `NEXT_RUNTIME`, as the Next docs require,
 * so the Edge bundle holds exactly the STATIC graph: `@/lib/request-id` and
 * whatever that imports. When a Node built-in gets into that graph, Turbopack
 * only warns ("A Node.js module is loaded … not supported in the Edge
 * Runtime") and substitutes a stub that throws when used, so the build and
 * every check stay green.
 *
 * That happened once: `request-id.ts` imported `hasForwardedHops` from
 * `client-ip.ts`, and F-16 gave `client-ip.ts` a `node:net` import. The hop
 * counter now lives in `src/lib/forwarded-hops.ts`, which has no Node imports,
 * and this scan keeps it that way. It walks the static, value-level imports
 * (type-only imports are erased; `import()` is the runtime-guarded path) of
 * every module under `src/` that the Edge build loads, and fails on a Node
 * built-in or a Node-only package.
 *
 * It also fails on `process.getBuiltinModule` in any of those modules (F-22
 * follow-up). That call reaches a built-in without an import, so the import
 * walk cannot see it, but Turbopack does: `env-validators.ts` once resolved
 * `node:crypto` that way, and every `next build` printed "A Node.js API is
 * used (process.getBuiltinModule …) which is not supported in the Edge
 * Runtime" under the `[Edge Instrumentation]` trace. The key import now lives
 * in `env-signing-keys.server.ts`, which only the Node branch of `register()`
 * imports, dynamically.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");

/**
 * What the Edge build loads: `instrumentation.ts` itself, plus the config its
 * `NEXT_RUNTIME === "edge"` branch imports.
 */
const EDGE_ROOTS = ["src/instrumentation.ts", "src/sentry.edge.config.ts"];

/**
 * Packages this repo uses that load only on Node. `instrumentation.ts` names
 * both as the reason its Node-side imports are dynamic.
 */
const NODE_ONLY_PACKAGES = new Set(["pg", "pino"]);

function isNodeOnly(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    builtinModules.includes(specifier) ||
    NODE_ONLY_PACKAGES.has(specifier)
  );
}

/** Whether an import declaration binds any runtime value (as opposed to types only). */
function importsValues(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true; // `import "x"` — side effects only, and it runs.
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

/** Reads a module's source; the negative controls substitute one file's text. */
type ReadSource = (file: string) => string;
const readSource: ReadSource = (file) => readFileSync(file, "utf8");

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Node APIs reached WITHOUT an import, which Turbopack flags in an Edge bundle
 * although no import names a built-in.
 */
const NODE_ONLY_GLOBAL_APIS = new Set(["getBuiltinModule"]);

/**
 * Every use of a {@link NODE_ONLY_GLOBAL_APIS} member in `source`, as
 * `"<line>:<name>"`: `process.getBuiltinModule(…)`, `process["getBuiltinModule"]`
 * and `const { getBuiltinModule } = process` all name it. Comments do not.
 */
function nodeGlobalApiUses(source: ts.SourceFile): string[] {
  const uses: string[] = [];
  const visit = (node: ts.Node) => {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (name && NODE_ONLY_GLOBAL_APIS.has(name)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      uses.push(`${line + 1}:${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** The module specifiers a file imports or re-exports at runtime. */
function staticValueImports(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      importsValues(statement.importClause)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/** The `src/` file a specifier names, or null for a package. */
function resolveProjectModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  const match = candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
  // Fail loudly: skipping an unresolved module would hide its imports.
  if (!match) throw new Error(`cannot resolve ${specifier} from ${toRepoPath(fromFile)}`);
  return match;
}

const toRepoPath = (file: string) => relative(REPO_ROOT, file).replaceAll("\\", "/");

/**
 * Walks the static graph from `roots` and returns every project module it
 * reaches, each Node-only import as `"<importer> -> <specifier>"`, and each
 * import-free Node API use as `"<file>:<line> -> <name>"`.
 */
function walk(
  roots: readonly string[],
  read: ReadSource = readSource,
): { modules: string[]; nodeImports: string[]; nodeApis: string[] } {
  const seen = new Set<string>();
  const nodeImports: string[] = [];
  const nodeApis: string[] = [];
  const queue = roots.map((root) => join(REPO_ROOT, root));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = parse(file, read(file));
    for (const use of nodeGlobalApiUses(source)) {
      const [line, name] = use.split(":");
      nodeApis.push(`${toRepoPath(file)}:${line} -> ${name}`);
    }
    for (const specifier of staticValueImports(source)) {
      if (isNodeOnly(specifier)) {
        nodeImports.push(`${toRepoPath(file)} -> ${specifier}`);
        continue;
      }
      const next = resolveProjectModule(file, specifier);
      if (next) queue.push(next);
    }
  }
  return { modules: [...seen].map(toRepoPath).sort(), nodeImports, nodeApis };
}

/**
 * How `env-validators.ts` reached `node:crypto` before this check existed:
 * it passed the import walk and still broke the Edge build.
 */
const PRE_FIX_NODE_CRYPTO = `
function nodeCrypto(): typeof NodeCrypto | undefined {
  if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") {
    return undefined;
  }
  return process.getBuiltinModule("node:crypto");
}
`;

describe("Edge instrumentation import graph", () => {
  it("reaches no Node built-in or Node-only package", () => {
    expect(walk(EDGE_ROOTS).nodeImports).toEqual([]);
  });

  it("uses no Node API that needs no import (process.getBuiltinModule)", () => {
    expect(walk(EDGE_ROOTS).nodeApis).toEqual([]);
  });

  it("walks the modules the Edge bundle actually contains", () => {
    // Guards against a vacuous pass: if resolution silently stopped at the
    // root, the assertions above would hold for any graph.
    expect(walk(EDGE_ROOTS).modules).toEqual(
      expect.arrayContaining([
        "src/instrumentation.ts",
        "src/lib/request-id.ts",
        "src/lib/forwarded-hops.ts",
        "src/lib/env.ts",
        // F-17: env.ts validates CLIENT_IP_SOURCE with this module's parser.
        "src/lib/client-ip-source.ts",
        // F-22: env.ts's origin and key-shape rules. Pure on purpose: the key
        // IMPORT lives in env-signing-keys.server.ts (below).
        "src/lib/env-validators.ts",
        "src/sentry.edge.config.ts",
      ]),
    );
  });

  it("does not reach client-ip.ts, which imports node:net", () => {
    const { modules } = walk(EDGE_ROOTS);
    expect(modules).not.toContain("src/lib/client-ip.ts");
    // The detector itself works: rooted at client-ip.ts, it reports node:net.
    expect(walk(["src/lib/client-ip.ts"]).nodeImports).toContain(
      "src/lib/client-ip.ts -> node:net",
    );
  });

  it("does not reach env-signing-keys.server.ts, which imports node:crypto", () => {
    // register() imports it dynamically inside its Node branch; the walk
    // follows static imports only, as the Edge bundle does.
    expect(walk(EDGE_ROOTS).modules).not.toContain("src/lib/env-signing-keys.server.ts");
    expect(walk(["src/lib/env-signing-keys.server.ts"]).nodeImports).toContain(
      "src/lib/env-signing-keys.server.ts -> node:crypto",
    );
  });

  it("reports process.getBuiltinModule in an Edge module (negative control)", () => {
    // The Edge graph as it is, with env-validators.ts carrying its pre-fix
    // nodeCrypto() again: the walk must report both uses in it.
    const validators = join(SRC_DIR, "lib", "env-validators.ts");
    const lines = readSource(validators).split("\n").length;
    const { nodeApis, nodeImports } = walk(EDGE_ROOTS, (file) =>
      file === validators ? readSource(file) + PRE_FIX_NODE_CRYPTO : readSource(file),
    );
    expect(nodeApis).toEqual([
      `src/lib/env-validators.ts:${lines + 2} -> getBuiltinModule`,
      `src/lib/env-validators.ts:${lines + 5} -> getBuiltinModule`,
    ]);
    expect(nodeImports).toEqual([]);
  });

  it("names the API however it is reached, and ignores comments", () => {
    const uses = (text: string) => nodeGlobalApiUses(parse("probe.ts", text));
    expect(uses('process["getBuiltinModule"]("node:fs");')).toEqual(["1:getBuiltinModule"]);
    expect(uses("const { getBuiltinModule } = process;")).toEqual(["1:getBuiltinModule"]);
    expect(uses("globalThis.process.getBuiltinModule?.('node:os');")).toEqual([
      "1:getBuiltinModule",
    ]);
    expect(uses("// process.getBuiltinModule\n/* getBuiltinModule( */ const a = 1;")).toEqual([]);
  });
});
