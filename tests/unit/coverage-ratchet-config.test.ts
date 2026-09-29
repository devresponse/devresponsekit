import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../vitest.config";

/**
 * F-125: the coverage ratchet is where docs/testing.md §4 says it is, and every
 * route file under `src/app` has a floor of its own.
 *
 * The global thresholds had sat more than 20 points below the measured
 * coverage since June, so some 4,900 untested lines could land before CI
 * noticed, and the doc's table and the config's comment quoted numbers that
 * were no longer true. Only the `/api/v1` route files and five administrator
 * ones had a per-file floor (F-42), so an untested handler anywhere else under
 * `/api` passed. The thresholds are now pinned just below the measured values,
 * and `vitest.config.ts` floors every route file it finds under `src/app`: the
 * `/api` tree and the `.well-known` discovery documents beside it.
 *
 * This file keeps the two from drifting apart: a raise that skips the doc's
 * table fails here, and so does a route file without a key of its own. What
 * each floor measures is enforced by `pnpm test:coverage` itself.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ROUTES_DIR = "src/app";
/**
 * The key of the route handlers' combined floor in `vitest.config.ts`. It is
 * the `/api` tree only: to picomatch `**` does not enter a dot directory, so
 * the `.well-known` handlers have per-file floors and no share of this one.
 */
const ROUTE_TOTAL_GLOB = "src/app/api/**/route.ts";
const METRICS = ["statements", "branches", "functions", "lines"] as const;
type Metric = (typeof METRICS)[number];
type Floor = Partial<Record<Metric, number>>;

const thresholds = (config.test?.coverage as { thresholds?: Record<string, unknown> } | undefined)
  ?.thresholds as (Floor & Record<string, Floor>) | undefined;

/** The route files under `src/app`, as repo-relative paths with `/`. */
function routeFiles(): string[] {
  return readdirSync(join(REPO_ROOT, ROUTES_DIR), { recursive: true })
    .map((entry) => `${ROUTES_DIR}/${String(entry).replace(/\\/g, "/")}`)
    .filter((path) => path.endsWith("/route.ts"))
    .sort();
}

/**
 * The path a per-file key names. The config wraps each bracket in a class of
 * its own (`[id]` is written `[[]id[]]`, since to picomatch `[id]` would match
 * `i` or `d`), so unwrapping them gives the path back.
 */
function unwrapLiteralGlob(key: string): string {
  return key.replace(/\[([[\]])\]/g, "$1");
}

/** The §4 table rows: metric -> [global threshold, route-handler total]. */
function documentedThresholds(): Map<string, [number, number]> {
  const doc = readFileSync(join(REPO_ROOT, "docs/testing.md"), "utf8");
  const section = doc.slice(doc.indexOf("## 4. Coverage"), doc.indexOf("## 5. "));
  const rows = new Map<string, [number, number]>();
  for (const [, metric, global, routes] of section.matchAll(
    /^\| (Statements|Branches|Functions|Lines) \| (\d+)% \| (\d+)% \|$/gm,
  )) {
    rows.set(metric!.toLowerCase(), [Number(global), Number(routes)]);
  }
  return rows;
}

describe("the coverage ratchet (F-125)", () => {
  it("docs/testing.md §4 lists the thresholds vitest.config.ts enforces", () => {
    expect(thresholds).toBeDefined();
    const documented = documentedThresholds();
    const routeTotal = thresholds?.[ROUTE_TOTAL_GLOB];
    expect(routeTotal, `no "${ROUTE_TOTAL_GLOB}" key in vitest.config.ts`).toBeDefined();
    for (const metric of METRICS) {
      expect(documented.get(metric), `§4's ${metric} row [all of src/, routes]`).toEqual([
        thresholds?.[metric],
        routeTotal?.[metric],
      ]);
    }
  });

  it("gives every route file under src/app a floor of its own", () => {
    const files = routeFiles();
    // The walk itself works: there were 95 route files when this landed, three
    // of them under the dot directory `.well-known`.
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((path) => path.startsWith(`${ROUTES_DIR}/.well-known/`))).toBe(true);
    const floored = new Map(
      Object.entries(thresholds ?? {})
        .filter(([key]) => !key.includes("*"))
        .map(([key, floor]) => [unwrapLiteralGlob(key), floor as Floor]),
    );
    expect(files.filter((path) => !floored.has(path))).toEqual([]);
    // Every per-file floor sets all four metrics: an exception lowers one, it
    // never drops it.
    const partial = files.filter((path) =>
      METRICS.some((metric) => typeof floored.get(path)?.[metric] !== "number"),
    );
    expect(partial).toEqual([]);
  });
});
