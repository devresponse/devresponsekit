import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Width media-query helpers for the breakpoint tests (F-36).
 *
 * jsdom implements no `matchMedia` and never evaluates `@media`, so the tests
 * that prove the shell CSS, `useIsMobile` and Tailwind's `md` agree evaluate
 * the queries themselves. The evaluator is deliberately tiny: one width
 * feature per query, in range form (`(width < 48rem)`) or the legacy form
 * (`(max-width: 768px)`). Anything else THROWS instead of reading as "no
 * match", so a query written in a new shape fails loudly until the evaluator
 * learns it, rather than letting a test pass on a silent `false`.
 */

export interface Viewport {
  /** Viewport width in CSS px. Fractions are real (zoom, split screen). */
  width: number;
  /**
   * The browser's DEFAULT font size in px. `rem` / `em` in a media query
   * resolve against it (the initial `font-size`, never the page's own root
   * rule), so a user who picks a larger default moves every rem breakpoint.
   */
  defaultFontSize?: number;
}

const RANGE = /^\(\s*width\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)$/;
const LEGACY = /^\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)\s*\)$/;

/** Collapses whitespace so `@media (width  <  48rem)` compares as written. */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

/** `true` when the query mentions a width feature (width, min-/max-width, device-width). */
export function isWidthQuery(query: string): boolean {
  return /\b(?:(?:min|max)-)?(?:device-)?width\b/.test(query);
}

export function matchesWidthQuery(query: string, viewport: Viewport): boolean {
  const remPx = viewport.defaultFontSize ?? 16;
  const toPx = (value: string, unit: string) =>
    unit === "px" ? Number(value) : Number(value) * remPx;
  const q = normalizeQuery(query);

  const range = RANGE.exec(q);
  if (range) {
    const limit = toPx(range[2]!, range[3]!);
    switch (range[1]) {
      case "<":
        return viewport.width < limit;
      case "<=":
        return viewport.width <= limit;
      case ">":
        return viewport.width > limit;
      default:
        return viewport.width >= limit;
    }
  }
  const legacy = LEGACY.exec(q);
  if (legacy) {
    const limit = toPx(legacy[2]!, legacy[3]!);
    return legacy[1] === "min" ? viewport.width >= limit : viewport.width <= limit;
  }
  throw new Error(`matchesWidthQuery cannot evaluate ${JSON.stringify(query)}`);
}

/**
 * Replaces `window.matchMedia` with one that answers width queries for the
 * given viewport (and `false` for any other feature, e.g. a colour scheme).
 * Returns the restore function.
 */
export function installMatchMedia(viewport: Viewport): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: isWidthQuery(query) ? matchesWidthQuery(query, viewport) : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

export interface MediaBlock {
  /** The prelude, whitespace-normalized: `(width < 48rem)`. */
  query: string;
  /** Everything between the block's braces. */
  body: string;
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `@media` block in a stylesheet, comments ignored, braces balanced. */
export function mediaBlocks(css: string): MediaBlock[] {
  const source = stripCssComments(css);
  const blocks: MediaBlock[] = [];
  const at = /@media\b([^{]*)\{/g;
  let match: RegExpExecArray | null;
  while ((match = at.exec(source))) {
    let depth = 1;
    let i = at.lastIndex;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
    }
    blocks.push({ query: normalizeQuery(match[1]!), body: source.slice(at.lastIndex, i - 1) });
  }
  return blocks;
}

// `import.meta.dirname`, not `new URL(…, import.meta.url)`: in the jsdom
// environment Vite rewrites that pattern into a served asset URL
// (http://localhost:3000/src/…), which is not a file path.
export const APP_SHELL_CSS_PATH = join(import.meta.dirname, "../../src/styles/app-shell.css");

/**
 * The shell's own breakpoint queries, read from app-shell.css: the block that
 * hides `.sh-left` (below it the rail cannot be seen, so the drawer is the
 * only way to the navigation) and the block that pins the icon-collapsed
 * column (the desktop layout).
 */
export function readShellBreakpoints(css = readFileSync(APP_SHELL_CSS_PATH, "utf8")): {
  hidesSidebars: string;
  desktopRail: string;
} {
  const blocks = mediaBlocks(css);
  const hides = blocks.filter((b) => /\.sh-left\b[^{]*\{[^}]*display:\s*none/.test(b.body));
  const desktop = blocks.filter((b) => b.body.includes('[data-collapsible="icon"]'));
  if (hides.length !== 1 || desktop.length !== 1) {
    throw new Error(
      `app-shell.css: expected one block hiding .sh-left and one icon-collapse block, found ${hides.length} and ${desktop.length}`,
    );
  }
  return { hidesSidebars: hides[0]!.query, desktopRail: desktop[0]!.query };
}
