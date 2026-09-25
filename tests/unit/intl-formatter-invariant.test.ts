import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * F-37: every date, time and number the UI shows goes through the app
 * formatter (`useAppFormatter` in a client component, `getAppFormatter` in a
 * server one, both over `src/lib/format/app-format.ts`).
 *
 * Before F-37 about thirty grids, panels and pages each built their own
 * `new Intl.DateTimeFormat(locale, …)`. None of them named a zone, so a
 * server component formatted in the server's zone (UTC in production) and a
 * client component in the browser's: the same registration read 3:04 PM on
 * the Administrator overview and 8:04 AM in the Users grid. And none of them
 * read the saved time zone, date format or number format, so the account
 * Preferences page stored three values nothing applied.
 *
 * A new ad-hoc formatter would bring both faults straight back, and no type
 * check or render test notices (it renders a plausible date). So this scans
 * the TypeScript AST of every UI source file (`src/app`, `src/components`,
 * `src/hooks`) and fails on:
 *   - any use of `Intl.DateTimeFormat`, `Intl.NumberFormat`,
 *     `Intl.RelativeTimeFormat` or `Intl.DurationFormat`;
 *   - a `.toLocaleString()`, `.toLocaleDateString()` or
 *     `.toLocaleTimeString()` call (the same formatters, hidden);
 *   - importing next-intl's `useFormatter` / `getFormatter`. Those do apply
 *     the viewer's zone, but not the saved date format or number locale,
 *     which Intl options cannot express (see app-format.ts).
 * Comments and strings are not code, so the AST scan ignores them. A file
 * that genuinely needs one is named in {@link ALLOWED} with its reason, and
 * the allow-list is itself checked so a stale entry fails too.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const UI_DIRS = ["app", "components", "hooks"].map((d) => join(SRC_DIR, d));

const INTL_FORMATTERS = new Set([
  "DateTimeFormat",
  "NumberFormat",
  "RelativeTimeFormat",
  "DurationFormat",
]);
const LOCALE_METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
const NEXT_INTL_FORMATTERS = new Set(["useFormatter", "getFormatter"]);

/** Path (relative to src/, forward slashes) → why it may format on its own. */
const ALLOWED: Record<string, string> = {
  "components/ui/calendar.tsx":
    "Generated shadcn primitive (exempt per §29.2.3) and mounted nowhere. Its month-dropdown " +
    "names and the day cell's data attribute describe react-day-picker's local calendar grid, " +
    "not a stored instant.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every ad-hoc formatter in one source file, as `line: what`. */
function adHocFormatters(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const at = (node: ts.Node, what: string) =>
    found.push(`${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${what}`);

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Intl" &&
      INTL_FORMATTERS.has(node.name.text)
    ) {
      at(node, `Intl.${node.name.text}`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      LOCALE_METHODS.has(node.expression.name.text)
    ) {
      at(node, `.${node.expression.name.text}()`);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith("next-intl") &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const el of node.importClause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (NEXT_INTL_FORMATTERS.has(imported)) {
          at(el, `${imported} from "${node.moduleSpecifier.text}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const files = UI_DIRS.flatMap(walk).map((file) => ({
  rel: relative(SRC_DIR, file).split("\\").join("/"),
  source: readFileSync(file, "utf8"),
}));

describe("UI dates and numbers go through the app formatter (F-37)", () => {
  it("scans the UI tree", () => {
    // Vacuity guard: a moved directory must fail loudly, not pass a scan of nothing.
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.rel)).toContain(
      "app/[locale]/(secure)/app/administrator/users/_users-grid.tsx",
    );
  });

  it("no UI file builds its own Intl date/number formatter", () => {
    const offenders = files
      .filter((f) => !(f.rel in ALLOWED))
      .flatMap((f) => adHocFormatters(f.rel, f.source).map((hit) => `${f.rel}:${hit}`));
    expect(
      offenders,
      "Format through the app formatter instead: `const format = useAppFormatter()` " +
        '("@/components/i18n/format-preferences") in a client component, ' +
        '`const format = await getAppFormatter(locale)` ("@/lib/format/viewer-format.server") ' +
        "in a server one, then format.date / format.dateTime / format.number. An ad-hoc " +
        "formatter ignores the viewer's saved zone and formats, and renders a different zone " +
        "on the server than in the browser. If a file truly needs one, name it in ALLOWED " +
        "with the reason.",
    ).toEqual([]);
  });

  it.each(Object.keys(ALLOWED))("the allow-listed %s still needs its exemption", (rel) => {
    const file = files.find((f) => f.rel === rel);
    expect(file, `${rel} no longer exists; drop it from ALLOWED`).toBeDefined();
    expect(
      adHocFormatters(rel, file!.source),
      `${rel} has no ad-hoc formatter left; drop it from ALLOWED`,
    ).not.toEqual([]);
  });
});

describe("negative control: the pre-F-37 shapes are caught", () => {
  it("flags each ad-hoc formatter and ignores comments and strings", () => {
    const source = `
      "use client";
      // new Intl.DateTimeFormat(locale) in a comment is not code
      import { useFormatter, useTranslations } from "next-intl";
      import { getFormatter as gf } from "next-intl/server";
      const label = "Intl.NumberFormat and .toLocaleString() in a string";
      export function Cell({ iso, n }: { iso: string; n: number }) {
        const dateFormatter = new Intl.DateTimeFormat("en", { dateStyle: "medium" });
        const count = Intl.NumberFormat("en").format(n);
        const ago = new Intl.RelativeTimeFormat("en");
        return [dateFormatter.format(new Date(iso)), count, ago, n.toLocaleString(),
          new Date(iso).toLocaleDateString("en"), new Date(iso).toLocaleTimeString(), label];
      }
    `;
    expect(adHocFormatters("planted.tsx", source)).toEqual([
      '4: useFormatter from "next-intl"',
      '5: getFormatter from "next-intl/server"',
      "8: Intl.DateTimeFormat",
      "9: Intl.NumberFormat",
      "10: Intl.RelativeTimeFormat",
      "11: .toLocaleString()",
      "12: .toLocaleDateString()",
      "12: .toLocaleTimeString()",
    ]);
  });

  it("does not flag the app formatter or next-intl's other hooks", () => {
    const source = `
      import { useLocale, useTimeZone, useTranslations } from "next-intl";
      import { useAppFormatter } from "@/components/i18n/format-preferences";
      export function Cell({ iso }: { iso: string }) {
        const format = useAppFormatter();
        return format.dateTime(iso) + format.number(3) + Intl.getCanonicalLocales("en");
      }
    `;
    expect(adHocFormatters("clean.tsx", source)).toEqual([]);
  });
});
