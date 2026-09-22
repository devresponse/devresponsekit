import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Systemic guard: the Administrator grid must never pass a TanStack accessor
 * method as a BARE REFERENCE.
 *
 * `header.getContext`, `row.getVisibleCells`, `cell.getContext` and friends are
 * methods. Detaching one (`renderHeader(h.column.columnDef, h.getContext, …)`)
 * drops `this`. Under the pinned v8 that happens to work, because v8 closes
 * over the owning object when it builds each header/row/cell — but that is an
 * implementation detail, not a contract. v9 installs the same accessors as
 * memoized PROTOTYPE methods that read private state off `this`, so a detached
 * reference throws `TypeError: Cannot read properties of undefined` during
 * render.
 *
 * The reason this is a source scan and not a behavioural test: on the pinned
 * version the detached form renders correctly, so no runtime assertion can
 * distinguish it. The hazard is invisible to `tsc` as well — the detached
 * method satisfies the `() => HeaderContext` parameter type exactly. A source
 * invariant is therefore the only thing that can hold the line, and it is
 * cheap. `tests/component/administrator-data-grid.test.tsx` pins that the
 * context a header receives is USABLE; this pins that it stays bound.
 *
 * Scope is the grid directory rather than the whole tree because that is where
 * every TanStack call site lives (every other Administrator file imports only
 * the `GridColumnDef` type).
 */

const GRID_DIR = fileURLToPath(
  new URL("../../src/app/[locale]/(secure)/app/administrator/_components/grid", import.meta.url),
);

function gridSources(): { name: string; text: string }[] {
  return readdirSync(GRID_DIR)
    .filter((entry) => {
      const full = join(GRID_DIR, entry);
      return statSync(full).isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"));
    })
    .map((entry) => ({ name: entry, text: readFileSync(join(GRID_DIR, entry), "utf8") }));
}

/**
 * A method reference immediately followed by `,` `)` or `]` is being PASSED,
 * not called — `h.getContext,` rather than `h.getContext()`.
 *
 * The receiver list is what keeps this precise. It names the TABLE-INSTANCE
 * locals this file binds (`h` for a header, plus row/cell/column/table), so the
 * grid's own function props are not swept in: `selection.getRowId` is a plain
 * callback the caller supplies and is meant to be passed by reference.
 */
const TABLE_RECEIVERS = ["h", "header", "row", "cell", "column", "table"];
const DETACHED = new RegExp(
  String.raw`\b(?:${TABLE_RECEIVERS.join("|")})\.(get[A-Z][A-Za-z0-9]*)\s*[,)\]]`,
  "g",
);

describe("Administrator grid: TanStack accessor methods stay bound", () => {
  const sources = gridSources();

  it("scans the grid source files", () => {
    // Vacuity guard: a move or rename of the directory must fail loudly rather
    // than report a clean sweep of nothing.
    expect(sources.length).toBeGreaterThan(3);
    expect(sources.some((s) => s.name === "data-grid.tsx")).toBe(true);
  });

  it.each(sources.map((s) => [s.name, s.text] as const))(
    "%s passes no accessor method as a bare reference",
    (name, text) => {
      const found = [...text.matchAll(DETACHED)].map((m) => m[0]);
      expect(
        found,
        `${name}: found ${found.join(", ")} — a TanStack accessor passed as a bare ` +
          `reference. Detaching the method drops \`this\`; it happens to work on the ` +
          `pinned v8 but throws at render on v9, where these are memoized prototype ` +
          `methods. Wrap it: \`() => h.getContext()\`.`,
      ).toEqual([]);
    },
  );
});
