import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mediaBlocks, normalizeQuery, stripCssComments } from "../helpers/media-query";
import { compileGlobals, globalsCompiler } from "../helpers/tailwind";

/**
 * F-119: the Tailwind classes the UI writes compile to real CSS under
 * Tailwind 4.
 *
 * The shadcn primitives kept two Tailwind 3 idioms that Tailwind 4 does not
 * understand, and neither fails a build, a type check or a jsdom test:
 *   - a bare custom property as an arbitrary value, `w-[--sidebar-width]`.
 *     v3 wrapped it in `var()`; v4 emits it verbatim (`width:
 *     --sidebar-width`), which the browser drops. The mobile sidebar drawer
 *     lost its 18rem width and shrank to its longest label, and the Radix
 *     menus lost their transform origin. v4 spells it `w-(--sidebar-width)`.
 *   - the tailwindcss-animate classes (`animate-in`, `fade-in-0`,
 *     `zoom-in-95`, ...) and the accordion / one-time-code caret animations,
 *     all of which a v3 `tailwind.config` registered. With no `@plugin` or
 *     `@theme` entry they compiled to nothing, so every overlay appeared and
 *     vanished with no transition.
 * Turning the animations on exposed two more:
 *   - the dialogs' v3 `slide-in-from-left-1/2` / `-top-[48%]` offsets
 *     restated the centring translate inside the keyframes, and v4 centres
 *     with the separate `translate` property, which adds to them instead;
 *   - `animate-in` / `animate-out` reset the slide variables and set a
 *     150ms duration, and Tailwind 4 sorts `data-[side=*]` before
 *     `data-[state=*]` (and a bare class before both). So an equally
 *     specific `data-[side=bottom]:slide-in-from-top-2` or a bare
 *     `duration-200` compiled fine and lost the cascade to
 *     `data-[state=open]:animate-in`: the menus never slid and the dialogs
 *     ran at 150ms.
 *
 * jsdom applies no stylesheet, so no component test can see any of this.
 * This suite compiles the real globals.css with the classes the source
 * actually writes (every string literal under src/, split on whitespace;
 * Tailwind ignores the tokens that are not classes) and checks the CSS.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** The text of every string and template literal in a TS/TSX source (AST, so comments are skipped). */
function stringLiterals(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      found.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const LITERALS = walk(SRC_DIR, (f) => /\.tsx?$/.test(f)).flatMap((file) =>
  stringLiterals(file, readFileSync(file, "utf8")).map((text) => ({
    file: relative(SRC_DIR, file).replace(/\\/g, "/"),
    text,
  })),
);
const TOKENS = [...new Set(LITERALS.flatMap((l) => l.text.split(/\s+/)).filter(Boolean))];

/** CSS rules with declarations (innermost blocks): selector and body. */
function rules(css: string): { selector: string; body: string }[] {
  return [...stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1]!.trim(),
    body: m[2]!,
  }));
}

/**
 * A declaration whose VALUE is a bare custom-property name (`width:
 * --sidebar-width`): invalid CSS the browser drops. The property itself must
 * not be custom (`--tw-enter-opacity: initial` is fine).
 */
const BARE_VAR_DECLARATION = /(?<![\w-])[a-z][a-z-]*\s*:\s*--[\w-]+\s*(?=;|$)/gm;

function bareVarDeclarations(css: string): string[] {
  return rules(css).flatMap(({ selector, body }) =>
    [...body.matchAll(BARE_VAR_DECLARATION)].map((m) => `${selector} { ${m[0].trim()} }`),
  );
}

/**
 * The classes that start or shape an animation: Tailwind's `animate-*` and
 * tailwindcss-animate's enter/exit modifiers, with any variant prefix.
 */
const ANIMATION_CLASS =
  /^(?:[^\s:]+:)*(?:animate-[\w-]+|(?:fade|zoom|spin)-(?:in|out)(?:-\S+)?|slide-(?:in-from|out-to)-\S+)$/;

/** Of these candidates, the ones that add no CSS at all. */
async function deadCandidates(candidates: string[]): Promise<string[]> {
  const compiler = await globalsCompiler();
  let css = compiler.build([]);
  const dead: string[] = [];
  for (const candidate of candidates) {
    const next = compiler.build([candidate]);
    if (next === css) dead.push(candidate);
    css = next;
  }
  return dead;
}

/** An element centred with a -50% translate, on either axis. */
const CENTRED = /(?:^|\s)(?:-translate-[xy]-1\/2|translate-[xy]-\[-50%\])(?=\s|$)/;
/**
 * A slide offset sized off the element itself (`1/2`, `full`, `[48%]`): the
 * v3 idiom that restated the centring translate inside the keyframes.
 */
const CENTRING_SLIDE =
  /(?:^|\s)(?:\S+:)?slide-(?:in-from|out-to)-(?:left|right|top|bottom)-(?:1\/2|full|\[[\d.]+%\])(?=\s|$)/;

function centringSlides(literals: { file: string; text: string }[]): string[] {
  return literals
    .filter((l) => CENTRED.test(l.text) && CENTRING_SLIDE.test(l.text))
    .map((l) => `${l.file}: ${CENTRING_SLIDE.exec(l.text)![0].trim()}`);
}

/** tailwindcss-animate's `animate-in` / `animate-out`, with any variant prefix. */
const ANIMATE_BASE = /^(?:[^\s:]+:)*animate-(?:in|out)$/;

/** The rule selector Tailwind writes for a class (CSS.escape, for the characters classes use). */
function escapeClass(token: string): string {
  return `.${token.replace(/[^\w-]/g, (c) => `\\${c}`)}`;
}

/**
 * Class + attribute + pseudo-class count, which is all a Tailwind utility
 * selector here carries. Throws on a functional pseudo-class (`:is()`,
 * `:where()`, ...) rather than guess its weight.
 */
function specificity(selector: string): number {
  const plain = selector.replace(/\\./g, "_").replace(/\[[^\]]*\]/g, "[]");
  if (/:(?:is|not|has|where)\(/.test(plain)) {
    throw new Error(`specificity not modelled for ${selector}`);
  }
  return (plain.match(/[.[]|(?<!:):(?!:)/g) ?? []).length;
}

const DATA_VARIANT = /^data-\[([\w-]+)(\^?=)([^\]]+)\]$/;

/** The `data-[key=value]` / `data-[key^=prefix]` conditions a class applies under. */
function dataConditions(token: string) {
  return token
    .split(":")
    .slice(0, -1)
    .flatMap((variant) => {
      const m = DATA_VARIANT.exec(variant);
      return m ? [{ key: m[1]!, prefix: m[2] === "^=", value: m[3]! }] : [];
    });
}

/** Whether two classes can apply to one element at once (not `data-[state=open]` with `=closed`). */
function coApply(a: string, b: string): boolean {
  return dataConditions(a).every((x) =>
    dataConditions(b).every(
      (y) =>
        x.key !== y.key ||
        (x.prefix && y.prefix
          ? x.value.startsWith(y.value) || y.value.startsWith(x.value)
          : x.prefix
            ? y.value.startsWith(x.value)
            : y.prefix
              ? x.value.startsWith(y.value)
              : x.value === y.value),
    ),
  );
}

/**
 * The modifiers that LOSE the cascade to an `animate-in` / `animate-out` in
 * the same class string: a class that sets a property the animate rule also
 * sets (a slide variable it resets, the duration), can apply at the same
 * time, and is less specific or equally specific but emitted earlier.
 */
function outrankedModifiers(literals: { file: string; text: string }[], css: string): string[] {
  const all = rules(css).map((rule, index) => ({ ...rule, index }));
  const rulesOf = (token: string) => {
    const selector = escapeClass(token);
    return all.filter(
      (r) => r.selector.startsWith(selector) && !/^[\w\\-]/.test(r.selector.slice(selector.length)),
    );
  };
  const properties = (body: string) =>
    new Set([...body.matchAll(/(?:^|;)\s*([\w-]+)\s*:/g)].map((m) => m[1]!));
  const offenders: string[] = [];
  for (const { file, text } of literals) {
    const tokens = text.split(/\s+/).filter(Boolean);
    for (const base of tokens.filter((t) => ANIMATE_BASE.test(t))) {
      for (const baseRule of rulesOf(base)) {
        const set = properties(baseRule.body);
        for (const token of tokens) {
          if (ANIMATE_BASE.test(token) || !coApply(base, token)) continue;
          for (const rule of rulesOf(token)) {
            const clash = [...properties(rule.body)].filter((p) => set.has(p));
            if (clash.length === 0) continue;
            const mine = specificity(rule.selector);
            const theirs = specificity(baseRule.selector);
            if (mine < theirs || (mine === theirs && rule.index < baseRule.index)) {
              offenders.push(`${file}: ${token} (${clash.join(", ")}) loses to ${base}`);
            }
          }
        }
      }
    }
  }
  return offenders;
}

/** The literals that start an enter / exit animation. */
const ANIMATED = LITERALS.filter((l) => l.text.split(/\s+/).some((t) => ANIMATE_BASE.test(t)));

describe("Tailwind 4 compiles the classes the source writes (F-119)", () => {
  it("scans the source it claims to", () => {
    // Vacuity guard: a moved tree must fail loudly, not pass on nothing.
    expect(LITERALS.length).toBeGreaterThan(1000);
    expect(TOKENS).toContain("w-(--sidebar-width)");
    expect(TOKENS).toContain("data-[state=open]:animate-in");
  });

  it("no class compiles to a bare custom-property value (`w-[--x]` must be `w-(--x)`)", async () => {
    const offenders = bareVarDeclarations(await compileGlobals(TOKENS));
    expect(
      offenders,
      "Tailwind 4 emits a bare `[--x]` arbitrary value verbatim, which is invalid CSS. " +
        "Write the v4 form `(--x)` (e.g. `w-(--sidebar-width)`), which compiles to var(--x).",
    ).toEqual([]);
  });

  it("the sidebar widths and Radix origins resolve through var()", async () => {
    const css = await compileGlobals([
      "w-(--sidebar-width)",
      "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
      "origin-(--radix-dropdown-menu-content-transform-origin)",
    ]);
    const body = (selectorStart: string) =>
      rules(css).find((r) => r.selector.startsWith(selectorStart))?.body ?? "";
    expect(body(".w-\\(--sidebar-width\\)")).toMatch(/width:\s*var\(--sidebar-width\)/);
    expect(body(".group-data-\\[collapsible\\=icon\\]\\:w-\\(--sidebar-width-icon\\)")).toMatch(
      /width:\s*var\(--sidebar-width-icon\)/,
    );
    expect(body(".origin-\\(--radix-dropdown-menu-content-transform-origin\\)")).toMatch(
      /transform-origin:\s*var\(--radix-dropdown-menu-content-transform-origin\)/,
    );
  });

  it("every animation class the source writes produces CSS", async () => {
    const animation = TOKENS.filter((t) => ANIMATION_CLASS.test(t));
    // The overlays, the accordion and the OTP caret are all in the scan.
    expect(animation.length).toBeGreaterThan(20);
    expect(animation).toEqual(
      expect.arrayContaining([
        "data-[state=closed]:animate-out",
        "data-[state=open]:zoom-in-95",
        "data-[side=bottom]:slide-in-from-top-2",
        "data-[state=open]:data-[side=bottom]:slide-in-from-top-2",
        "data-[state=open]:animate-accordion-down",
        "animate-caret-blink",
      ]),
    );
    expect(
      await deadCandidates(animation),
      "An animation class compiled to nothing. tailwindcss-animate is registered with " +
        "`@plugin` and the theme animations live in `@theme` in src/app/globals.css.",
    ).toEqual([]);
  });

  it("animate-in runs the `enter` keyframes and fade-in-0 feeds them", async () => {
    const css = await compileGlobals([
      "data-[state=open]:animate-in",
      "data-[state=open]:fade-in-0",
    ]);
    const body = (selectorStart: string) =>
      rules(css).find((r) => r.selector.startsWith(selectorStart))?.body ?? "";
    expect(body(".data-\\[state\\=open\\]\\:animate-in")).toMatch(/animation-name:\s*enter/);
    expect(body(".data-\\[state\\=open\\]\\:fade-in-0")).toMatch(/--tw-enter-opacity:\s*0/);
    expect(stripCssComments(css)).toMatch(/@keyframes enter\s*\{/);
  });

  it("every enter/exit modifier outranks the animate-in / animate-out beside it", async () => {
    // Vacuity guard: the menus, popovers, dialogs and tooltip are all here.
    expect(ANIMATED.map((l) => l.file)).toEqual(
      expect.arrayContaining([
        "components/ui/popover.tsx",
        "components/ui/dropdown-menu.tsx",
        "components/ui/menubar.tsx",
        "components/ui/dialog.tsx",
        "components/ui/tooltip.tsx",
      ]),
    );
    expect(
      outrankedModifiers(ANIMATED, await compileGlobals(TOKENS)),
      "animate-in / animate-out reset the slide variables and set a 150ms duration. A modifier " +
        "beside a variant-prefixed animate-in must carry that variant too (e.g. " +
        "`data-[state=open]:data-[side=bottom]:slide-in-from-top-2`, " +
        "`data-[state=open]:duration-200`), or it compiles and does nothing.",
    ).toEqual([]);
  });

  it("an OS reduced-motion setting switches the overlay and accordion animations off", async () => {
    const css = stripCssComments(await compileGlobals(["data-[state=open]:animate-in"]));
    const guard = mediaBlocks(css).filter(
      (b) =>
        b.query === normalizeQuery("(prefers-reduced-motion: reduce)") &&
        b.body.includes('[class*="animate-in"]'),
    );
    expect(guard).toHaveLength(1);
    for (const selector of [
      '[class*="animate-in"]',
      '[class*="animate-out"]',
      '[class*="animate-accordion-"]',
    ]) {
      expect(guard[0]!.body).toContain(selector);
    }
    // `none`, not a zero duration: Radix Presence unmounts a closing overlay
    // at once when animation-name is none, instead of awaiting animationend.
    expect(guard[0]!.body).toMatch(/animation:\s*none/);
    // Unlayered, so it beats `@layer utilities` whatever a variant's
    // specificity: the rule sits one brace deep, inside its @media and no
    // @layer.
    const before = css.slice(0, css.indexOf('[class*="animate-in"]'));
    expect(before.split("{").length - before.split("}").length).toBe(1);
  });

  it("no centred element carries a v3 centring slide offset", () => {
    const centred = LITERALS.filter((l) => CENTRED.test(l.text));
    // Dialog and AlertDialog content, at least.
    expect(centred.map((l) => l.file)).toEqual(
      expect.arrayContaining(["components/ui/dialog.tsx", "components/ui/alert-dialog.tsx"]),
    );
    expect(
      centringSlides(LITERALS),
      "Under Tailwind 4 a -50% translate is the `translate` property, which ADDS to the " +
        "keyframes' transform: a `slide-*-1/2` / `-[48%]` offset makes the element fly in " +
        "from off-centre. Animate a centred element with fade/zoom only.",
    ).toEqual([]);
  });
});

describe("negative control: the pre-F-119 shapes are caught", () => {
  it("a bare [--x] value is flagged; an arbitrary property is not", async () => {
    const css = await compileGlobals([
      "w-[--sidebar-width]",
      "origin-[--radix-popover-content-transform-origin]",
      "[--cell-size:2rem]",
    ]);
    expect(bareVarDeclarations(css)).toEqual([
      ".w-\\[--sidebar-width\\] { width: --sidebar-width }",
      ".origin-\\[--radix-popover-content-transform-origin\\] { transform-origin: --radix-popover-content-transform-origin }",
    ]);
  });

  it("an animation class nothing defines is dead; a defined one is not", async () => {
    expect(await deadCandidates(["animate-wobble", "fade-in-0"])).toEqual(["animate-wobble"]);
  });

  it("a modifier the animate rule overrides is flagged; a winning or exclusive one is not", async () => {
    const planted = [
      {
        // The pre-fix popover: the side slide loses, the stacked one and the zoom win.
        file: "old-popover.tsx",
        text: "data-[state=open]:animate-in data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[state=open]:data-[side=top]:slide-in-from-bottom-2",
      },
      {
        // The pre-fix dialog: a bare duration loses to both animate rules.
        file: "old-dialog.tsx",
        text: "data-[state=open]:animate-in data-[state=closed]:animate-out duration-200",
      },
      {
        // The tooltip: a bare animate-in is less specific than a side slide.
        file: "tooltip.tsx",
        text: "animate-in fade-in-0 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2",
      },
      {
        // Sorted before animate-in, but never on the same element as it.
        file: "exclusive.tsx",
        text: "data-[state=open]:animate-in data-[state=closed]:duration-300",
      },
    ];
    const tokens = planted.flatMap((l) => l.text.split(" "));
    expect(outrankedModifiers(planted, await compileGlobals(tokens))).toEqual([
      "old-popover.tsx: data-[side=bottom]:slide-in-from-top-2 (--tw-enter-translate-y) loses to data-[state=open]:animate-in",
      "old-dialog.tsx: duration-200 (animation-duration) loses to data-[state=open]:animate-in",
      "old-dialog.tsx: duration-200 (animation-duration) loses to data-[state=closed]:animate-out",
    ]);
  });

  it("the old dialog classes are flagged; a popover's slide and a plain centred box are not", () => {
    const planted = [
      {
        file: "old-dialog.tsx",
        text: "data-[state=open]:animate-in data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] translate-x-[-50%] translate-y-[-50%]",
      },
      {
        file: "popover.tsx",
        text: "data-[state=open]:animate-in data-[side=bottom]:slide-in-from-top-2",
      },
      { file: "centred.tsx", text: "fixed top-1/2 -translate-y-1/2 zoom-in-95" },
    ];
    expect(centringSlides(planted)).toEqual([
      "old-dialog.tsx: data-[state=open]:slide-in-from-left-1/2",
    ]);
  });
});
