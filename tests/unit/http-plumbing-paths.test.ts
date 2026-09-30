import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * I-13: the shared HTTP plumbing (the route wrappers, request id, error
 * envelopes, origin guard and rate limiters) moved to `src/lib/http/` with no
 * re-export shim at the old paths (docs/architecture.md §8.1). A shim leaves two
 * specifiers for one module, and a `vi.mock` of one does not mock imports of
 * the other.
 *
 * Without a shim, a stale static import fails `tsc`, but a stale string does
 * not: a `vi.mock` of a path nothing imports mocks nothing, and the test then
 * runs against the real module and may still pass. A branch that was open
 * during the move brings exactly those strings back, so this fails on any old
 * path left in code, tests, scripts or CI config.
 */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

/** Each moved module: its old `lib/…` path and its new one, without `.ts`. */
const MOVED: ReadonlyArray<readonly [from: string, to: string]> = [
  ["lib/admin/errors.server", "lib/http/errors.server"],
  ["lib/admin/request-id.server", "lib/http/request-id.server"],
  ["lib/admin/origin-guard.server", "lib/http/origin-guard.server"],
  ["lib/admin/rate-limit.server", "lib/http/rate-limit.server"],
  ["lib/admin/rate-limit-shared.server", "lib/http/rate-limit-shared.server"],
  ["lib/admin/rate-limit-tiered.server", "lib/http/rate-limit-tiered.server"],
  ["lib/api-auth/problem", "lib/http/problem"],
  ["lib/route-handler.server", "lib/http/route-handler.server"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Not followed by a name character, so `rate-limit.server` does not also match
// the start of `rate-limit-shared.server`.
const OLD_PATH = new RegExp(`(?:${MOVED.map(([from]) => escape(from)).join("|")})(?![\\w-])`, "g");

const SCANNED_DIRS = ["src", "tests", "scripts", ".github"];
const SCANNED_FILE = /\.(?:ts|tsx|mts|mjs|cjs|js|sql|ya?ml)$/;
const ROOT_CONFIG = /^(?:vitest|vitest\.db|stryker|playwright|next|eslint)\.config\.(?:ts|mjs)$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCANNED_FILE.test(entry)) out.push(full);
  }
  return out;
}

function oldPathsIn(text: string): string[] {
  return [...text.matchAll(OLD_PATH)].map((m) => m[0]);
}

describe("I-13: the HTTP plumbing lives in src/lib/http, and only there", () => {
  it("has each moved module at its new path and none at its old one", () => {
    for (const [from, to] of MOVED) {
      expect(existsSync(join(ROOT, "src", `${to}.ts`)), `src/${to}.ts`).toBe(true);
      expect(existsSync(join(ROOT, "src", `${from}.ts`)), `src/${from}.ts`).toBe(false);
    }
  });

  it("names no old path in code, tests, scripts or CI config", () => {
    const files = [
      ...SCANNED_DIRS.flatMap((dir) => walk(join(ROOT, dir))),
      ...readdirSync(ROOT)
        .filter((entry) => ROOT_CONFIG.test(entry))
        .map((entry) => join(ROOT, entry)),
    ].filter((full) => full !== SELF);
    expect(files.length).toBeGreaterThan(1000);

    const offenders = files.flatMap((full) =>
      oldPathsIn(readFileSync(full, "utf8")).map(
        (hit) => `${relative(ROOT, full).replace(/\\/g, "/")}: ${hit}`,
      ),
    );
    expect(
      offenders,
      "a module moved to src/lib/http (I-13) is named by its old path. Rewrite it to the " +
        "new one: a vi.mock of the old path mocks nothing (docs/architecture.md §8.1)",
    ).toEqual([]);
  });

  it("catches an old specifier in every form, and not the new paths", () => {
    const planted = [
      'vi.mock("@/lib/admin/rate-limit.server", () => ({}));',
      'await import("@/lib/admin/rate-limit-shared.server");',
      'import { problemResponse } from "@/lib/api-auth/problem";',
      "// see src/lib/route-handler.server.ts",
    ].join("\n");
    expect(oldPathsIn(planted)).toEqual([
      "lib/admin/rate-limit.server",
      "lib/admin/rate-limit-shared.server",
      "lib/api-auth/problem",
      "lib/route-handler.server",
    ]);
    expect(oldPathsIn(MOVED.map(([, to]) => `"@/${to}"`).join("\n"))).toEqual([]);
  });
});
