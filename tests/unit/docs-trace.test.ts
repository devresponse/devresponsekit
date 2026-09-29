import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IMAGE_CONTENT_TYPES } from "@/lib/docs/safe-path.server";

/**
 * F-88: the docs and help functions read docs/ and help/ from disk at request
 * time, and got them only because a dynamic path in getDocsRoot made the
 * tracer ship the whole working tree. The roots are literal now,
 * next.config.mjs declares the content per route, and
 * scripts/check-docs-trace.mjs checks the real build's traces in CI. The
 * build cannot run here, so this pins the two halves it relies on: the
 * config names every such route and every shipped file, and the check
 * catches both failure modes on a fixture `.next`.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");

interface DocRoute {
  entry: string;
  space: "docs" | "help";
  content: "text" | "images";
}
interface TraceScript {
  DOC_ROUTES: DocRoute[];
  checkDocsTrace: (root: string) => string[];
}
interface NextConfigModule {
  DOC_IMAGE_EXTENSIONS: string[];
  default: {
    outputFileTracingIncludes: Record<string, string[]>;
    outputFileTracingExcludes: Record<string, string[]>;
  };
}

/** The route-glob matcher `next build` applies the tracing keys with. */
const picomatch = createRequire(import.meta.url)("next/dist/compiled/picomatch") as (
  glob: string,
  options: { dot: boolean; contains: boolean },
) => (input: string) => boolean;

// Plain .mjs modules (the repo does not type-check JS): loaded by URL.
const load = <T>(file: string) =>
  import(/* @vite-ignore */ pathToFileURL(path.join(REPO_ROOT, file)).href) as Promise<T>;

let script: TraceScript;
let config: NextConfigModule;
beforeAll(async () => {
  script = await load<TraceScript>("scripts/check-docs-trace.mjs");
  config = await load<NextConfigModule>("next.config.mjs");
});

const toPosix = (p: string) => p.split(path.sep).join("/");

/** The route names a bundler may match a route glob against. */
function routeNames(entry: string): string[] {
  const withSlash = `/${entry.replace(/^app\//, "")}`; // /[locale]/(secure)/app/docs/page
  const normalized = withSlash.replace(/\/\([^)]+\)/g, "").replace(/\/(page|route)$/, "");
  return [withSlash, normalized || "/"];
}

describe("next.config.mjs tracing (F-88)", () => {
  it("declares the asset route's image allow-list, no more and no less", () => {
    expect([...config.DOC_IMAGE_EXTENSIONS].sort()).toEqual(
      Object.keys(IMAGE_CONTENT_TYPES)
        .map((ext) => ext.slice(1))
        .sort(),
    );
  });

  it("names exactly the page and route files that read a content space", () => {
    // Every src/app file that imports the docs library is one of the routes.
    const readers = globSync("src/app/**/{page,route}.{ts,tsx}", { cwd: REPO_ROOT })
      .map(toPosix)
      .filter((file) => readFileSync(path.join(REPO_ROOT, file), "utf8").includes("@/lib/docs/"))
      .map((file) => file.replace(/^src\//, "").replace(/\.tsx?$/, ""))
      .sort();
    expect(script.DOC_ROUTES.map((route) => route.entry).sort()).toEqual(readers);
  });

  it("gives each route its own space's content, whichever name the bundler matches", () => {
    const includes = config.default.outputFileTracingIncludes;
    for (const { entry, space, content } of script.DOC_ROUTES) {
      for (const name of routeNames(entry)) {
        for (const contains of [false, true]) {
          const globs = Object.entries(includes)
            .filter(([key]) => picomatch(key, { dot: true, contains })(name))
            .flatMap(([, value]) => value);
          expect(globs.length, `${name} (contains: ${contains})`).toBeGreaterThan(0);
          const files = globSync(globs, { cwd: REPO_ROOT }).map(toPosix);
          expect(
            files.every((file) => file.startsWith(`${space}/`)),
            name,
          ).toBe(true);
          const wanted = content === "text" ? /\.mdx?$/ : /\.(?:png|jpe?g|gif|webp|avif|svg)$/;
          expect(
            files.every((file) => wanted.test(file)),
            name,
          ).toBe(true);
        }
      }
    }
  });

  it("covers every shipped document and image", () => {
    const included = new Set(
      globSync(Object.values(config.default.outputFileTracingIncludes).flat(), {
        cwd: REPO_ROOT,
      }).map(toPosix),
    );
    const shipped = globSync(["docs/**/*.{md,mdx}", "help/**/*.{md,mdx,png}"], {
      cwd: REPO_ROOT,
    }).map(toPosix);
    expect(shipped.length).toBeGreaterThan(90);
    expect(shipped.filter((file) => !included.has(file))).toEqual([]);
    expect(included.has("docs/uat/README.md")).toBe(true);
    expect(included.has("help/screenshots/01-landing.png")).toBe(true);
  });

  it("keeps local artifacts out of the same routes", () => {
    const excludes = config.default.outputFileTracingExcludes;
    for (const key of Object.keys(config.default.outputFileTracingIncludes)) {
      expect(excludes[key]).toEqual(expect.arrayContaining([".vercel/**", "coverage/**"]));
    }
  });

  it("drops what Turbopack over-traces but no function reads at runtime", () => {
    // Turbopack approximates the docs code's dynamic fs calls by tracing the
    // src/lib/docs tree; the CI trace check (scripts/check-docs-trace.mjs)
    // rejects src/, tests/, scripts/ and vercel-cli/ in these functions.
    const excludes = config.default.outputFileTracingExcludes;
    for (const key of Object.keys(config.default.outputFileTracingIncludes)) {
      expect(excludes[key]).toEqual(
        expect.arrayContaining(["src/**", "tests/**", "scripts/**", "vercel-cli/**"]),
      );
    }
  });
});

describe("getDocsRoot's default roots (F-88)", () => {
  // A tripwire, not proof: the CI trace check is the proof. It fails early
  // (and locally) on the pattern that made the tracer take the whole tree.
  it("joins process.cwd() only with a literal directory name", () => {
    // Code only: line comments and doc blocks may quote the old pattern.
    const source = readFileSync(
      path.join(REPO_ROOT, "src/lib/docs/safe-path.server.ts"),
      "utf8",
    ).replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const joins = [...source.matchAll(/path\.\w+\(\s*process\.cwd\(\)\s*,([^)]*)\)/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(joins.sort()).toEqual(['"docs"', '"help"']);
    // `turbopackIgnore` applies to import()/require(), never to an fs call, so
    // it must not be relied on here: next.config.mjs excludes what the trace
    // over-includes instead.
    expect(source).not.toContain("turbopackIgnore");
    expect(source).toMatch(/fs\.realpath\(\s*path\.resolve\(configured\)\s*\)/);
  });
});

describe("scripts/check-docs-trace.mjs (F-88)", () => {
  let root = "";
  const put = (file: string, body = "") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), body);
  };
  /** Writes each route's trace: its space's content plus whatever `extra` adds. */
  const trace = (extra: (route: DocRoute) => string[] = () => []) => {
    for (const route of script.DOC_ROUTES) {
      const nft = path.join(root, ".next", "server", `${route.entry}.js.nft.json`);
      const content =
        route.content === "text"
          ? [`${route.space}/a.md`, `${route.space}/nested/b.mdx`]
          : route.space === "help"
            ? ["help/screenshots/x.png"]
            : [];
      const files = [...content, "node_modules/next/package.json", ...extra(route)].map((file) =>
        path.relative(path.dirname(nft), path.join(root, file)),
      );
      mkdirSync(path.dirname(nft), { recursive: true });
      writeFileSync(nft, JSON.stringify({ version: 1, files }));
    }
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "docs-trace-"));
    for (const space of ["docs", "help"]) {
      put(`${space}/a.md`, "# A");
      put(`${space}/nested/b.mdx`, "# B");
    }
    put("help/screenshots/x.png");
    put("src/lib/secret.ts");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("passes traces that carry their content and nothing else", () => {
    trace();
    expect(script.checkDocsTrace(root)).toEqual([]);
  });

  it("fails a route whose trace lost its content (the 500-in-production mode)", () => {
    trace();
    put("docs/uat/new.md", "# New");
    const problems = script.checkDocsTrace(root);
    expect(problems.filter((p) => p.includes("docs/uat/new.md"))).toHaveLength(2);
    expect(problems.join("\n")).toContain("app/[locale]/(secure)/app/docs/[...slug]/page");
  });

  it("fails a whole-tree trace and any local artifact in it", () => {
    trace((route) =>
      route.space === "help"
        ? ["src/lib/secret.ts", "coverage/lcov-report/index.html", ".vercel/.env.production.local"]
        : ["FULL-REVIEW.md", "test-results/run/trace.zip"],
    );
    const problems = script.checkDocsTrace(root);
    expect(problems).toHaveLength(script.DOC_ROUTES.length);
    expect(problems.every((p) => p.includes("from outside its content"))).toBe(true);
  });

  it("fails when a route has no trace, or a space has no documents", () => {
    expect(script.checkDocsTrace(root)).toHaveLength(script.DOC_ROUTES.length);
    trace();
    rmSync(path.join(root, "help"), { recursive: true });
    expect(script.checkDocsTrace(root).join("\n")).toContain("help/ holds no documents");
  });

  it("names only route entries whose source exists", () => {
    for (const { entry } of script.DOC_ROUTES) {
      const source = ["tsx", "ts"].map((ext) => path.join(REPO_ROOT, "src", `${entry}.${ext}`));
      expect(source.some(existsSync), entry).toBe(true);
    }
  });
});
