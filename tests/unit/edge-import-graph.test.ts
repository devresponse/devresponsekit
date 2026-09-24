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

/** The module specifiers a file imports or re-exports at runtime. */
function staticValueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
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
 * reaches, plus each Node-only import as `"<importer> -> <specifier>"`.
 */
function walk(roots: readonly string[]): { modules: string[]; nodeImports: string[] } {
  const seen = new Set<string>();
  const nodeImports: string[] = [];
  const queue = roots.map((root) => join(REPO_ROOT, root));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of staticValueImports(file)) {
      if (isNodeOnly(specifier)) {
        nodeImports.push(`${toRepoPath(file)} -> ${specifier}`);
        continue;
      }
      const next = resolveProjectModule(file, specifier);
      if (next) queue.push(next);
    }
  }
  return { modules: [...seen].map(toRepoPath).sort(), nodeImports };
}

describe("Edge instrumentation import graph", () => {
  it("reaches no Node built-in or Node-only package", () => {
    expect(walk(EDGE_ROOTS).nodeImports).toEqual([]);
  });

  it("walks the modules the Edge bundle actually contains", () => {
    // Guards against a vacuous pass: if resolution silently stopped at the
    // root, the assertion above would hold for any graph.
    expect(walk(EDGE_ROOTS).modules).toEqual(
      expect.arrayContaining([
        "src/instrumentation.ts",
        "src/lib/request-id.ts",
        "src/lib/forwarded-hops.ts",
        "src/lib/env.ts",
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
});
