import { describe, expect, it } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import {
  applyKeyset,
  buildKeysetSort,
  keysetCursorFrom,
  type KeysetCursor,
  type KeysetField,
} from "@/lib/admin/list-query.server";

/**
 * Keyset (seek) pagination helpers (P2-16). These power the streaming CSV
 * export's page walk; a wrong seek predicate would silently DROP or DUPLICATE
 * export rows, so the generated SQL is asserted directly. We compile against a
 * `DummyDriver` (no DB connection) and inspect `{ sql, parameters }`.
 *
 * F-31: the cursor is the database's own text rendering of each seek column
 * (the `__keyset` column `applyKeyset` selects), never the driver's typed
 * value — a `Date` keeps milliseconds while `timestamptz` stores microseconds.
 * The real round trip through Postgres (and the drop / duplicate / loop it
 * caused) is proved in tests/db/export-keyset-precision.db.test.ts.
 */

interface TestDB {
  t: {
    id: string;
    created_at: Date;
    display_name: string | null;
    name: string;
  };
}

const db = new Kysely<TestDB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

/** Compile `select id from t` with the keyset applied; return normalized SQL. */
function compile(sort: KeysetField[], cursor: KeysetCursor | null, limit = 100) {
  const compiled = applyKeyset(db.selectFrom("t").select(["id"]), sort, cursor, limit).compile();
  return { sql: compiled.sql.replace(/\s+/g, " ").trim(), parameters: compiled.parameters };
}

describe("buildKeysetSort", () => {
  it("appends `id` asc as a unique, non-null tiebreaker", () => {
    expect(buildKeysetSort([{ field: "created_at", direction: "desc" }])).toEqual([
      { field: "created_at", direction: "desc", nullable: false },
      { field: "id", direction: "asc", nullable: false },
    ]);
  });

  it("does NOT duplicate `id` when the sort already targets it", () => {
    const seek = buildKeysetSort([{ field: "id", direction: "desc" }]);
    expect(seek).toEqual([{ field: "id", direction: "desc", nullable: false }]);
    expect(seek.filter((s) => s.field === "id")).toHaveLength(1);
  });

  it("keeps a repeated column once, at its first occurrence and direction", () => {
    // parseListQuery keeps every repeated `sort=`; a later term on a column
    // already ordered by only ever compares equal, so the order is the same.
    expect(
      buildKeysetSort([
        { field: "created_at", direction: "desc" },
        { field: "created_at", direction: "desc" },
      ]),
    ).toEqual([
      { field: "created_at", direction: "desc", nullable: false },
      { field: "id", direction: "asc", nullable: false },
    ]);
    expect(
      buildKeysetSort(
        [
          { field: "display_name", direction: "asc" },
          { field: "created_at", direction: "desc" },
          { field: "display_name", direction: "desc" },
          { field: "id", direction: "desc" },
          { field: "created_at", direction: "asc" },
          { field: "id", direction: "asc" },
        ],
        new Set(["display_name"]),
      ),
    ).toEqual([
      { field: "display_name", direction: "asc", nullable: true },
      { field: "created_at", direction: "desc", nullable: false },
      { field: "id", direction: "desc", nullable: false },
    ]);
  });

  it("annotates declared nullable columns", () => {
    const seek = buildKeysetSort(
      [
        { field: "display_name", direction: "asc" },
        { field: "name", direction: "asc" },
      ],
      new Set(["display_name"]),
    );
    expect(seek.find((s) => s.field === "display_name")?.nullable).toBe(true);
    expect(seek.find((s) => s.field === "name")?.nullable).toBe(false);
  });
});

describe("keysetCursorFrom", () => {
  /** A microsecond instant a JS `Date` cannot hold (it keeps `.123`). */
  const MICRO = "2026-09-24T12:00:00.123456+00:00";

  it("reads the seek columns from the `__keyset` rendering, in sort order", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const cursor = keysetCursorFrom(
      {
        id: "u1",
        created_at: new Date(MICRO),
        display_name: "x",
        __keyset: [MICRO, "u1"],
      },
      seek,
    );
    expect(cursor).toEqual({ created_at: MICRO, id: "u1" });
  });

  it("keeps the microseconds: the typed `Date` field is NOT what the cursor carries (F-31)", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const typed = new Date(MICRO);
    // The pre-fix cursor: what `pg` hands back for a timestamptz.
    expect(typed.toISOString()).toBe("2026-09-24T12:00:00.123Z");
    const cursor = keysetCursorFrom({ id: "u1", created_at: typed, __keyset: [MICRO, "u1"] }, seek);
    expect(cursor.created_at).toBe(MICRO);
    expect(cursor.created_at).not.toBe(typed.toISOString());
  });

  it("carries a SQL NULL as null (the NULLS-LAST branch of a nullable column)", () => {
    const seek = buildKeysetSort(
      [{ field: "display_name", direction: "asc" }],
      new Set(["display_name"]),
    );
    expect(keysetCursorFrom({ __keyset: [null, "u1"] }, seek)).toEqual({
      display_name: null,
      id: "u1",
    });
  });

  it("throws instead of falling back to the typed fields when the rendering is missing or mismatched", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const row = { id: "u1", created_at: new Date(MICRO) };
    // No `__keyset` at all: reading the typed fields would reintroduce F-31.
    expect(() => keysetCursorFrom(row, seek)).toThrow(/applyKeyset/);
    // Rendered for a different sort (wrong arity).
    expect(() => keysetCursorFrom({ ...row, __keyset: [MICRO] }, seek)).toThrow(/applyKeyset/);
    // A non-text element (e.g. a driver-parsed value) is not a rendering.
    expect(() => keysetCursorFrom({ ...row, __keyset: [new Date(MICRO), "u1"] }, seek)).toThrow(
      /applyKeyset/,
    );
    expect(() => keysetCursorFrom({ ...row, __keyset: "not-an-array" }, seek)).toThrow(
      /applyKeyset/,
    );
  });
});

describe("applyKeyset — SQL generation", () => {
  it("emits ORDER BY + LIMIT and NO WHERE when no cursor is given (first page)", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const { sql } = compile(seek, null);
    expect(sql).not.toContain("where");
    expect(sql).toContain('order by "created_at" desc, "id" asc');
    expect(sql).toContain("limit");
  });

  it("selects every seek column's full-precision rendering as `__keyset`, in sort order (F-31)", () => {
    const seek = buildKeysetSort(
      [
        { field: "display_name", direction: "asc" },
        { field: "created_at", direction: "desc" },
      ],
      new Set(["display_name"]),
    );
    const { sql } = compile(seek, null);
    // `to_jsonb … #>> '{}'`, not `::text`: ISO 8601 with a numeric offset
    // whatever DateStyle / TimeZone the pooled session has.
    expect(sql).toContain(
      `json_build_array(to_jsonb("display_name") #>> '{}', to_jsonb("created_at") #>> '{}', to_jsonb("id") #>> '{}') as "__keyset"`,
    );
    expect(sql).not.toContain("::text");
    // The caller's own selection is kept.
    expect(sql).toMatch(/^select "id", json_build_array\(/);
  });

  it("a sort repeated 100 times stays a two-column key: json_build_array has a 100-argument limit", () => {
    // `?sort=created_at.desc` x100 reaches buildKeysetSort as 100 specs; one
    // `json_build_array` argument per seek column would be 101 (with `id`),
    // which Postgres rejects, failing the export at preflight.
    const seek = buildKeysetSort(
      Array.from({ length: 100 }, () => ({ field: "created_at", direction: "desc" as const })),
    );
    const cursor = keysetCursorFrom({ __keyset: ["2026-01-01T00:00:00+00:00", "u1"] }, seek);
    const { sql, parameters } = compile(seek, cursor);
    expect(sql).toContain(
      `json_build_array(to_jsonb("created_at") #>> '{}', to_jsonb("id") #>> '{}') as "__keyset"`,
    );
    expect(sql).toMatch(/order by "created_at" desc, "id" asc limit \$\d+$/);
    // after₀ OR (eq₀ AND after₁): three cursor binds plus the limit.
    expect(parameters).toHaveLength(4);
  });

  it("binds the cursor text verbatim, microseconds intact (the round trip F-31 broke)", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "asc" }]);
    const micro = "2026-09-24T12:00:00.123456+00:00";
    const cursor = keysetCursorFrom({ __keyset: [micro, "u1"] }, seek);
    const { sql, parameters } = compile(seek, cursor);
    expect(parameters).toEqual([micro, micro, "u1", 100]);
    // Still a plain comparison on the column (index-friendly): no cast or
    // date_trunc wrapped around `created_at`.
    expect(sql).toContain('("created_at" > $1) or ("created_at" = $2 and "id" > $3)');
    expect(sql).not.toContain("date_trunc");
  });

  it("seeks past the cursor for the common (created_at desc, id asc) key", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const when = "2026-01-01T00:00:00.000001+00:00";
    const { sql, parameters } = compile(seek, { created_at: when, id: "u1" });
    // after₀ OR (eq₀ AND after₁):
    expect(sql).toContain('"created_at" <');
    expect(sql).toContain('"created_at" =');
    expect(sql).toContain('"id" >');
    expect(sql).toContain(" or ");
    expect(sql).toContain(" and ");
    // Non-null columns must NOT carry null branches (keeps the seek index-friendly).
    expect(sql).not.toContain("is null");
    expect(sql).not.toContain("nulls last");
    // Cursor values are bound as parameters, not inlined.
    expect(parameters).toContain(when);
    expect(parameters).toContain("u1");
  });

  it("flips the comparator for an ascending key", () => {
    const seek = buildKeysetSort([{ field: "name", direction: "asc" }]);
    const { sql } = compile(seek, { name: "m", id: "u1" });
    expect(sql).toContain('"name" >');
    expect(sql).toContain('"id" >');
  });

  it("orders a nullable column NULLS LAST and includes the IS NULL seek branch", () => {
    const seek = buildKeysetSort(
      [{ field: "display_name", direction: "asc" }],
      new Set(["display_name"]),
    );
    const { sql } = compile(seek, { display_name: "Bob", id: "u1" });
    expect(sql).toContain('order by "display_name" asc nulls last, "id" asc');
    // A NULL row sorts after a non-null cursor value, so it must be included.
    expect(sql).toContain('"display_name" > $1 or "display_name" is null');
  });

  it("handles a cursor sitting in the NULL block of a nullable column", () => {
    const seek = buildKeysetSort(
      [{ field: "display_name", direction: "asc" }],
      new Set(["display_name"]),
    );
    const { sql, parameters } = compile(seek, { display_name: null, id: "u1" });
    // after₀ collapses to `false` (nothing sorts strictly after the NULLS-LAST
    // tail), and the equal branch matches NULL rows then seeks by id.
    expect(sql).toContain("false");
    expect(sql).toContain('"display_name" is null and "id" > $1');
    // The NULL cursor value is matched with `is null`, never bound as a param.
    expect(parameters).toContain("u1");
    expect(parameters).not.toContain(null);
  });

  it("expands a mixed-direction composite key correctly", () => {
    const seek = buildKeysetSort([
      { field: "name", direction: "asc" },
      { field: "created_at", direction: "desc" },
    ]);
    const { sql } = compile(seek, {
      name: "m",
      created_at: "2026-01-01T00:00:00+00:00",
      id: "u1",
    });
    // Three OR terms: after on name; eq name + after on created_at; eq name + eq created_at + after on id.
    expect(sql).toContain('"name" >');
    expect(sql).toContain('"name" = $');
    expect(sql).toContain('"created_at" <');
    expect(sql).toContain('"created_at" = $');
    expect(sql).toContain('"id" >');
    expect(sql).toContain('order by "name" asc, "created_at" desc, "id" asc');
  });
});
