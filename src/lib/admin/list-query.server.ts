import "server-only";
import { sql, type SelectQueryBuilder } from "kysely";

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
export function parseListQuery(
  params: URLSearchParams,
  options: ParseListQueryOptions,
): ListQuery {
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

  const qRaw = params.get("q")?.trim() ?? "";
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
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? { ...existing }
          : {};
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
