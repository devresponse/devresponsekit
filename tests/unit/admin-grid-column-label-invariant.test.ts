import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A11Y-4 systemic guard — every SORTABLE Administrator grid column must
 * declare a header that resolves to a real, translated label.
 *
 * `DataGridColumnHeader` derives the sort button's accessible name from the
 * rendered header (name-from-content, see the component's A11Y-4 comment).
 * That is robust against the class of bug it replaced — an `aria-label` that
 * silently fell back to "" for every column — but it moves the failure mode
 * one step out: a column whose header renders no text at all (an icon, `""`,
 * `null`) would now produce a NAMELESS button instead of a wrongly-named one.
 *
 * axe cannot catch either shape here: the old bug produced a non-empty name
 * ("— Not sorted") on every column, and the new one only appears on a page a
 * sweep happens to visit. tests/component/administrator-data-grid.test.tsx
 * pins the rendering contract on one grid; this is the completeness critic
 * that makes it hold for all ~17 of them, including grids no component test
 * renders and grids that do not exist yet.
 *
 * NON-sortable columns are deliberately out of scope: the row-action columns
 * legitimately declare `header: () => ""` and render no button at all
 * (`renderSortableHeader` returns the raw header for a column with no
 * `accessorKey`), so there is nothing to name.
 *
 * The scan uses the TypeScript AST rather than the regex style of its sibling
 * invariants because the unit here is a nested object literal inside a
 * `useMemo` array — pairing an `accessorKey` with the `header` of the SAME
 * object is exactly what brace-counting gets wrong, and a guard that
 * mis-pairs is worse than none.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
// `[locale]` and `(secure)` are literal directory names — build the path with
// join() (not new URL(), which would percent-encode the brackets).
const ADMIN_PAGES_DIR = join(SRC_DIR, "app", "[locale]", "(secure)", "app", "administrator");

/** A column definition that `DataGrid` will wrap in a sort button. */
interface SortableColumn {
  accessorKey: string;
  /** Source text of the `header` value, for the failure message. */
  headerText: string;
  resolvesToLabel: boolean;
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

/**
 * `t("key")` / `tGrid("columns.x")` — the translation-call shape every admin
 * column uses. A property access (`t.rich(…)`) is matched on its final name,
 * so only a genuine `t`-family call with a non-empty key counts.
 */
function isTranslationCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  if (name === undefined || !/^t([A-Z][A-Za-z0-9]*)?$/.test(name)) return false;
  const [first] = node.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) && first.text.trim().length > 0;
}

const hasText = (node: ts.Node): boolean =>
  ts.isStringLiteralLike(node) && node.text.trim().length > 0;

/**
 * True when the `header` value is guaranteed to render some text: a non-empty
 * string, or a function that returns one — directly, as JSX text, or (the
 * universal case here) through a translation call anywhere in its body.
 *
 * Deliberately permissive about SHAPE and strict about TEXT: a future
 * `header: () => (<span>{t("x")} <InfoIcon /></span>)` is fine, while
 * `() => ""`, `() => null` and `() => <SortIcon />` are not.
 */
function resolvesToLabel(initializer: ts.Expression): boolean {
  if (hasText(initializer)) return true;
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) return false;

  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && isTranslationCall(node)) {
      found = true;
      return;
    }
    // A bare string counts only where it is actually rendered — as the
    // function's result or as JSX text. A `className="…"` string is not a
    // label, and accepting it would make the guard pass on an icon-only
    // header.
    const renderedString =
      hasText(node) &&
      node.parent !== undefined &&
      (node.parent === initializer || ts.isReturnStatement(node.parent));
    if (renderedString || (ts.isJsxText(node) && node.text.trim().length > 0)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(initializer.body);
  return found;
}

/** Every sortable column definition in one grid source file. */
function scanSortableColumns(source: string, fileName = "grid.tsx"): SortableColumn[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );
  const out: SortableColumn[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const pick = (name: string): ts.PropertyAssignment | undefined =>
        node.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p) === name,
        );

      const accessor = pick("accessorKey");
      // `accessorKey` is what makes a column sortable (see
      // `renderSortableHeader`); `enableSorting: false` opts back out.
      if (accessor !== undefined && ts.isStringLiteralLike(accessor.initializer)) {
        const optedOut = pick("enableSorting")?.initializer.kind === ts.SyntaxKind.FalseKeyword;
        if (!optedOut) {
          const header = pick("header");
          out.push({
            accessorKey: accessor.initializer.text,
            headerText:
              header === undefined ? "(no header property)" : header.initializer.getText(),
            resolvesToLabel: header !== undefined && resolvesToLabel(header.initializer),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return out;
}

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsx(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function rel(full: string): string {
  const norm = full.replace(/\\/g, "/");
  const idx = norm.indexOf("administrator");
  return idx >= 0 ? norm.slice(idx) : norm;
}

const gridFiles = walkTsx(ADMIN_PAGES_DIR).filter((file) =>
  readFileSync(file, "utf8").includes("ColumnDef<"),
);

describe("A11Y-4: every sortable admin grid column has a translated header label", () => {
  it("discovers the Administrator grid column definitions", () => {
    // Thresholds, not exact counts — the point is that the scan cannot
    // silently stop finding anything (a rename of the column shape, a move of
    // the directory) and report a vacuous pass.
    expect(gridFiles.length).toBeGreaterThan(10);
    const columns = gridFiles.flatMap((file) => scanSortableColumns(readFileSync(file, "utf8")));
    expect(columns.length).toBeGreaterThan(50);
  });

  it.each(gridFiles.map((f) => [rel(f), f] as const))(
    "%s names every sortable column",
    (relPath, full) => {
      const columns = scanSortableColumns(readFileSync(full, "utf8"), relPath);
      for (const column of columns) {
        expect(
          column.resolvesToLabel,
          `${relPath}: the sortable column "${column.accessorKey}" declares ` +
            `header: ${column.headerText}, which renders no text. DataGrid wraps it in a ` +
            `sort button whose accessible name comes from that header (A11Y-4), so screen ` +
            `reader and voice-control users would get an unnamed control. Return a ` +
            `translated label (header: () => t("columns.x")), or set enableSorting: false ` +
            `if the column is not meant to be sortable.`,
        ).toBe(true);
      }
    },
  );

  it("detects an unlabelled sortable column", () => {
    // The sweep above passes vacuously while the grids are clean, so pin the
    // detector on the shapes that would actually ship a nameless button.
    const offending = [
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => "" }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => null }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => <SortIcon /> }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => <span className="x" /> }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => t("") }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", cell: () => null }];`,
    ];
    for (const sample of offending) {
      const [column] = scanSortableColumns(sample);
      expect(column, sample).toBeDefined();
      expect(column!.resolvesToLabel, sample).toBe(false);
    }

    const allowed = [
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => t("columns.a") }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => tGrid("columns.a") }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: "Name" }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => "Name" }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => <span>{t("columns.a")} <Info /></span> }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => <span>Name</span> }];`,
      `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => { return t("columns.a"); } }];`,
    ];
    for (const sample of allowed) {
      const [column] = scanSortableColumns(sample);
      expect(column, sample).toBeDefined();
      expect(column!.resolvesToLabel, sample).toBe(true);
    }
  });

  it("leaves non-sortable columns alone", () => {
    // The row-action columns really do render an empty header and no button.
    const rowActions = `const c: ColumnDef<R, unknown>[] = [{ id: "__actions", header: () => "", cell: () => null }];`;
    expect(scanSortableColumns(rowActions)).toEqual([]);

    const optedOut = `const c: ColumnDef<R, unknown>[] = [{ id: "a", accessorKey: "a", header: () => "", enableSorting: false }];`;
    expect(scanSortableColumns(optedOut)).toEqual([]);
  });
});
