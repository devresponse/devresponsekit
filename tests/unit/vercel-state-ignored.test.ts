import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * F-140: what the Vercel CLI leaves in a checkout stays out of the Docker
 * build context and out of lint.
 *
 * `drk-deploy` (and a hand-run `vercel pull`) writes `.vercel/`: the project
 * link, `vercel build` output, and `.vercel/.env.production.local`, which
 * holds production's secrets in plain text. drk-deploy deletes that file
 * after each run (F-47), and `.gitignore` ignores the folder, but
 * `.dockerignore` matched only a ROOT `.env*`, so the Dockerfile's
 * `COPY . .` put `.vercel/` in the builder stage's layer and build cache, and
 * ESLint's flat config (which does not read .gitignore) crawled
 * `.vercel/output`. The same root-anchored patterns let `vercel-cli/`'s
 * node_modules, configs and any env file beside them into the context.
 * Prettier needs nothing: it reads .gitignore itself.
 *
 * Asserted by behaviour, not by line: a later `!` line, or a pattern that
 * matches only at the root, would pass a `toContain` check.
 */

const root = process.cwd();

/** One `.dockerignore` pattern as Docker compiles it (moby/patternmatcher). */
function dockerPattern(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      // `**` spans any number of directories, none included.
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether `.dockerignore` keeps `file` (a context-relative path) out of the
 * build context: a pattern that matches a directory excludes everything in
 * it, and the last matching line wins, so a `!` line re-includes.
 */
function dockerExcludes(file: string): boolean {
  const lines = readFileSync(path.join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const segments = file.split("/");
  const selfAndParents = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  let excluded = false;
  for (const line of lines) {
    const negated = line.startsWith("!");
    const pattern = dockerPattern(line.slice(negated ? 1 : 0).replace(/^\/+|\/+$/g, ""));
    if (selfAndParents.some((candidate) => pattern.test(candidate))) excluded = !negated;
  }
  return excluded;
}

describe("Vercel CLI state stays out of the Docker build context (F-140)", () => {
  it.each([
    ".vercel/.env.production.local",
    ".vercel/project.json",
    ".vercel/output/functions/index.func/index.js",
    ".env",
    ".env.production.local",
    // direnv's file, which exports secrets too: the doc says every `.env*` file.
    ".envrc",
    // Nested: a satellite-style app folder, and a --from-env file beside the CLI.
    "apps/portal/.vercel/.env.production.local",
    "docker/.env.local",
    "apps/portal/.envrc",
    "vercel-cli/.env.production",
    "vercel-cli/.drk-deploy.json",
    "vercel-cli/.drk-deploy.app-standalone.json",
    "vercel-cli/node_modules/vercel/dist/vc.js",
  ])("excludes %s", (file) => {
    expect(dockerExcludes(file)).toBe(true);
  });

  it.each([
    ".env.example",
    "package.json",
    "pnpm-lock.yaml",
    ".npmrc",
    "next.config.mjs",
    "src/app/layout.tsx",
    "docs/deployment.md",
    "help/README.md",
    "public/favicon.ico",
  ])("keeps %s, which the build needs", (file) => {
    expect(dockerExcludes(file)).toBe(false);
  });
});

describe("ESLint does not crawl Vercel CLI state (F-140)", () => {
  const eslint = new ESLint({ cwd: root });

  it.each([
    ".vercel/output/static/_next/static/chunks/main.js",
    ".vercel/output/functions/index.func/index.mjs",
    "apps/portal/.vercel/output/config.cjs",
  ])("ignores %s", async (file) => {
    expect(await eslint.isPathIgnored(path.join(root, file))).toBe(true);
  });

  it("still lints the source", async () => {
    expect(await eslint.isPathIgnored(path.join(root, "src/proxy.ts"))).toBe(false);
  });
});
