import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * How the production build reaches the schema gate (DEP1), pinned because
 * nothing else runs it: no test builds on Vercel.
 *
 * - `vercel.json` names the build command. A configured `buildCommand` wins
 *   over the dashboard's Build Command and over any package script
 *   (@vercel/next 15.0.2), so the gate cannot be switched off from the
 *   project's settings, and `vercel build` (drk-deploy) reads the same field.
 * - `vercel-build` runs the gate AFTER `next build`, which needs no database,
 *   so a migration running at the same time overlaps the build.
 * - `build` stays `next build`: CI's Build job and the Docker image build
 *   without the gate (neither has a production database to check).
 */
const root = process.cwd();
const vercelJson = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
  buildCommand?: unknown;
};
const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("the production build runs the schema gate (DEP1)", () => {
  it("vercel.json makes `pnpm run vercel-build` the build", () => {
    expect(vercelJson.buildCommand).toBe("pnpm run vercel-build");
  });

  it("vercel-build runs the gate after next build, and deploy:gate runs it alone", () => {
    expect(scripts["vercel-build"]).toBe("next build && tsx scripts/deploy-gate.ts");
    expect(scripts["deploy:gate"]).toBe("tsx scripts/deploy-gate.ts");
  });

  it("leaves `build` as plain next build for CI and the Docker image", () => {
    expect(scripts.build).toBe("next build");
    expect(readFileSync(path.join(root, "Dockerfile"), "utf8")).toMatch(/&& pnpm build\s*$/m);
  });
});
