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
  type KeysetField,
} from "@/lib/admin/list-query.server";

/**
 * Keyset (seek) pagination helpers (P2-16). These power the streaming CSV
 * export's page walk; a wrong seek predicate would silently DROP or DUPLICATE
 * export rows, so the generated SQL is asserted directly. We compile against a
 * `DummyDriver` (no DB connection) and inspect `{ sql, parameters }`.
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
function compile(sort: KeysetField[], cursor: Record<string, unknown> | null, limit = 100) {
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
  it("reads exactly the seek columns off a row", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const cursor = keysetCursorFrom(
      { id: "u1", created_at: "2026-01-01", display_name: "x", extra: "ignored" },
      seek,
    );
    expect(cursor).toEqual({ created_at: "2026-01-01", id: "u1" });
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

  it("seeks past the cursor for the common (created_at desc, id asc) key", () => {
    const seek = buildKeysetSort([{ field: "created_at", direction: "desc" }]);
    const when = new Date("2026-01-01T00:00:00Z");
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
      created_at: new Date("2026-01-01T00:00:00Z"),
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
