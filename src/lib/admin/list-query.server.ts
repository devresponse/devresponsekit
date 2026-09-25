import "server-only";
import { sql, type SelectQueryBuilder, type SqlBool } from "kysely";

/**
 * Generic list-query parsing and application for Administrator API
 * endpoints. Encapsulates the contract documented in
 * docs/admin-manager.md §5.1 so every list endpoint behaves identically.
 *
 * Why this exists:
 *   - Each endpoint would otherwise re-implement page/pageSize/sort/q
 *     parsing — diverging quickly and missing edge cases (negative
 *     offsets, NaN page sizes, unknown sort fields).
 *   - Centralizing the parser ensures unknown sort fields and filters are
 *     consistently DROPPED — allow-listed against the caller's
 *     `allowedSortFields` / `allowedFilters` and never passed through to the
 *     query. It does NOT 400 on an unknown key: an attacker probing arbitrary
 *     columns gets a safe empty result, not an ORDER-BY/WHERE injection or an
 *     error oracle. (audit #7 — the prior "reject" wording overstated this;
 *     the behavior is a silent allow-list drop, as each option's doc notes.)
 *   - The versioned `/api/v1` surface cannot drop silently: a dropped filter
 *     widens the answer to every row, and its callers (integrations, MCP
 *     agents) act on the result without a human looking at the grid. It
 *     parses through {@link parseListQueryStrict}, which answers the same
 *     inputs with a 400 instead (F-34). The allow-lists are published in the
 *     OpenAPI document, so naming them is no oracle.
 */

export interface SortSpec {
  field: string;
  direction: "asc" | "desc";
}

/** Filter operator supported by the parsed query. */
export type FilterValue = string | string[] | { from?: string; to?: string };

export interface ListQuery {
  page: number;
  pageSize: number;
  sort: SortSpec[];
  q: string | null;
  filters: Record<string, FilterValue>;
}

export interface ParseListQueryOptions {
  /** Allowed sort fields. Unknown fields are silently dropped. */
  allowedSortFields: ReadonlyArray<string>;
  /** Allowed filter keys. Unknown keys are silently dropped. */
  allowedFilters?: ReadonlyArray<string>;
  /**
   * Default sort applied when no `sort` query param is present. It need not
   * be unique: {@link applySortAndPagination} appends the `id` tiebreaker to
   * every sort, default or requested (F-41).
   */
  defaultSort?: SortSpec[];
  /**
   * Maximum rows one request returns. A larger `pageSize` is clamped to it
   * SILENTLY, with no error and no marker other than the clamped `pageSize`
   * echoed in the envelope, so one request is never "the whole list": a
   * client that needs every row pages until it holds `total` rows
   * (`fetchAllPages` in src/lib/admin/admin-list.client.ts), and a picker
   * searches with `q` instead (F-41).
   */
  maxPageSize?: number;
  /** Default page size when not provided. */
  defaultPageSize?: number;
}

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PAGE_SIZE = 200;
/** Hard cap on the free-text `q` length — bounds pattern size / scan cost. */
const MAX_Q_LENGTH = 200;

/**
 * Escapes LIKE/ILIKE metacharacters in a user-supplied search term and wraps
 * it for a substring ("contains") match: `%<escaped>%`.
 *
 * Without escaping, a `%` or `_` in `q` is a wildcard — so a search for
 * `50%` matches every row, and `a_b` matches `axb`; both silently return the
 * wrong results. Postgres LIKE/ILIKE uses `\` as the DEFAULT escape character
 * and every call site passes this through a BIND PARAMETER (never string
 * interpolation), so escaping `\`, `%`, and `_` here is sufficient — no
 * explicit `ESCAPE` clause is required. Use everywhere a caller would
 * otherwise write `` `%${query.q}%` ``.
 */
export function likeContains(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

/**
 * Parses a `URLSearchParams` (or the iterable yielded by
 * `request.nextUrl.searchParams`) into a normalized {@link ListQuery}.
 *
 * Parsing rules:
 *   - `page` defaults to 1 and is clamped to >= 1.
 *   - `pageSize` defaults to {@link ParseListQueryOptions.defaultPageSize}
 *     (or 25), clamped to `[1, maxPageSize]`.
 *   - `sort` accepts repeated `field.dir` values (e.g. `created_at.desc`
 *     — dot, not colon; see the separator note below); a bare `field` sorts
 *     ascending. Unknown fields are dropped, and so is a value whose
 *     direction is not exactly `asc` / `desc` ({@link parseSortDirective}).
 *   - `q` is trimmed; empty becomes `null`.
 *   - `filter[<name>]=v` becomes `filters[name]=v`. Repeated values
 *     become an array. `filter[name][from]` / `[to]` produce a range.
 *   - Unknown filters (not in `allowedFilters`) are dropped.
 */
export function parseListQuery(params: URLSearchParams, options: ParseListQueryOptions): ListQuery {
  const allowedSort = new Set(options.allowedSortFields);
  const allowedFilters = options.allowedFilters ? new Set(options.allowedFilters) : null;
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;

  const pageRaw = Number.parseInt(params.get("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  const pageSizeRaw = Number.parseInt(params.get("pageSize") ?? String(defaultPageSize), 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), maxPageSize)
    : defaultPageSize;

  const sort: SortSpec[] = [];
  for (const raw of params.getAll("sort")) {
    const directive = parseSortDirective(raw);
    // A malformed directive is dropped like an unknown field, never read as
    // `asc`: that turned a comma-joined `created_at.desc,status.asc` into an
    // ASCENDING sort with the second key gone (F-34).
    if (!directive || !allowedSort.has(directive.field)) continue;
    sort.push(directive);
  }
  const finalSort = sort.length > 0 ? sort : (options.defaultSort ?? []);

  const qRaw = (params.get("q")?.trim() ?? "").slice(0, MAX_Q_LENGTH);
  const q = qRaw.length > 0 ? qRaw : null;

  const filters: Record<string, FilterValue> = {};
  for (const [key, value] of params.entries()) {
    // Match filter[name] and filter[name][from] / filter[name][to].
    const match = /^filter\[([^\]]+)\](?:\[([^\]]+)\])?$/.exec(key);
    if (!match) continue;
    const name = match[1];
    const sub = match[2];
    if (!name) continue;
    if (allowedFilters && !allowedFilters.has(name)) continue;

    if (sub === "from" || sub === "to") {
      const existing = filters[name];
      const range =
        existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
      range[sub] = value;
      filters[name] = range;
      continue;
    }

    const existing = filters[name];
    if (existing === undefined) {
      filters[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else if (typeof existing === "string") {
      filters[name] = [existing, value];
    }
    // Range objects are not extended with simple values — last write wins
    // would silently drop one user intent; we just ignore the conflict.
  }

  return { page, pageSize, sort: finalSort, q, filters };
}

/**
 * One `sort` value as a {@link SortSpec}: `field`, `field.asc` or
 * `field.desc`, else null.
 *
 * The separator MUST stay in sync with the client (`use-grid-state.ts`). We
 * use "." instead of ":" because URLSearchParams encodes colons to `%3A`,
 * which makes bookmarked URLs hard to read.
 *
 * The direction is everything after the FIRST dot and must be exactly `asc`
 * or `desc` (F-34). It used to be the second `.`-segment with anything but
 * `desc` read as `asc`, so `created_at.desc,status.asc` (one value, the form
 * the MCP gateway sent for two directives) parsed as `created_at` ascending.
 */
function parseSortDirective(raw: string): SortSpec | null {
  const dot = raw.indexOf(".");
  const field = dot === -1 ? raw : raw.slice(0, dot);
  const direction = dot === -1 ? "asc" : raw.slice(dot + 1);
  if (field.length === 0 || (direction !== "asc" && direction !== "desc")) return null;
  return { field, direction };
}

/** How {@link parseListQueryStrict} checks one `filter[<name>]` parameter. */
export interface StrictFilterSpec {
  /** The closed vocabulary (the OpenAPI `enum`). Omit for a free-text exact match. */
  values?: ReadonlyArray<string>;
}

export interface ParseListQueryStrictOptions extends Omit<ParseListQueryOptions, "allowedFilters"> {
  /** The supported `filter[<name>]` parameters, by name. Any other one is a 400. */
  filters?: Readonly<Record<string, StrictFilterSpec>>;
  /** Whether the endpoint applies `q`. Required: on `false`, any `q` is a 400. */
  search: boolean;
}

/** A strictly parsed query: each filter is the list of values it matches (`in`). */
export interface StrictListQuery extends ListQuery {
  filters: Record<string, string[]>;
}

export type StrictListQueryResult =
  { ok: true; query: StrictListQuery } | { ok: false; detail: string };

/**
 * The `/api/v1` list-query parser (F-34): {@link parseListQuery}'s contract,
 * except that nothing the caller asked for is dropped. Each of these is a
 * failure whose `detail` the route returns as a `400 invalid_request`:
 *
 *   - a `sort` value that is not `field`, `field.asc` or `field.desc`, or
 *     names a field outside `allowedSortFields` (so ANY `sort`, when the
 *     list declares no sort field);
 *   - a `filter[<name>]` not declared in `filters` (including the
 *     `[from]` / `[to]` range form, which no v1 filter supports);
 *   - an empty filter value, or one outside the filter's `values`;
 *   - a `q` on a list that does not search (`search: false`), even empty;
 *   - a `page`, `pageSize` or `q` given more than once.
 *
 * The lenient parser drops every one of these (a repeated scalar keeps its
 * first value), and for a filter or `q` that widens the answer:
 * `filter[status]=bogus` listed ALL users, and `filter[status]=revoked` on
 * the credential listings, which filter on nothing, listed every credential.
 * An integration or an MCP agent acts on that result as if it were the one it
 * asked for.
 *
 * A bare `field` still sorts ascending, as it always has on v1, but the
 * OpenAPI `enum` publishes only `field.asc` / `field.desc` and the 400 detail
 * names only those: the explicit form is the contract.
 *
 * Multiple values are repeated parameters, as the OpenAPI document declares
 * (`explode: true`). A comma is part of a value, never a separator:
 * `filter[status]=blocked,suspended` names no status and is a 400, not two
 * statuses. Splitting would guess at a form v1 never documented, and a
 * free-text filter (`event_type`) cannot tell a separator from a comma in
 * the value it matches. The detail says to repeat the parameter.
 *
 * `page`, `pageSize` and `q` keep the shared clamping (review #47). A column
 * repeated in `sort` is kept at its first occurrence: a later key on a column
 * already ordered by cannot change the order.
 */
export function parseListQueryStrict(
  params: URLSearchParams,
  options: ParseListQueryStrictOptions,
): StrictListQueryResult {
  const specs = options.filters ?? {};
  const filterNames = Object.keys(specs);
  const base = parseListQuery(params, { ...options, allowedFilters: filterNames });

  for (const name of ["page", "pageSize", "q"]) {
    if (params.getAll(name).length > 1) {
      return { ok: false, detail: `\`${name}\` is a single value and cannot be repeated.` };
    }
  }
  if (!options.search && params.has("q")) {
    return { ok: false, detail: "This endpoint does not accept `q`." };
  }

  const allowedSort = new Set(options.allowedSortFields);
  const sort: SortSpec[] = [];
  const sortedFields = new Set<string>();
  for (const raw of params.getAll("sort")) {
    if (allowedSort.size === 0) {
      return { ok: false, detail: "This endpoint does not accept `sort`." };
    }
    const directive = parseSortDirective(raw);
    if (!directive || !allowedSort.has(directive.field)) {
      return {
        ok: false,
        detail:
          `Each \`sort\` value is \`<field>.asc\` or \`<field>.desc\`, where \`<field>\` is one of: ` +
          `${options.allowedSortFields.join(", ")}.${commaHint(raw)}`,
      };
    }
    if (sortedFields.has(directive.field)) continue;
    sortedFields.add(directive.field);
    sort.push(directive);
  }

  const filters: Record<string, string[]> = {};
  for (const [key, value] of params.entries()) {
    if (!key.startsWith("filter[")) continue;
    const name = /^filter\[([^\]]+)\]$/.exec(key)?.[1];
    const spec = name !== undefined && Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (name === undefined || spec === undefined) {
      if (filterNames.length === 0) {
        return { ok: false, detail: "This endpoint does not accept `filter[…]` parameters." };
      }
      const supported = filterNames.map((n) => `filter[${n}]`).join(", ");
      return {
        ok: false,
        detail: `Unsupported filter parameter. This endpoint filters on: ${supported}.`,
      };
    }
    if (value.length === 0) {
      return { ok: false, detail: `\`filter[${name}]\` must not be empty.` };
    }
    if (spec.values && !spec.values.includes(value)) {
      return {
        ok: false,
        detail:
          `Each \`filter[${name}]\` value is one of: ${spec.values.join(", ")}.` + commaHint(value),
      };
    }
    const values = (filters[name] ??= []);
    if (!values.includes(value)) values.push(value);
  }

  return {
    ok: true,
    query: { ...base, sort: sort.length > 0 ? sort : (options.defaultSort ?? []), filters },
  };
}

/** The 400 hint for the one mistake F-34 was about: a comma-joined list. */
function commaHint(value: string): string {
  return value.includes(",")
    ? " A comma does not separate values: repeat the parameter once per value."
    : "";
}

/**
 * Returns the SQL `OFFSET` for a parsed query.
 */
export function offsetFor(query: ListQuery): number {
  return (query.page - 1) * query.pageSize;
}

/**
 * Generic envelope returned by every list endpoint. Aligned with
 * docs/admin-manager.md §5.1 so the client `DataGrid` can consume any
 * resource without per-endpoint wiring.
 */
export interface ListResponse<TItem> {
  items: TItem[];
  page: number;
  pageSize: number;
  total: number;
  sort: SortSpec[];
}

/**
 * Builds the response envelope. Centralised so callers cannot accidentally
 * leak extra unbounded fields.
 */
export function buildListResponse<TItem>(
  items: TItem[],
  total: number,
  query: ListQuery,
): ListResponse<TItem> {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    sort: query.sort,
  };
}

/** The unique column {@link applySortAndPagination} orders by last, by default. */
const DEFAULT_TIEBREAKER: ReadonlyArray<string> = ["id"];

/**
 * Applies parsed `sort` and pagination to a Kysely select query. Sort
 * fields are validated against `allowedSortFields` by the parser, so
 * passing them straight to `orderBy` is safe — we still wrap in
 * `sql.ref` to make the safety obvious.
 *
 * After the requested (or default) sort it orders by `tiebreaker`, a key
 * unique per row, `id` unless the list says otherwise (F-41). Each page is a
 * separate `LIMIT … OFFSET` query, and Postgres returns rows that tie on the
 * sort in no particular order, and not always the same order twice. Sorting
 * users by `status`, where most rows tie, page 2 could repeat a row page 1
 * showed and never show another; the roles default (`key`) ties across every
 * org holding an `admin` role. A client that pages a catalog to completion
 * (`fetchAllPages`) then misses rows while its count looks right. The sort
 * params and the `sort` echoed in the envelope are unchanged: the tiebreaker
 * is an implementation detail of the order, as it is for the export's keyset
 * sort ({@link buildKeysetSort}).
 *
 * The tiebreaker is referenced by OUTPUT column name, like the sort fields,
 * so it must name exactly one column of the SELECT: every list selects its
 * row's `id`, except the membership lists, which pass their own unique key
 * (a user appears once per group, and once per org for a role). A column the
 * sort already names is not repeated.
 */
export function applySortAndPagination<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  query: ListQuery,
  tiebreaker: ReadonlyArray<string> = DEFAULT_TIEBREAKER,
): SelectQueryBuilder<DB, TB, O> {
  let next = qb;
  for (const s of query.sort) {
    next = next.orderBy(sql.ref(s.field), s.direction);
  }
  const sorted = new Set(query.sort.map((s) => s.field));
  for (const field of tiebreaker) {
    if (!sorted.has(field)) next = next.orderBy(sql.ref(field), "asc");
  }
  return next.limit(query.pageSize).offset(offsetFor(query));
}

/** Alias the folded window count rides on. Stripped before the response. */
const TOTAL_ALIAS = "__total" as const;

/**
 * A `count(*) over() as __total` selection to fold into a list query's
 * SELECT. Window functions are evaluated over the full filtered set BEFORE
 * `LIMIT`/`OFFSET`, so the total rides back on the same scan as the page
 * rows — pair with {@link executeListWithTotal}, which reads and strips it.
 */
export function windowTotalColumn() {
  return sql<string>`count(*) over()`.as(TOTAL_ALIAS);
}

/**
 * Runs a list query whose SELECT carries {@link windowTotalColumn} and
 * returns `{ items, total }`, with the window-count column stripped from
 * every item. Replaces the previous two round-trips (a `SELECT … LIMIT`
 * plus a separate `SELECT count(*)`) with one.
 *
 * The count rides on each returned row, so an EMPTY page carries no count.
 * That happens only when (a) nothing matches — total is 0 — or (b) the
 * requested page is past the end (`offset > 0`). For (b) alone we fall back
 * to a single `count(*)` (via `countQuery`) so the pager still shows the
 * true total. The fallback query is built by the caller but executed ONLY
 * in that rare case, so the common path stays a single query.
 */
export async function executeListWithTotal<TRow>(
  itemsQuery: { execute(): Promise<TRow[]> },
  countQuery: { executeTakeFirst(): Promise<{ total: unknown } | undefined> },
  query: ListQuery,
): Promise<{ items: Array<Omit<TRow, typeof TOTAL_ALIAS>>; total: number }> {
  const rows = await itemsQuery.execute();
  if (rows.length > 0) {
    const total = Number((rows[0] as Record<string, unknown>)[TOTAL_ALIAS] ?? rows.length);
    for (const row of rows) delete (row as Record<string, unknown>)[TOTAL_ALIAS];
    return { items: rows as Array<Omit<TRow, typeof TOTAL_ALIAS>>, total };
  }
  // Empty page: first page → genuinely empty (0); a later page → past the
  // end, so spend the one round-trip we just saved to learn the real total.
  const total =
    offsetFor(query) === 0 ? 0 : Number((await countQuery.executeTakeFirst())?.total ?? 0);
  return { items: [], total };
}

/* -------------------------------------------------------------------------- */
/*  Keyset (seek) pagination                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One column of a keyset sort key. `nullable` drives both the `NULLS LAST`
 * ordering and the null-aware seek predicate — non-null columns skip those
 * branches so the generated SQL stays index-friendly.
 */
export interface KeysetField {
  field: string;
  direction: "asc" | "desc";
  nullable: boolean;
}

/**
 * A keyset cursor: each seek column's value on the last emitted row, AS
 * POSTGRES RENDERED IT (see {@link applyKeyset}), or `null` for a SQL NULL.
 *
 * Deliberately text, never the driver's typed value (F-31): `pg` parses a
 * `timestamptz` into a JS `Date`, which holds milliseconds, while Postgres
 * stores microseconds. A cursor of `12:00:00.123` for a row at
 * `12:00:00.123456` made the next page's `created_at < $1` skip every
 * remaining row of that millisecond (desc), and `created_at > $1` re-select
 * them (asc) — with a page's worth of rows in one millisecond, one bulk
 * transaction sharing `now()`, the ascending export looped to the row cap.
 * Typing the cursor as text keeps a `Date` out of it at compile time.
 */
export type KeysetCursor = Readonly<Record<string, string | null>>;

/**
 * Alias of the column {@link applyKeyset} adds to the page's SELECT, carrying
 * the seek columns' full-precision renderings. Read only by
 * {@link keysetCursorFrom}; exporters map named columns, so it never reaches
 * the output.
 */
const KEYSET_ALIAS = "__keyset" as const;

/** The column {@link applyKeyset} adds to every row it selects. */
export interface KeysetRenderedRow {
  [KEYSET_ALIAS]: Array<string | null>;
}

/**
 * Derives the keyset sort key from a parsed {@link ListQuery.sort}: the
 * requested sort columns, then `id` appended as a unique, non-null tiebreaker
 * so the total order is fully deterministic — a hard requirement for correct
 * seek pagination (a non-unique ORDER BY can drop or duplicate rows across
 * page boundaries). If the sort already targets `id`, it is left as the
 * tiebreaker and not duplicated.
 *
 * `nullableFields` names the sort columns that can be NULL so they can be
 * ordered and sought with explicit `NULLS LAST` semantics.
 *
 * A column repeated in `sort` is kept once, at its FIRST occurrence (and in
 * that direction). {@link parseListQuery} keeps every repeated `sort=` that
 * passes the allow-list, and a later term on a column already ordered by can
 * only compare equal, so dropping it leaves the order unchanged. It does
 * matter to the SQL: {@link applyKeyset} renders every seek column as one
 * argument of a single `json_build_array(…)`, and Postgres rejects a call
 * with more than 100 arguments, so a hand-built URL repeating one sort 100
 * times failed the export (F-31 review). De-duplicated, the key is bounded by
 * the resource's allow-list plus `id`, and the seek predicate, quadratic in
 * the key length, stays small.
 */
export function buildKeysetSort(
  sort: SortSpec[],
  nullableFields: ReadonlySet<string> = new Set(),
): KeysetField[] {
  const fields: KeysetField[] = [];
  const seen = new Set<string>();
  for (const s of sort) {
    if (seen.has(s.field)) continue;
    seen.add(s.field);
    fields.push({
      field: s.field,
      direction: s.direction,
      nullable: nullableFields.has(s.field),
    });
  }
  if (!seen.has("id")) {
    fields.push({ field: "id", direction: "asc", nullable: false });
  }
  return fields;
}

/**
 * Reads a {@link KeysetCursor} off a row selected through {@link applyKeyset}
 * with the SAME `sort`: the seek columns' database renderings, never the typed
 * fields (a `Date` has lost the microseconds — F-31).
 *
 * Throws if the row carries no matching rendering. Falling back to the typed
 * fields would silently bring the millisecond truncation back; a loud failure
 * surfaces as the export's preflight 502 instead.
 */
export function keysetCursorFrom(row: Record<string, unknown>, sort: KeysetField[]): KeysetCursor {
  const rendered: unknown = row[KEYSET_ALIAS];
  if (
    !Array.isArray(rendered) ||
    rendered.length !== sort.length ||
    !rendered.every((v) => v === null || typeof v === "string")
  ) {
    throw new Error(
      "keysetCursorFrom: the row has no keyset rendering for this sort; select it through applyKeyset with the same sort",
    );
  }
  const cursor: Record<string, string | null> = {};
  sort.forEach((f, i) => {
    cursor[f.field] = rendered[i] as string | null;
  });
  return cursor;
}

/**
 * Full-precision text rendering of one seek column, for the cursor.
 *
 * `to_jsonb(x) #>> '{}'` rather than `x::text`: `to_jsonb` writes date/time
 * values as ISO 8601 with a numeric UTC offset (`2026-09-24T12:00:00.123456
 * +00:00`) whatever the session's DateStyle and TimeZone, so the literal names
 * one instant exactly and parses back on any pooled connection; `::text`
 * follows DateStyle (`24.09.2026 … +0545` under German, `… IST` under SQL)
 * and does not parse back under another. Every other type renders through its
 * ordinary text output (`#>> '{}'` unwraps the JSON scalar), which is already
 * exact, so the helper needs no per-column type list a new exporter could
 * forget.
 */
function renderSeekColumn(f: KeysetField) {
  return sql<string | null>`to_jsonb(${sql.ref(f.field)}) #>> '{}'`;
}

/**
 * `row.col` ⋛ cursor at this level — the strictly-after half of the seek.
 *
 * The cursor text is bound as an untyped parameter (`pg` declares no parameter
 * types), so Postgres reads it as the column's own type — an `unknown` operand
 * of a binary operator takes the other side's type. `created_at < $1` stays a
 * plain, index-friendly comparison, now at the stored microsecond (F-31).
 */
function levelAfter(f: KeysetField, value: string | null | undefined) {
  // A NULL cursor value sits at the NULLS-LAST tail: nothing sorts strictly
  // after it here, so this level contributes nothing (deeper levels carry the
  // equal-NULL → id comparison).
  if (value === null || value === undefined) return sql<SqlBool>`false`;
  const cmp = f.direction === "asc" ? sql`>` : sql`<`;
  // NULLS LAST: a NULL row sorts after any non-null cursor value, so include
  // it — but only for genuinely nullable columns, to keep non-null seeks
  // (e.g. `created_at < $1`) clean and index-friendly.
  return f.nullable
    ? sql<SqlBool>`(${sql.ref(f.field)} ${cmp} ${value} or ${sql.ref(f.field)} is null)`
    : sql<SqlBool>`${sql.ref(f.field)} ${cmp} ${value}`;
}

/** `row.col` = cursor at this level — NULL-safe (a NULL matches a NULL). */
function levelEqual(f: KeysetField, value: string | null | undefined) {
  if (value === null || value === undefined) return sql<SqlBool>`${sql.ref(f.field)} is null`;
  return sql<SqlBool>`${sql.ref(f.field)} = ${value}`;
}

/**
 * Applies a keyset (seek) ORDER BY, the LIMIT, and — when a `cursor` is given
 * — the seek predicate to a Kysely select. This replaces OFFSET pagination:
 * rather than asking the database to scan and discard `offset` rows (an
 * O(offset) cost that degrades badly on deep pages and large exports), it
 * seeks straight past the last row of the previous page via a lexicographic
 * row comparison, so every page is a bounded indexed range scan regardless of
 * how far in we are.
 *
 * The seek predicate is the standard expansion of "strictly after the cursor"
 * under the (possibly mixed-direction, possibly NULL-bearing) sort key:
 *
 *   after₀ OR (eq₀ AND after₁) OR (eq₀ AND eq₁ AND after₂) OR …
 *
 * where `eqᵢ`/`afterᵢ` are NULL-safe per {@link levelEqual}/{@link levelAfter}
 * and NULLs are ordered last. Pass the SAME `sort` to {@link keysetCursorFrom}
 * so the cursor carries exactly the columns the predicate reads.
 *
 * It also adds one column, `__keyset`: a JSON array of every seek column's
 * full-precision text ({@link renderSeekColumn}). The next page's cursor is
 * read from that, so the value sought is exactly the value stored, not the
 * driver's lossy copy of it (F-31).
 */
export function applyKeyset<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  sort: KeysetField[],
  cursor: KeysetCursor | null,
  limit: number,
): SelectQueryBuilder<DB, TB, O & KeysetRenderedRow> {
  // `$castTo` only restates the added column: Kysely cannot resolve
  // `Selection<DB, TB, …>` while DB/TB are still generic.
  let next = qb
    .select(
      sql<Array<string | null>>`json_build_array(${sql.join(sort.map(renderSeekColumn))})`.as(
        KEYSET_ALIAS,
      ),
    )
    .$castTo<O & KeysetRenderedRow>();
  if (cursor) {
    const orTerms = sort.map((after, p) => {
      // Levels 0..p-1 equal the cursor, level p is strictly after it.
      const andTerms = sort.slice(0, p).map((eq) => levelEqual(eq, cursor[eq.field]));
      andTerms.push(levelAfter(after, cursor[after.field]));
      return sql<SqlBool>`(${sql.join(andTerms, sql` and `)})`;
    });
    next = next.where(sql<SqlBool>`(${sql.join(orTerms, sql` or `)})`);
  }
  for (const f of sort) {
    const dir = f.direction === "desc" ? sql`desc` : sql`asc`;
    next = next.orderBy(
      f.nullable ? sql`${sql.ref(f.field)} ${dir} nulls last` : sql`${sql.ref(f.field)} ${dir}`,
    );
  }
  return next.limit(limit);
}
