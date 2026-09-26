import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { compile, type Config } from "tailwindcss";

/**
 * Compiles the project's real `src/app/globals.css` with Tailwind, as the
 * build does: its `@import`s (tailwindcss, app-shell.css, compact-mode.css)
 * and its `@plugin`s (typography, tailwindcss-animate) all load. Shared by
 * the breakpoint test (F-36) and the class-compilation guard (F-119).
 *
 * Node-environment tests only: `import.meta.dirname` is a file path there.
 */
export const GLOBALS_CSS = join(import.meta.dirname, "../../src/app/globals.css");
const require = createRequire(import.meta.url);

type Compiler = Awaited<ReturnType<typeof compile>>;

export async function globalsCompiler(): Promise<Compiler> {
  return compile(readFileSync(GLOBALS_CSS, "utf8"), {
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
      return { path: file, base: dirname(file), module: (mod.default ?? mod) as Config };
    },
  });
}

/** The stylesheet globals.css compiles to for these class candidates. */
export async function compileGlobals(candidates: string[]): Promise<string> {
  return (await globalsCompiler()).build(candidates);
}
