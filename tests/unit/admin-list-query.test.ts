import { describe, expect, it, vi } from "vitest";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  offsetFor,
  parseListQuery,
} from "@/lib/admin/list-query.server";

/**
 * Unit tests for `list-query.server.ts`.
 *
 * Pin the parsing contract documented in docs/admin-manager.md §5.1 —
 * unknown sort fields and unknown filters MUST be silently dropped (not
 * error, not pass through), and pagination MUST be clamped so a hostile
 * client cannot DOS us with `pageSize=999999999`.
 */
function p(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("parseListQuery", () => {
  it("uses defaults when no params are present", () => {
    const q = parseListQuery(p(""), {
      allowedSortFields: ["created_at"],
      defaultSort: [{ field: "created_at", direction: "desc" }],
      defaultPageSize: 25,
    });
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(25);
    expect(q.sort).toEqual([{ field: "created_at", direction: "desc" }]);
    expect(q.q).toBeNull();
    expect(q.filters).toEqual({});
  });

  it("clamps page and pageSize to the allowed range", () => {
    const q = parseListQuery(p("page=-3&pageSize=99999"), {
      allowedSortFields: [],
      maxPageSize: 200,
      defaultPageSize: 25,
    });
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(200);
  });

  it("rejects NaN page/pageSize", () => {
    const q = parseListQuery(p("page=abc&pageSize=xyz"), {
      allowedSortFields: [],
      defaultPageSize: 25,
    });
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(25);
  });

  it("drops unknown sort fields and parses asc/desc", () => {
    const q = parseListQuery(p("sort=created_at.desc&sort=evil_field.asc&sort=email.asc"), {
      allowedSortFields: ["created_at", "email"],
    });
    expect(q.sort).toEqual([
      { field: "created_at", direction: "desc" },
      { field: "email", direction: "asc" },
    ]);
  });

  it("falls back to default sort when only invalid fields are passed", () => {
    const q = parseListQuery(p("sort=evil.desc"), {
      allowedSortFields: ["created_at"],
      defaultSort: [{ field: "created_at", direction: "desc" }],
    });
    expect(q.sort).toEqual([{ field: "created_at", direction: "desc" }]);
  });

  it("drops unknown filters and supports repeated values", () => {
    const q = parseListQuery(p("filter[status]=active&filter[status]=blocked&filter[evil]=x"), {
      allowedSortFields: [],
      allowedFilters: ["status"],
    });
    expect(q.filters).toEqual({ status: ["active", "blocked"] });
  });

  it("collects from/to range filters into a single object", () => {
    const q = parseListQuery(
      p("filter[createdAt][from]=2025-01-01&filter[createdAt][to]=2025-12-31"),
      {
        allowedSortFields: [],
        allowedFilters: ["createdAt"],
      },
    );
    expect(q.filters).toEqual({ createdAt: { from: "2025-01-01", to: "2025-12-31" } });
  });

  it("trims and nulls the q param", () => {
    expect(parseListQuery(p("q=  hello  "), { allowedSortFields: [] }).q).toBe("hello");
    expect(parseListQuery(p("q=   "), { allowedSortFields: [] }).q).toBeNull();
  });
});

describe("offsetFor", () => {
  it("computes the correct SQL OFFSET", () => {
    const q = parseListQuery(p("page=3&pageSize=10"), { allowedSortFields: [] });
    expect(offsetFor(q)).toBe(20);
  });
});

describe("buildListResponse", () => {
  it("returns the standard envelope", () => {
    const q = parseListQuery(p(""), { allowedSortFields: [], defaultPageSize: 25 });
    const r = buildListResponse([{ id: "u1" }], 99, q);
    expect(r).toEqual({
      items: [{ id: "u1" }],
      page: 1,
      pageSize: 25,
      total: 99,
      sort: [],
    });
  });
});

describe("executeListWithTotal", () => {
  // `count(*) over()` is folded into the items SELECT under the `__total`
  // alias, so the page total rides back on each row. The separate count
  // query is only a fallback for an empty page PAST the end.
  const items = (rows: Array<Record<string, unknown>>) => ({
    execute: () => Promise.resolve(rows),
  });
  const counter = (total: unknown) => {
    const executeTakeFirst = vi.fn(() => Promise.resolve({ total }));
    return { query: { executeTakeFirst }, executeTakeFirst };
  };
  const q = (qs: string) => parseListQuery(p(qs), { allowedSortFields: [] });

  it("reads the window total from the first row and strips __total from every item", async () => {
    const count = counter("999"); // must NOT be consulted on a full page
    const { items: out, total } = await executeListWithTotal(
      items([
        { id: "a", __total: "42" },
        { id: "b", __total: "42" },
      ]),
      count.query,
      q("page=1&pageSize=25"),
    );
    expect(total).toBe(42);
    expect(out).toEqual([{ id: "a" }, { id: "b" }]);
    expect(out[0]).not.toHaveProperty("__total");
    expect(count.executeTakeFirst).not.toHaveBeenCalled();
  });

  it("returns 0 for an empty FIRST page without running the fallback count", async () => {
    const count = counter("123");
    const { items: out, total } = await executeListWithTotal(
      items([]),
      count.query,
      q("page=1&pageSize=25"),
    );
    expect(out).toEqual([]);
    expect(total).toBe(0);
    expect(count.executeTakeFirst).not.toHaveBeenCalled();
  });

  it("falls back to the count query for an empty page PAST the end (offset > 0)", async () => {
    const count = counter("57");
    const { total } = await executeListWithTotal(
      items([]),
      count.query,
      q("page=9&pageSize=25"), // offset 200 — past the end of a 57-row set
    );
    expect(total).toBe(57);
    expect(count.executeTakeFirst).toHaveBeenCalledTimes(1);
  });
});

describe("applySortAndPagination", () => {
  it("chains orderBy / limit / offset on the provided builder", () => {
    type Op = { kind: "orderBy" | "limit" | "offset"; arg: unknown; arg2?: unknown };
    const ops: Op[] = [];
    type FakeBuilder = {
      orderBy(arg: unknown, arg2?: unknown): FakeBuilder;
      limit(arg: number): FakeBuilder;
      offset(arg: number): FakeBuilder;
    };
    const builder: FakeBuilder = {
      orderBy(arg, arg2) {
        ops.push({ kind: "orderBy", arg, arg2 });
        return builder;
      },
      limit(arg) {
        ops.push({ kind: "limit", arg });
        return builder;
      },
      offset(arg) {
        ops.push({ kind: "offset", arg });
        return builder;
      },
    };

    const q = parseListQuery(p("page=2&pageSize=10&sort=email.asc"), {
      allowedSortFields: ["email"],
    });
    // Cast through unknown — the helper is generic over a Kysely type
    // we don't need to mock fully for this test.
    applySortAndPagination(builder as unknown as Parameters<typeof applySortAndPagination>[0], q);

    expect(ops.find((o) => o.kind === "limit")?.arg).toBe(10);
    expect(ops.find((o) => o.kind === "offset")?.arg).toBe(10);
    expect(ops.filter((o) => o.kind === "orderBy")).toHaveLength(1);
  });
});
