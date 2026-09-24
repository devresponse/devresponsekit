import { describe, expect, it, vi } from "vitest";
import {
  applySortAndPagination,
  buildListResponse,
  executeListWithTotal,
  likeContains,
  offsetFor,
  parseListQuery,
  parseListQueryStrict,
  type ParseListQueryStrictOptions,
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

  it("caps the free-text q at 200 chars", () => {
    const long = "a".repeat(500);
    const q = parseListQuery(p(`q=${long}`), { allowedSortFields: [] });
    expect(q.q).toHaveLength(200);
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

  it("drops a malformed sort direction instead of reading it as asc (F-34)", () => {
    // One comma-joined value, the form the MCP gateway used to send for two
    // directives: the direction parsed as "desc,status" and fell back to asc,
    // so a DESCENDING request came back ascending with its second key gone.
    const opts = {
      allowedSortFields: ["created_at", "status"],
      defaultSort: [{ field: "created_at", direction: "desc" as const }],
    };
    expect(parseListQuery(p("sort=created_at.desc,status.asc"), opts).sort).toEqual([
      { field: "created_at", direction: "desc" },
    ]);
    expect(parseListQuery(p("sort=status.desc.extra&sort=status.up"), opts).sort).toEqual([
      { field: "created_at", direction: "desc" },
    ]);
    // A bare field still sorts ascending; repeated values still apply in order.
    expect(parseListQuery(p("sort=status&sort=created_at.desc"), opts).sort).toEqual([
      { field: "status", direction: "asc" },
      { field: "created_at", direction: "desc" },
    ]);
  });
});

/**
 * The `/api/v1` parser (F-34). The lenient contract above drops what it
 * cannot apply; on v1 a dropped filter answered "which users are blocked?"
 * with EVERY user, so each of those inputs is a failure the route returns as
 * a 400 — and a comma is never a value separator.
 */
describe("parseListQueryStrict", () => {
  const OPTS: ParseListQueryStrictOptions = {
    allowedSortFields: ["created_at", "status"],
    search: true,
    filters: { status: { values: ["active", "blocked", "suspended"] }, event_type: {} },
    defaultSort: [{ field: "created_at", direction: "desc" }],
  };
  const strict = (qs: string) => parseListQueryStrict(p(qs), OPTS);
  const detail = (qs: string) => {
    const result = strict(qs);
    if (result.ok) throw new Error(`expected ${qs} to be refused`);
    return result.detail;
  };

  it("collects every repeated filter value (deduplicated) and every sort directive in order", () => {
    const result = strict(
      "filter[status]=blocked&filter[status]=suspended&filter[status]=blocked" +
        "&sort=created_at.desc&sort=status.asc&page=2&pageSize=10&q=ada",
    );
    expect(result).toEqual({
      ok: true,
      query: {
        page: 2,
        pageSize: 10,
        q: "ada",
        sort: [
          { field: "created_at", direction: "desc" },
          { field: "status", direction: "asc" },
        ],
        filters: { status: ["blocked", "suspended"] },
      },
    });
  });

  it("is a one-element list for a single value, and applies the default sort", () => {
    expect(strict("filter[status]=active")).toMatchObject({
      ok: true,
      query: {
        filters: { status: ["active"] },
        sort: [{ field: "created_at", direction: "desc" }],
      },
    });
  });

  it("keeps a free-text filter's value whole, commas included", () => {
    expect(strict("filter[event_type]=a,b&filter[event_type]=c")).toMatchObject({
      ok: true,
      query: { filters: { event_type: ["a,b", "c"] } },
    });
  });

  it("refuses an enum value outside the vocabulary — never drops the filter", () => {
    expect(detail("filter[status]=bogus")).toBe(
      "Each `filter[status]` value is one of: active, blocked, suspended.",
    );
  });

  it("refuses a comma-joined list instead of splitting it, and says to repeat", () => {
    expect(detail("filter[status]=blocked,suspended")).toMatch(
      /one of: active, blocked, suspended\. A comma does not separate values: repeat the parameter/,
    );
  });

  it("refuses an empty value, an undeclared filter and the range form", () => {
    expect(detail("filter[event_type]=")).toBe("`filter[event_type]` must not be empty.");
    for (const qs of ["filter[nope]=x", "filter[status][from]=active", "filter[]=x"]) {
      expect(detail(qs), qs).toBe(
        "Unsupported filter parameter. This endpoint filters on: filter[status], filter[event_type].",
      );
    }
    // A key that is not in the `filter[…]` namespace is not a filter at all.
    expect(strict("status=bogus").ok).toBe(true);
    // Nor does an inherited property name pass as a declared filter.
    expect(strict("filter[constructor]=x").ok).toBe(false);
  });

  it("refuses a malformed sort direction and an unknown sort field", () => {
    for (const qs of [
      "sort=created_at.desc,status.asc",
      "sort=created_at.DESC",
      "sort=created_at.",
      "sort=created_at.desc.x",
      "sort=nope.asc",
      "sort=",
    ]) {
      expect(detail(qs), qs).toMatch(
        /^Each `sort` value is `<field>\.asc` or `<field>\.desc`, where `<field>` is one of: created_at, status\./,
      );
    }
    expect(detail("sort=created_at.desc,status.asc")).toMatch(/repeat the parameter/);
  });

  it("keeps a repeated sort column at its first occurrence, and a bare field sorts asc", () => {
    expect(strict("sort=status&sort=created_at.desc&sort=status.desc")).toMatchObject({
      ok: true,
      query: {
        sort: [
          { field: "status", direction: "asc" },
          { field: "created_at", direction: "desc" },
        ],
      },
    });
  });

  it("refuses `q` on a list that does not search, empty or not", () => {
    const noSearch = { ...OPTS, search: false };
    for (const qs of ["q=ada", "q=", "q=%20%20"]) {
      const result = parseListQueryStrict(p(qs), noSearch);
      expect(result, qs).toEqual({ ok: false, detail: "This endpoint does not accept `q`." });
    }
    expect(parseListQueryStrict(p("page=2"), noSearch).ok).toBe(true);
  });

  it("refuses a repeated page, pageSize or q instead of keeping the first", () => {
    for (const name of ["page", "pageSize", "q"]) {
      expect(detail(`${name}=1&${name}=2`), name).toBe(
        `\`${name}\` is a single value and cannot be repeated.`,
      );
    }
  });

  it("says so when the list takes no sort or filter at all", () => {
    const bare: ParseListQueryStrictOptions = { allowedSortFields: [], search: false };
    const refused = (qs: string) => {
      const result = parseListQueryStrict(p(qs), bare);
      return result.ok ? null : result.detail;
    };
    expect(refused("sort=created_at.desc")).toBe("This endpoint does not accept `sort`.");
    expect(refused("sort=")).toBe("This endpoint does not accept `sort`.");
    expect(refused("filter[status]=active")).toBe(
      "This endpoint does not accept `filter[…]` parameters.",
    );
    expect(parseListQueryStrict(p("page=2&pageSize=10&status=x"), bare)).toEqual({
      ok: true,
      query: { page: 2, pageSize: 10, q: null, sort: [], filters: {} },
    });
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

describe("likeContains (LIKE metacharacter escaping)", () => {
  it("wraps a plain term for a substring match", () => {
    expect(likeContains("alice")).toBe("%alice%");
  });

  it("escapes %, _ and backslash so they match literally", () => {
    expect(likeContains("50%")).toBe("%50\\%%");
    expect(likeContains("a_b")).toBe("%a\\_b%");
    expect(likeContains("back\\slash")).toBe("%back\\\\slash%");
  });

  it("escapes a term that is entirely wildcards (no match-all leak)", () => {
    // Without escaping this would be `%%%` — matching every row.
    expect(likeContains("%")).toBe("%\\%%");
    expect(likeContains("%_%")).toBe("%\\%\\_\\%%");
  });
});
