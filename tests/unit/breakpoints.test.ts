import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type Config } from "tailwindcss";
import ts from "typescript";
import { DESKTOP_MEDIA_QUERY, MD_BREAKPOINT, MOBILE_MEDIA_QUERY } from "@/lib/breakpoints";
import {
  isWidthQuery,
  matchesWidthQuery,
  mediaBlocks,
  readShellBreakpoints,
  type Viewport,
} from "../helpers/media-query";

/**
 * F-36: ONE mobile/desktop breakpoint, everywhere.
 *
 * `useIsMobile` said "mobile" below 767px, app-shell.css hid the rail up to
 * and including 768px, and Tailwind's `md:` (which shows the rail) starts at
 * 48rem. At exactly 768px the rail was hidden and the trigger still toggled
 * the desktop rail, so primary navigation was unreachable; fractional widths
 * between 767 and 768 failed the same way, and a larger default font moved
 * `md` and left a whole band of widths with no navigation.
 *
 * `src/lib/breakpoints.ts` now holds the two queries. This file pins that
 * every other place on this axis says the same thing:
 *   1. the two queries split the axis with no gap and no overlap, at every
 *      width and every default font size;
 *   2. Tailwind, compiled from the project's real `globals.css`, turns `md:`
 *      and `max-md:` into exactly these strings, and the compiled stylesheet
 *      holds no other width query;
 *   3. every stylesheet under `src/` writes only these two, and app-shell.css
 *      hides the side columns with the mobile one;
 *   4. no TS/TSX source spells a width query of its own (a `matchMedia`
 *      literal, an arbitrary `min-[…]:` / `max-[…]:` breakpoint): only
 *      breakpoints.ts may;
 *   5. a negative control plants the old shapes and proves the scans and the
 *      evaluator catch them.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const BREAKPOINTS_FILE = join(SRC_DIR, "lib", "breakpoints.ts");
const GLOBALS_CSS = join(SRC_DIR, "app", "globals.css");
const require = createRequire(import.meta.url);

const BREAKPOINT_QUERIES = new Set([MOBILE_MEDIA_QUERY, DESKTOP_MEDIA_QUERY]);

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** Width queries in a stylesheet that are not one of the two shared ones. */
function strayWidthQueries(css: string): string[] {
  return mediaBlocks(css)
    .map((b) => b.query)
    .filter((q) => isWidthQuery(q) && !BREAKPOINT_QUERIES.has(q));
}

/** A width media feature, as it would appear inside a JS string. */
const WIDTH_FEATURE = /\(\s*(?:(?:min|max)-)?(?:device-)?width\s*(?::|<|>|=)/;
/** A Tailwind arbitrary viewport variant (`min-[769px]:`), i.e. a private breakpoint. */
const ARBITRARY_BREAKPOINT = /(?:^|[\s"'`])(?:min|max)-\[[^\]]*\]:/;

/**
 * A responsive-image `sizes` hint (`<Image sizes="(max-width: 768px) 100vw">`,
 * `getImageProps({ sizes })`). It only tells the browser which resolution to
 * download, never shows or hides anything, and usually names several widths
 * that are not shell breakpoints, so it is not a breakpoint that can drift.
 * `media` stays scanned: on a `<link>` or `<style>` it switches layout.
 */
function isSizesHint(node: ts.Node): boolean {
  if (ts.isJsxAttribute(node)) return ts.isIdentifier(node.name) && node.name.text === "sizes";
  if (ts.isPropertyAssignment(node)) {
    return (
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "sizes"
    );
  }
  return false;
}

/**
 * String and template literals in a TS/TSX source that carry a width query
 * or an arbitrary breakpoint. Walks the AST, so a comment that quotes the old
 * query is not a query. The value of a `sizes` hint is skipped (see
 * {@link isSizesHint}).
 */
function widthQueryLiterals(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const check = (text: string) => {
    if (WIDTH_FEATURE.test(text) || ARBITRARY_BREAKPOINT.test(text)) found.push(text);
  };
  const visit = (node: ts.Node) => {
    if (isSizesHint(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node.text);
    } else if (ts.isTemplateExpression(node)) {
      check([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("${}"));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Compiles the project's real globals.css with Tailwind, as the build does. */
async function compileGlobals(candidates: string[]): Promise<string> {
  const compiler = await compile(readFileSync(GLOBALS_CSS, "utf8"), {
    base: dirname(GLOBALS_CSS),
    from: GLOBALS_CSS,
    loadStylesheet: async (id, base) => {
      const file = id.startsWith(".")
        ? resolve(base, id)
        : require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id);
      return { path: file, base: dirname(file), content: readFileSync(file, "utf8") };
    },
    loadModule: async (id, base) => {
      const file = require.resolve(id, { paths: [base] });
      const mod = (await import(id)) as { default?: unknown };
      // The only module globals.css loads is the typography plugin.
      return { path: file, base: dirname(file), module: (mod.default ?? mod) as Config };
    },
  });
  return compiler.build(candidates);
}

describe("the shared breakpoint (F-36)", () => {
  it("is Tailwind's md, in range syntax", () => {
    expect(MD_BREAKPOINT).toBe("48rem");
    expect(MOBILE_MEDIA_QUERY).toBe("(width < 48rem)");
    expect(DESKTOP_MEDIA_QUERY).toBe("(width >= 48rem)");
  });

  it("splits the width axis with no gap and no overlap, at any default font size", () => {
    for (const defaultFontSize of [16, 20, 12]) {
      const boundary = 48 * defaultFontSize;
      const widths = [boundary - 1, boundary - 0.5, boundary - 0.02, boundary, boundary + 0.5];
      for (let w = 280; w <= 1400; w += 0.25) widths.push(w);
      for (const width of widths) {
        const viewport: Viewport = { width, defaultFontSize };
        const mobile = matchesWidthQuery(MOBILE_MEDIA_QUERY, viewport);
        const desktop = matchesWidthQuery(DESKTOP_MEDIA_QUERY, viewport);
        expect(mobile !== desktop, `${width}px at a ${defaultFontSize}px default font`).toBe(true);
        expect(mobile, `${width}px at a ${defaultFontSize}px default font`).toBe(width < boundary);
      }
    }
  });

  it("puts 767.5px on the mobile side and 768px on the desktop side", () => {
    expect(matchesWidthQuery(MOBILE_MEDIA_QUERY, { width: 767.5 })).toBe(true);
    expect(matchesWidthQuery(DESKTOP_MEDIA_QUERY, { width: 767.5 })).toBe(false);
    expect(matchesWidthQuery(MOBILE_MEDIA_QUERY, { width: 768 })).toBe(false);
    expect(matchesWidthQuery(DESKTOP_MEDIA_QUERY, { width: 768 })).toBe(true);
  });
});

describe("app-shell.css uses the shared breakpoint", () => {
  it("hides the side columns with the mobile query and pins the icon rail with the desktop one", () => {
    const { hidesSidebars, desktopRail } = readShellBreakpoints();
    expect(hidesSidebars).toBe(MOBILE_MEDIA_QUERY);
    expect(desktopRail).toBe(DESKTOP_MEDIA_QUERY);
  });

  it("agrees with useIsMobile at the boundary: 767.5px is mobile in both, 768px desktop in both", () => {
    const { hidesSidebars } = readShellBreakpoints();
    for (const defaultFontSize of [16, 20]) {
      for (const width of [767, 767.5, 767.98, 768, 769, 800, 959.5, 960]) {
        const viewport = { width, defaultFontSize };
        expect(
          matchesWidthQuery(hidesSidebars, viewport),
          `CSS vs JS at ${width}px, ${defaultFontSize}px default font`,
        ).toBe(matchesWidthQuery(MOBILE_MEDIA_QUERY, viewport));
      }
    }
  });

  it("every stylesheet under src/ writes only the two shared width queries", () => {
    const stray = walk(SRC_DIR, (f) => f.endsWith(".css")).flatMap((file) =>
      strayWidthQueries(readFileSync(file, "utf8")).map(
        (q) => `${relative(SRC_DIR, file)}: @media ${q}`,
      ),
    );
    expect(stray).toEqual([]);
  });
});

describe("Tailwind's md is the shared breakpoint", () => {
  it("compiles md: / max-md: to exactly the shared queries, and the stylesheet holds no other", async () => {
    const css = await compileGlobals(["md:block", "max-md:hidden"]);
    const blocks = mediaBlocks(css);
    const around = (selector: string) =>
      blocks.filter((b) => b.body.includes(selector)).map((b) => b.query);

    expect(around(".md\\:block")).toEqual([DESKTOP_MEDIA_QUERY]);
    expect(around(".max-md\\:hidden")).toEqual([MOBILE_MEDIA_QUERY]);
    // The compiled output also carries app-shell.css and compact-mode.css
    // (globals.css imports them), so this covers what actually ships.
    expect(strayWidthQueries(css)).toEqual([]);
    expect(blocks.some((b) => b.query === MOBILE_MEDIA_QUERY && b.body.includes(".sh-left"))).toBe(
      true,
    );
  });
});

describe("no source file writes its own breakpoint", () => {
  it("only src/lib/breakpoints.ts spells a width media query", () => {
    const offenders = walk(SRC_DIR, (f) => /\.tsx?$/.test(f) && f !== BREAKPOINTS_FILE).flatMap(
      (file) =>
        widthQueryLiterals(file, readFileSync(file, "utf8")).map(
          (text) => `${relative(SRC_DIR, file)}: ${JSON.stringify(text)}`,
        ),
    );
    expect(offenders).toEqual([]);
  });

  it("breakpoints.ts itself is what the scan would otherwise catch", () => {
    // Guards the exemption: if the constants moved, the scan above would
    // silently have nothing left to exempt.
    expect(
      widthQueryLiterals(BREAKPOINTS_FILE, readFileSync(BREAKPOINTS_FILE, "utf8")),
    ).not.toEqual([]);
  });
});

describe("negative control: the pre-F-36 shapes are caught", () => {
  const OLD_JS = "(max-width: 767px)";
  const OLD_CSS_MOBILE = "(max-width: 768px)";

  it("the old JS and CSS queries disagreed at 768px and at 767.5px", () => {
    for (const width of [768, 767.5]) {
      expect(matchesWidthQuery(OLD_CSS_MOBILE, { width })).toBe(true); // rail hidden
      expect(matchesWidthQuery(OLD_JS, { width })).toBe(false); // no drawer
    }
    // ...and a 20px default font moved md to 960px while both pixel queries
    // stayed put: at 800px the rail was hidden by `hidden md:block` and the
    // hook still said desktop.
    const large = { width: 800, defaultFontSize: 20 };
    expect(matchesWidthQuery(DESKTOP_MEDIA_QUERY, large)).toBe(false);
    expect(matchesWidthQuery(OLD_JS, large)).toBe(false);
  });

  it("the stylesheet scan flags a pixel breakpoint and ignores one in a comment", () => {
    const css = `/* was @media (max-width: 768px) */
@media (min-width: 769px) { .a { color: red } }
@media ${MOBILE_MEDIA_QUERY} { .sh-left { display: none } }
@media (prefers-color-scheme: dark) { .b { color: blue } }`;
    expect(strayWidthQueries(css)).toEqual(["(min-width: 769px)"]);
  });

  it("the source scan flags a matchMedia literal, a template and an arbitrary variant", () => {
    const source = `
      // (max-width: 767px) in a comment is not a query
      const a = window.matchMedia("${OLD_JS}");
      const b = window.matchMedia(\`(max-width: \${768 - 1}px)\`);
      const c = <div className="hidden min-[769px]:block" />;
      const d = window.matchMedia("(prefers-color-scheme: dark)");
      const e = <div className="max-w-[20rem] md:block" />;
    `;
    expect(widthQueryLiterals("planted.tsx", source)).toEqual([
      OLD_JS,
      "(max-width: ${}px)",
      "hidden min-[769px]:block",
    ]);
  });

  it("the source scan skips a responsive-image sizes hint but still flags a media attribute", () => {
    const source = `
      const f = <Image src="/a.png" alt="" sizes="(max-width: 768px) 100vw, 50vw" />;
      const g = <img alt="" sizes={\`(max-width: \${767}px) 100vw\`} />;
      const h = getImageProps({ src: "/a.png", alt: "", sizes: "(min-width: 1200px) 33vw" });
      const i = <link rel="stylesheet" media="${OLD_JS}" href="/m.css" />;
    `;
    expect(widthQueryLiterals("planted.tsx", source)).toEqual([OLD_JS]);
  });

  it("the evaluator refuses a query shape it does not know", () => {
    expect(() => matchesWidthQuery("not all and (min-width: 48rem)", { width: 800 })).toThrow(
      /cannot evaluate/,
    );
  });
});
