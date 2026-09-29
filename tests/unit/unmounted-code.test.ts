import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * I-10 / I-02: no client component or library module ships that only its
 * own test uses.
 *
 * The persisted zustand shell store and its `CompactModeToggle` /
 * `ShellVisibilityToggle` were exported from the app-shell barrel, which
 * nothing imported, and rendered by no layout: `(secure)/layout.tsx`
 * hard-codes `density="compact"`. Their tests passed, so a reader of the
 * store's threat notes took density and region visibility for user
 * settings. `src/lib/locale.ts` and `src/lib/invariant.ts` were likewise
 * imported by their unit tests alone. All of it is deleted. These scans fail
 * when the next such file lands:
 *
 *   - every component a `.tsx` file in `src/` exports is rendered as `<Name`
 *     (or `<Name<T>`) somewhere in `src/`;
 *   - every module in `src/` is imported by a file in `src/` or `scripts/`,
 *     or run by path from a `package.json` script or `next.config.mjs`. Tests
 *     do not count.
 *
 * Both scans skip the shadcn primitives in `components/ui/` and the files
 * Next.js loads by name (`page`, `layout`, `route` and the other segment files
 * under `src/app`, plus the root `instrumentation` and `proxy`). A private
 * `_component` beside a page is held to the same rule, so an importer that is
 * itself dead code under `src/app` fails here too.
 *
 * KEPT lists what is deliberately left unused, with the reason; an entry
 * that is no longer unused fails the last test so the list cannot rot.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = join(ROOT, "src");

const KEPT_COMPONENTS: Record<string, string> = {
  // F-35: a ready-made menu-style locale picker for adopters. It shares
  // `useSwitchLocale` with the mounted `LocaleSwitcher`, so it cannot drift.
  LanguageMenu: "menu-style locale picker kept for adopters (F-35)",
};
const KEPT_MODULES: Record<string, string> = {
  "src/components/i18n/language-menu.tsx": "home of LanguageMenu, see KEPT_COMPONENTS",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Files Next.js loads by name: the segment files under `src/app` and the root hooks. */
const NEXT_CONVENTION =
  /^src\/(?:app\/(?:.+\/)?(?:page|layout|route|loading|error|global-error|not-found|global-not-found|template|default|forbidden|unauthorized|icon|apple-icon|opengraph-image|twitter-image|sitemap|robots|manifest)|instrumentation|instrumentation-client|proxy|middleware|mdx-components)\.(?:ts|tsx|mjs)$/;

const posix = (file: string) => relative(ROOT, file).split(sep).join("/");
const isSource = (file: string) => /\.(ts|tsx|mjs)$/.test(file) && !file.endsWith(".d.ts");
const scanned = (file: string) =>
  !posix(file).startsWith("src/components/ui/") && !NEXT_CONVENTION.test(posix(file));

const srcFiles = walk(SRC).filter(isSource);
const sources = new Map(srcFiles.map((file) => [file, readFileSync(file, "utf8")]));

describe("every exported component is rendered by the app (I-10)", () => {
  const components = srcFiles
    .filter((file) => file.endsWith(".tsx") && scanned(file))
    .flatMap((file) =>
      [
        ...sources
          .get(file)!
          .matchAll(/^export (?:async )?function ([A-Z]\w*)|^export const ([A-Z]\w*)\s*=/gm),
      ].map((m) => ({ file: posix(file), name: (m[1] ?? m[2])! })),
    );
  const rendered = (name: string) => {
    const tag = new RegExp(`<${name}[\\s/><]`);
    return [...sources.values()].some((source) => tag.test(source));
  };

  it("finds the components", () => {
    const names = components.map((c) => c.name);
    expect(names).toContain("ApplicationShell");
    // A private component beside the admin pages, rendered only as `<DataGrid<Row>`.
    expect(names).toContain("DataGrid");
  });

  it("renders each one somewhere in src/", () => {
    const unmounted = components
      .filter((c) => !(c.name in KEPT_COMPONENTS) && !rendered(c.name))
      .map((c) => `${c.file}: ${c.name}`);
    expect(unmounted).toEqual([]);
  });

  it("KEPT_COMPONENTS names only components that exist and are still unmounted", () => {
    for (const name of Object.keys(KEPT_COMPONENTS)) {
      expect(
        components.map((c) => c.name),
        name,
      ).toContain(name);
      expect(rendered(name), `${name} is rendered now; drop it from KEPT_COMPONENTS`).toBe(false);
    }
  });
});

describe("every library module has a production importer (I-02, I-10)", () => {
  const importerFiles = [...srcFiles, ...walk(join(ROOT, "scripts")).filter(isSource)];

  /** Resolves an import specifier to a file on disk, or `null` for a package. */
  function resolveSpecifier(from: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  const imported = new Set<string>();
  // The db scripts package.json runs, and next-intl's request config.
  for (const config of ["package.json", "next.config.mjs"]) {
    const text = readFileSync(join(ROOT, config), "utf8");
    for (const [ref] of text.matchAll(/\bsrc\/[\w@.()[\]/-]+\.(?:ts|tsx|mjs)\b/g)) {
      imported.add(join(ROOT, ...ref.split("/")));
    }
  }
  for (const file of importerFiles) {
    const source = sources.get(file) ?? readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g,
    )) {
      const target = resolveSpecifier(file, m[1]!);
      if (target && target !== file) imported.add(target);
    }
  }

  const modules = srcFiles.filter(scanned);

  it("finds the modules", () => {
    const rels = modules.map(posix);
    expect(rels).toContain("src/lib/navigation.server.ts");
    expect(rels).toContain("src/app/[locale]/(secure)/app/administrator/audit/_audit-grid.tsx");
    expect(rels).toContain("src/db/seeds/seed-local.ts");
    expect(rels).not.toContain("src/app/[locale]/(secure)/app/administrator/audit/page.tsx");
    expect(rels).not.toContain("src/proxy.ts");
  });

  it("imports each one from src/, scripts/, package.json or next.config.mjs", () => {
    const orphans = modules
      .filter((file) => !imported.has(file) && !(posix(file) in KEPT_MODULES))
      .map(posix);
    expect(orphans).toEqual([]);
  });

  it("KEPT_MODULES names only modules that exist and are still orphaned", () => {
    for (const rel of Object.keys(KEPT_MODULES)) {
      const file = join(ROOT, ...rel.split("/"));
      expect(existsSync(file), rel).toBe(true);
      expect(imported.has(file), `${rel} is imported now; drop it from KEPT_MODULES`).toBe(false);
    }
  });
});
