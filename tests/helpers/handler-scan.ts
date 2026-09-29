import ts from "typescript";

/**
 * TypeScript-AST helpers for the source-scan invariants that must answer a
 * question PER HANDLER (F-127) or per declaration (I-15), not per file.
 *
 * The first scans read each route file as text: "does this file mention a
 * scope primitive / a limiter / a guard anywhere?". A file whose GET was
 * scoped passed with a DELETE that was not, a comment quoting the limiter
 * counted as a call, and a count of limiter calls could be made up by one
 * handler calling it twice. These helpers parse the file instead, find what
 * Next runs for each exported method, and list the calls that code can reach.
 *
 * Reachability follows the handler's own subtree plus the MODULE-SCOPE
 * functions and constants it names (a shared `loadScoped(...)` helper is part
 * of every handler that calls it). It follows names only at module scope: a
 * local variable in one handler never stands in for a call made by another,
 * and a parameter or local that shadows a module helper's name is not taken
 * for that helper. Calls into other modules are opaque, so a guard hidden
 * behind an imported wrapper has to be named by the scan that relies on it.
 */

export const HTTP_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * `full` below `dir`, with forward slashes: `pathBelow(<src>/app, …)` gives
 * `api/v1/users/route.ts`, the form the scans key their exemption maps on.
 * It slices off the resolved directory rather than cutting at the first
 * `api/` in the path, so a checkout under `/home/me/api/…` keys the same.
 */
export function pathBelow(dir: string, full: string): string {
  const base = dir.replace(/\\/g, "/").replace(/\/?$/, "/");
  const norm = full.replace(/\\/g, "/");
  if (!norm.startsWith(base)) throw new Error(`${full} is not below ${dir}`);
  return norm.slice(base.length);
}

export function parseSource(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

export interface RouteHandler {
  /** The exported method name, or `*` for an `export * from` this scan cannot see into. */
  method: string;
  /** 1-based line of the export. */
  line: number;
  /**
   * What Next runs for the method: the function declaration, or the
   * initializer of the exported `const` (the `withAdminRoute(async function
   * …)` call, an arrow, or the object a destructuring export reads). `null`
   * when the method comes from another module (`export { GET } from "./x"`,
   * a re-exported import, `export *`): its code is not in this file, so no
   * property of it can be shown here and a scan must treat it as failing.
   */
  body: ts.Node | null;
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * The module-scope names a handler can call through: function declarations
 * and `const`/`let`/`var` initializers (which covers an arrow helper).
 */
function moduleBindings(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: string, node: ts.Node) => out.set(name, [...(out.get(name) ?? []), node]);
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) add(decl.name.text, decl.initializer);
      }
    }
  }
  return out;
}

/**
 * Every exported HTTP method handler in a route module, in all the shapes
 * Next accepts: `export [async] function GET`, `export const GET = …`
 * (including the `withAdminRoute(async function GET(…))` wrapper form), a
 * destructuring export (`export const { GET, POST } = handlers`), an export
 * list (`export { handler as GET }`), and the re-exports whose code lives
 * elsewhere (`export { GET } from "./x"`, `export *`), which come back with
 * a `null` body.
 */
export function routeHandlers(sf: ts.SourceFile): RouteHandler[] {
  const bindings = moduleBindings(sf);
  const out: RouteHandler[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      const name = statement.name?.text;
      if (name && HTTP_METHODS.has(name)) {
        out.push({ method: name, line: lineOf(sf, statement), body: statement });
      }
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const body = decl.initializer ?? null;
        const names = ts.isIdentifier(decl.name)
          ? [decl.name.text]
          : ts.isObjectBindingPattern(decl.name)
            ? decl.name.elements.flatMap((el) => (ts.isIdentifier(el.name) ? [el.name.text] : []))
            : [];
        for (const name of names.filter((n) => HTTP_METHODS.has(n))) {
          out.push({ method: name, line: lineOf(sf, decl), body });
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (!clause) {
        // `export * from "./x"` forwards whatever `./x` exports, unread.
        out.push({ method: "*", line: lineOf(sf, statement), body: null });
      } else if (ts.isNamedExports(clause)) {
        for (const spec of clause.elements) {
          if (spec.isTypeOnly || !HTTP_METHODS.has(spec.name.text)) continue;
          const local = (spec.propertyName ?? spec.name).text;
          // With a module specifier the name is another module's; without one
          // it is a local binding, or an import (no module-scope binding).
          const bound = statement.moduleSpecifier ? undefined : bindings.get(local)?.[0];
          out.push({ method: spec.name.text, line: lineOf(sf, spec), body: bound ?? null });
        }
      }
      // `export * as ns from "./x"` exports one namespace object, never a method.
    }
  }
  return out;
}

/** The called name: `f` in `f(…)` and in `ns.f(…)`. */
export function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** Whether `id` READS a binding, rather than naming a member or declaring one. */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === id;
  if (ts.isQualifiedName(parent)) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isParameter(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === id || parent.propertyName === id)) {
    return false;
  }
  return !(ts.isImportSpecifier(parent) || ts.isImportClause(parent));
}

/** Every name a binding declares: `x`, and each name in `{ a, b: [c, ...d] }`. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isBindingElement(el) ? bindingNames(el.name) : []));
}

/** The names a statement list declares in its own block scope. */
function blockNames(statements: readonly ts.Statement[]): string[] {
  return statements.flatMap((s) => {
    if (ts.isVariableStatement(s)) {
      return s.declarationList.declarations.flatMap((d) => bindingNames(d.name));
    }
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) return [s.name.text];
    return [];
  });
}

/** The names a (non-module) scope node declares for the code inside it. */
function scopeNames(node: ts.Node): string[] {
  if (ts.isFunctionLike(node)) {
    const own = ts.isFunctionExpression(node) && node.name ? [node.name.text] : [];
    return [...own, ...node.parameters.flatMap((p) => bindingNames(p.name))];
  }
  if (ts.isBlock(node)) return blockNames(node.statements);
  if (ts.isCaseBlock(node)) return blockNames(node.clauses.flatMap((c) => [...c.statements]));
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    const init = node.initializer;
    return init && ts.isVariableDeclarationList(init)
      ? init.declarations.flatMap((d) => bindingNames(d.name))
      : [];
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    return bindingNames(node.variableDeclaration.name);
  }
  return [];
}

/**
 * Whether `id` reads a binding declared between it and module scope (a
 * parameter, a local, a nested function), so it names that local and not the
 * module-scope function or constant that happens to share its name. A `var`
 * hoisted out of a nested block is not seen, which only errs toward following
 * the module binding.
 */
function isShadowed(id: ts.Identifier): boolean {
  for (let node: ts.Node = id.parent; !ts.isSourceFile(node); node = node.parent) {
    if (scopeNames(node).includes(id.text)) return true;
  }
  return false;
}

/**
 * Every call `from` can reach: its own subtree, plus the body of each
 * module-scope function or constant it names, transitively. `from` may be a
 * handler body, a top-level statement, or the whole source file. A name the
 * code declares for itself (a parameter or a local) is not followed to a
 * module-scope binding of the same name.
 */
export function reachableCalls(sf: ts.SourceFile, from: ts.Node): ts.CallExpression[] {
  const bindings = moduleBindings(sf);
  const out: ts.CallExpression[] = [];
  const seen = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isCallExpression(node)) out.push(node);
    if (
      ts.isIdentifier(node) &&
      isReference(node) &&
      bindings.has(node.text) &&
      !isShadowed(node)
    ) {
      for (const bound of bindings.get(node.text) ?? []) visit(bound);
    }
    ts.forEachChild(node, visit);
  };
  visit(from);
  return out;
}

/**
 * The reachable calls to one of `names`, optionally only those `accept`
 * admits (an argument-shape check). Empty for a handler with no body.
 */
export function reachableCallsNamed(
  sf: ts.SourceFile,
  from: ts.Node | null,
  names: ReadonlySet<string>,
  accept: (call: ts.CallExpression) => boolean = () => true,
): ts.CallExpression[] {
  if (from === null) return [];
  return reachableCalls(sf, from).filter((call) => {
    const name = calleeName(call);
    return name !== undefined && names.has(name) && accept(call);
  });
}

/** The module-scope statement that contains `node`. */
export function topLevelStatement(node: ts.Node): ts.Statement {
  let current = node;
  while (!ts.isSourceFile(current.parent)) current = current.parent;
  return current as ts.Statement;
}

/**
 * A readable name for a module-scope statement: the function's or the
 * (first) variable's name, else `<line N>`.
 */
export function statementName(sf: ts.SourceFile, statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement) && statement.name) return statement.name.text;
  if (ts.isVariableStatement(statement)) {
    const first = statement.declarationList.declarations[0];
    if (first && ts.isIdentifier(first.name)) return first.name.text;
  }
  return `<line ${lineOf(sf, statement)}>`;
}
