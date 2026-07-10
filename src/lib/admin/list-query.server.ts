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
 *   - Centralizing the parser ensures we always reject unknown sort
 *     fields and filters rather than silently ignoring them, which is
 *     what an attacker would probe for.
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
  /** Default sort applied when no `sort` query param is present. */
  defaultSort?: SortSpec[];
  /** Maximum allowed page size. Caps oversize pageSize requests. */
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
 *   - `sort` accepts repeated `field:dir` values; unknown fields are
 *     dropped, invalid directions fall back to `asc`.
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
    // Separator MUST stay in sync with the client (`use-grid-state.ts`).
    // We use "." instead of ":" because URLSearchParams encodes colons
    // to `%3A`, which makes bookmarked URLs hard to read.
    const [field, dirRaw] = raw.split(".");
    if (!field || !allowedSort.has(field)) continue;
    const direction: "asc" | "desc" = dirRaw === "desc" ? "desc" : "asc";
    sort.push({ field, direction });
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

/**
 * Applies parsed `sort` and pagination to a Kysely select query. Sort
 * fields are validated against `allowedSortFields` by the parser, so
 * passing them straight to `orderBy` is safe — we still wrap in
 * `sql.ref` to make the safety obvious.
 */
export function applySortAndPagination<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  query: ListQuery,
): SelectQueryBuilder<DB, TB, O> {
  let next = qb;
  for (const s of query.sort) {
    next = next.orderBy(sql.ref(s.field), s.direction);
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

/** A keyset cursor: the seek columns' values read from the last emitted row. */
export type KeysetCursor = Record<string, unknown>;

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
 */
export function buildKeysetSort(
  sort: SortSpec[],
  nullableFields: ReadonlySet<string> = new Set(),
): KeysetField[] {
  const fields: KeysetField[] = sort.map((s) => ({
    field: s.field,
    direction: s.direction,
    nullable: nullableFields.has(s.field),
  }));
  if (!fields.some((f) => f.field === "id")) {
    fields.push({ field: "id", direction: "asc", nullable: false });
  }
  return fields;
}

/** Reads a {@link KeysetCursor} (the seek-column values) from a result row. */
export function keysetCursorFrom(row: Record<string, unknown>, sort: KeysetField[]): KeysetCursor {
  const cursor: KeysetCursor = {};
  for (const f of sort) cursor[f.field] = row[f.field];
  return cursor;
}

/** `row.col` ⋛ cursor at this level — the strictly-after half of the seek. */
function levelAfter(f: KeysetField, value: unknown) {
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
function levelEqual(f: KeysetField, value: unknown) {
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
 */
export function applyKeyset<DB, TB extends keyof DB, O>(
  qb: SelectQueryBuilder<DB, TB, O>,
  sort: KeysetField[],
  cursor: KeysetCursor | null,
  limit: number,
): SelectQueryBuilder<DB, TB, O> {
  let next = qb;
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
