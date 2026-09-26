import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CLIENT_MESSAGE_SCOPES, type ClientMessageScope } from "@/i18n/client-messages";
import enMessages from "@/messages/en.json";

/**
 * F-123: each route group's `NextIntlClientProvider` serializes only the
 * message namespaces its CLIENT components read (`src/i18n/client-messages.ts`).
 * Before, the locale layout handed the whole catalog to the one provider, so
 * the landing and sign-in pages inlined the Administrator console's strings.
 *
 * The risk of scoping is a client component that reads a namespace its scope
 * left out: it renders the raw key (`auth.sendResetLink`) and logs, and no
 * type check or build notices. So this walks each scope's import graph the way
 * the bundler does: from every file of the route group, through the static,
 * value-level imports and `import()` calls, switching to client context at a
 * `"use client"` module (and staying there for everything it imports, with or
 * without a directive). Every next-intl `useTranslations` call reached in
 * client context must name a namespace the scope picks. Server components are
 * skipped on purpose: they read the request config's full catalog, not the
 * provider's.
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC_DIR = join(REPO_ROOT, "src");
const LOCALE_DIR = join(SRC_DIR, "app", "[locale]");

/**
 * Each entry directly under `src/app/[locale]`, and the scope whose provider
 * renders it. The locale segment's own error and not-found boundaries render
 * inside the locale layout's provider, whichever segment threw. A new route
 * group or boundary fails the first test until it is given a scope here.
 */
const LOCALE_ENTRIES: Record<string, ClientMessageScope> = {
  "layout.tsx": "locale",
  "error.tsx": "locale",
  "not-found.tsx": "locale",
  "(public)": "locale",
  "(auth)": "auth",
  "(secure)": "secure",
};

/** The layout that mounts each scope's provider. */
const SCOPE_LAYOUTS: Record<ClientMessageScope, string> = {
  locale: "src/app/[locale]/layout.tsx",
  auth: "src/app/[locale]/(auth)/layout.tsx",
  secure: "src/app/[locale]/(secure)/layout.tsx",
};

/** The one module allowed to render `NextIntlClientProvider`. */
const PROVIDER_MODULE = "src/components/i18n/client-messages-provider.tsx";

/**
 * Client components whose namespace is a prop, not a literal: the string-literal
 * union type the prop is declared with, and the file that declares it. The
 * scope must cover every member. An unlisted dynamic call fails, and so does a
 * listed file that no longer makes one.
 */
const DOC_SPACE = { type: "DocSpace", from: "src/lib/docs/source/types.ts" };
const DYNAMIC_NAMESPACES: Record<string, { type: string; from: string }> = {
  "src/components/api-keys/api-key-reveal.tsx": {
    type: "RevealNamespace",
    from: "src/components/api-keys/api-key-reveal.tsx",
  },
  "src/components/docs-viewer/diagram-modal.tsx": DOC_SPACE,
  "src/components/docs-viewer/doc-article.tsx": DOC_SPACE,
  "src/components/docs-viewer/docs-sidebar.tsx": DOC_SPACE,
  "src/components/docs-viewer/docs-top-header.tsx": DOC_SPACE,
  "src/components/docs-viewer/image-modal.tsx": DOC_SPACE,
  "src/components/docs-viewer/lightbox-modal.tsx": DOC_SPACE,
};

const toRepoPath = (file: string) => relative(REPO_ROOT, file).replaceAll("\\", "/");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
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

/** Whether the module's directive prologue says `"use client"`. */
function isClientModule(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

/** A next-intl hook call: its namespace literal, or null when it names none. */
interface NamespaceUse {
  namespace: string | null;
}

interface ModuleInfo {
  client: boolean;
  imports: string[];
  uses: NamespaceUse[];
}

/**
 * The module specifiers a file loads at runtime (value imports, re-exports and
 * `import()` with a literal), and its next-intl `useTranslations` /
 * `useMessages` calls, found through the local names they are imported as.
 */
function scanModule(source: ts.SourceFile): ModuleInfo {
  const imports: string[] = [];
  const hooks = new Map<string, "useTranslations" | "useMessages">();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      importsValues(statement.importClause)
    ) {
      imports.push(statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (
        statement.moduleSpecifier.text === "next-intl" &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "useTranslations" || imported === "useMessages") {
            hooks.set(element.name.text, imported);
          }
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push(statement.moduleSpecifier.text);
    }
  }

  const uses: NamespaceUse[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && ts.isStringLiteral(arg)) imports.push(arg.text);
      } else if (ts.isIdentifier(node.expression) && hooks.has(node.expression.text)) {
        const literal =
          hooks.get(node.expression.text) === "useTranslations" &&
          arg !== undefined &&
          ts.isStringLiteral(arg);
        // `useMessages()` or `useTranslations()` read the whole catalog, and a
        // non-literal argument names it at run time: all three are "dynamic".
        uses.push({ namespace: literal ? arg.text : null });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { client: isClientModule(source), imports, uses };
}

/** The `src/` module a specifier names, null for a package or a non-code asset. */
function resolveProjectModule(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC_DIR, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  if (/\.(json|css|svg|png)$/.test(base)) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  const match = candidates.find(
    (candidate) =>
      /\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile(),
  );
  // Fail loudly: skipping an unresolved module would hide its imports.
  if (!match) throw new Error(`cannot resolve ${specifier} from ${toRepoPath(fromFile)}`);
  return match;
}

const infoCache = new Map<string, ModuleInfo>();
function moduleInfo(file: string): ModuleInfo {
  let info = infoCache.get(file);
  if (!info) {
    info = scanModule(parse(file));
    infoCache.set(file, info);
  }
  return info;
}

function filesUnder(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)));
}

interface ScopeGraph {
  /** Every module reached in client context. */
  clientModules: string[];
  /** Literal namespace (top-level) → the client modules that read it. */
  namespaces: Map<string, Set<string>>;
  /** Client modules with a dynamic `useTranslations` / `useMessages` call. */
  dynamic: string[];
}

/** The client-side namespace reads of every file under `entries` of `[locale]`. */
function walkScope(entries: readonly string[]): ScopeGraph {
  const roots = entries.flatMap((entry) => filesUnder(join(LOCALE_DIR, entry)));
  const seen = new Set<string>();
  const clientModules = new Set<string>();
  const namespaces = new Map<string, Set<string>>();
  const dynamic = new Set<string>();
  const queue: Array<[string, boolean]> = roots.map((root) => [root, false]);
  while (queue.length > 0) {
    const [file, importedFromClient] = queue.shift()!;
    const info = moduleInfo(file);
    const client = importedFromClient || info.client;
    const key = `${client ? "client" : "server"}:${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const repoPath = toRepoPath(file);
    if (client) {
      clientModules.add(repoPath);
      for (const use of info.uses) {
        if (use.namespace === null) {
          dynamic.add(repoPath);
          continue;
        }
        const top = use.namespace.split(".")[0]!;
        namespaces.set(top, (namespaces.get(top) ?? new Set()).add(repoPath));
      }
    }
    for (const specifier of info.imports) {
      const next = resolveProjectModule(file, specifier);
      if (next) queue.push([next, client]);
    }
  }
  return { clientModules: [...clientModules].sort(), namespaces, dynamic: [...dynamic].sort() };
}

const entriesOf = (scope: ClientMessageScope) =>
  Object.entries(LOCALE_ENTRIES)
    .filter(([, owner]) => owner === scope)
    .map(([entry]) => entry);

const SCOPES = Object.keys(CLIENT_MESSAGE_SCOPES) as ClientMessageScope[];
const graphs = new Map<ClientMessageScope, ScopeGraph>();
function graphOf(scope: ClientMessageScope): ScopeGraph {
  let graph = graphs.get(scope);
  if (!graph) {
    graph = walkScope(entriesOf(scope));
    graphs.set(scope, graph);
  }
  return graph;
}

/** The members of a `type X = "a" | "b"` alias declared in `from`. */
function stringLiteralUnion(from: string, typeName: string): string[] {
  const source = parse(join(REPO_ROOT, from));
  for (const statement of source.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== typeName) continue;
    const members = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type];
    return members.map((member) => {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
        return member.literal.text;
      }
      throw new Error(`${typeName} in ${from} is not a union of string literals`);
    });
  }
  throw new Error(`no type ${typeName} in ${from}`);
}

/** Every `"<namespace> <- <client module>"` the graph reads and `picked` leaves out. */
function missingNamespaces(graph: ScopeGraph, picked: readonly string[]): string[] {
  const reads: Array<[string, string]> = [];
  for (const [namespace, files] of graph.namespaces) {
    for (const file of files) reads.push([namespace, file]);
  }
  for (const file of graph.dynamic) {
    const declared = DYNAMIC_NAMESPACES[file];
    if (!declared) continue; // Reported by its own test.
    for (const member of stringLiteralUnion(declared.from, declared.type)) {
      reads.push([member.split(".")[0]!, file]);
    }
  }
  return reads
    .filter(([namespace]) => !picked.includes(namespace))
    .map(([namespace, file]) => `${namespace} <- ${file}`)
    .sort();
}

/** The JSX elements named `tag` in a file, with their string-literal attributes. */
function jsxElements(file: string, tag: string): Array<Record<string, string>> {
  const source = parse(file);
  const found: Array<Record<string, string>> = [];
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening && opening.tagName.getText(source) === tag) {
      const attributes: Record<string, string> = {};
      for (const attribute of opening.attributes.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer)
        ) {
          attributes[attribute.name.getText(source)] = attribute.initializer.text;
        }
      }
      found.push(attributes);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("client message scopes (F-123)", () => {
  it("assigns every route group and boundary under [locale] to a scope", () => {
    expect(readdirSync(LOCALE_DIR).sort()).toEqual(Object.keys(LOCALE_ENTRIES).sort());
    expect([...new Set(Object.values(LOCALE_ENTRIES))].sort()).toEqual([...SCOPES].sort());
  });

  it("mounts each scope's provider in its layout, and no other NextIntlClientProvider", () => {
    for (const scope of SCOPES) {
      const layout = join(REPO_ROOT, SCOPE_LAYOUTS[scope]);
      expect(
        jsxElements(layout, "ClientMessagesProvider").map((attributes) => attributes.scope),
        SCOPE_LAYOUTS[scope],
      ).toEqual([scope]);
    }
    // A provider mounted anywhere else would serialize whatever it was given,
    // the whole catalog included: the pre-F-123 locale layout did exactly that.
    const rendersProvider = filesUnder(SRC_DIR)
      .filter((file) => file.endsWith(".tsx"))
      .filter((file) => jsxElements(file, "NextIntlClientProvider").length > 0)
      .map(toRepoPath);
    expect(rendersProvider).toEqual([PROVIDER_MODULE]);
  });

  it.each(SCOPES)("the %s scope covers every namespace its client components read", (scope) => {
    expect(missingNamespaces(graphOf(scope), CLIENT_MESSAGE_SCOPES[scope])).toEqual([]);
  });

  it("walks the client modules each scope actually renders", () => {
    // Guards against a vacuous pass: if resolution or the client switch
    // silently stopped, the coverage assertions would hold for any scope.
    expect(graphOf("locale").clientModules).toEqual(
      expect.arrayContaining([
        "src/app/[locale]/not-found.tsx",
        "src/components/observability/route-error.tsx",
        "src/components/i18n/locale-switcher.tsx",
      ]),
    );
    expect(graphOf("auth").clientModules).toEqual(
      expect.arrayContaining([
        "src/components/auth/email-password-login-form.tsx",
        "src/components/auth/reset-password-form.tsx",
        "src/components/ui/form.tsx",
      ]),
    );
    expect(graphOf("secure").clientModules).toEqual(
      expect.arrayContaining([
        "src/app/[locale]/(secure)/_components/secure-sidebar.tsx",
        "src/app/[locale]/(secure)/app/administrator/_components/grid/data-grid.tsx",
        "src/app/[locale]/(secure)/app/account/api-keys/_api-keys-panel.tsx",
        // No directive: client because client grids import it.
        "src/components/ui/status-badge.tsx",
      ]),
    );
    expect(graphOf("secure").namespaces.get("common")).toContain(
      "src/components/ui/status-badge.tsx",
    );
    expect(graphOf("secure").dynamic).toEqual(Object.keys(DYNAMIC_NAMESPACES).sort());
  });

  it("does not count a server component's reads", () => {
    // The landing page is a Server Component whose `useTranslations("public")`
    // reads the request config's catalog, so the provider need not carry it.
    const landing = join(LOCALE_DIR, "(public)", "page.tsx");
    expect(moduleInfo(landing)).toMatchObject({
      client: false,
      uses: [expect.objectContaining({ namespace: "public" })],
    });
    expect(graphOf("locale").namespaces.has("public")).toBe(false);
  });

  it("reports a client component whose namespace the scope leaves out (negative control)", () => {
    // The sign-in forms under the bare locale scope, i.e. what a sign-in page
    // would get if the (auth) layout's provider went away.
    expect(missingNamespaces(graphOf("auth"), CLIENT_MESSAGE_SCOPES.locale)).toEqual(
      expect.arrayContaining([
        "auth <- src/components/auth/email-password-login-form.tsx",
        "validation <- src/components/ui/form.tsx",
      ]),
    );
    // A dynamic namespace is checked member by member.
    expect(
      missingNamespaces(
        graphOf("secure"),
        CLIENT_MESSAGE_SCOPES.secure.filter((namespace) => namespace !== "help"),
      ),
    ).toContain("help <- src/components/docs-viewer/doc-article.tsx");
  });

  it("names the namespace type of every dynamic useTranslations call", () => {
    const dynamic = new Set(SCOPES.flatMap((scope) => graphOf(scope).dynamic));
    expect([...dynamic].filter((file) => !(file in DYNAMIC_NAMESPACES))).toEqual([]);
    for (const [file, declared] of Object.entries(DYNAMIC_NAMESPACES)) {
      // Stale entry: the file must still make a dynamic call.
      const uses = moduleInfo(join(REPO_ROOT, file)).uses;
      expect(
        uses.some((use) => use.namespace === null),
        file,
      ).toBe(true);
      expect(stringLiteralUnion(declared.from, declared.type).length).toBeGreaterThan(0);
    }
  });

  it("picks only namespaces the catalog has, and repeats the locale scope in each nested one", () => {
    const catalog = Object.keys(enMessages);
    for (const scope of SCOPES) {
      expect(CLIENT_MESSAGE_SCOPES[scope].filter((ns) => !catalog.includes(ns))).toEqual([]);
      // A nested provider REPLACES its parent's messages rather than merging.
      expect(CLIENT_MESSAGE_SCOPES[scope]).toEqual(
        expect.arrayContaining([...CLIENT_MESSAGE_SCOPES.locale]),
      );
    }
  });

  it("keeps the signed-in namespaces out of the public and sign-in pages", () => {
    for (const scope of ["locale", "auth"] as const) {
      expect(CLIENT_MESSAGE_SCOPES[scope]).not.toContain("administrator");
      expect(CLIENT_MESSAGE_SCOPES[scope]).not.toContain("account");
      expect(CLIENT_MESSAGE_SCOPES[scope]).not.toContain("shell");
    }
  });
});
