import { useEffect, useRef, useState } from "react";

/**
 * F-41: the ONE way the Administrator's pickers and catalog editors read an
 * admin list endpoint (`/api/administrator/*`).
 *
 * A list endpoint answers at most `maxPageSize` rows (200) per request and
 * clamps a larger `pageSize` silently (src/lib/admin/list-query.server.ts).
 * Six places fetched ONE `pageSize=200` page and treated it as the whole set,
 * ignoring `total`: past 200 organizations a superadmin could not pick a later
 * org in New role / New group (a group REQUIRES one, so it could not be
 * created there at all), roles and permission keys past position 200 could
 * not be assigned, and nothing on screen said so. Two shapes replace that:
 *
 *   - {@link useAdminSearch}, for PICKERS over a set that grows with the
 *     platform (organizations, roles, groups, users): each query is answered
 *     by the endpoint's own `q` search, so every row is reachable by typing.
 *     Only the newest request may commit its results (a monotonic sequence
 *     guard), so a slow response to an earlier keystroke never replaces the
 *     answer to a later one. The picker turns cmdk's own filter off
 *     (`shouldFilter={false}`): the server already matched, and filtering its
 *     page again would hide rows the server matched on a column the option's
 *     text does not show. This generalizes what the group "Add member" user
 *     picker already did.
 *   - {@link fetchAllPages}, for EDITORS that need the whole catalog on screen
 *     at once (a role's permissions dual-list, a group's roles dual-list, the
 *     invitation role select, the roles holding a permission): pages until it
 *     holds `total` rows, under a hard cap so a runaway catalog cannot turn a
 *     page load into thousands of requests.
 *
 * Both carry the server's `total`, and every consumer renders
 * `ListLimitNotice` ("Showing N of M") when fewer rows are on screen than
 * exist, so a row that is not listed is never silently missing again.
 */

/** Rows a picker asks for per search: enough to scroll, few enough to be quick. */
export const PICKER_PAGE_SIZE = 50;

/** The admin list parser's `maxPageSize`: the most rows one request returns. */
export const ADMIN_LIST_MAX_PAGE_SIZE = 200;

/**
 * The most rows {@link fetchAllPages} collects (25 requests of 200). Far above
 * any real role or permission catalog; past it the caller shows the notice.
 */
export const CATALOG_MAX_ITEMS = 5000;

/** Appends `params` to an endpoint that may already carry a query string. */
function withParams(endpoint: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${qs}`;
}

/** The `total` a list envelope reports, never below the rows actually held. */
function reportedTotal(body: { total?: unknown }, held: number): number {
  return typeof body.total === "number" && Number.isFinite(body.total)
    ? Math.max(body.total, held)
    : held;
}

/** A list request answered with a non-2xx status. */
export class AdminListError extends Error {
  constructor(readonly status: number) {
    super(`Administrator list request failed with HTTP ${status}`);
    this.name = "AdminListError";
  }
}

export interface AllPages<T> {
  /** Every row read, in the endpoint's order, each `id` once. */
  items: T[];
  /**
   * The endpoint's `total` on the last page read, never below `items.length`;
   * the largest count seen instead when the count kept moving (see
   * {@link fetchAllPages}).
   */
  total: number;
  /** `items` is short of `total`: the cap was hit, or the list kept changing while read. */
  truncated: boolean;
}

/**
 * How many times {@link fetchAllPages} walks the pages from the start when the
 * endpoint's count moves between two pages of one walk.
 */
const MAX_WALKS = 3;

/**
 * Reads EVERY page of an admin list endpoint (`url` may already carry
 * filters, e.g. `/api/administrator/roles?filter[organization]=<id>`).
 *
 * One walk stops at the first of: `total` rows held; a page shorter than the
 * page size the envelope echoes (the last page, and the right test even where
 * an endpoint's `maxPageSize` is below the one asked for); a page that adds
 * no new row (an endpoint that ignores `page`); or `maxItems`. Rows are
 * merged by `id`.
 *
 * Each page is its own OFFSET query, so a row inserted or deleted AHEAD of the
 * page boundary between two reads shifts the rows behind it. An insert makes
 * the next page repeat a row (kept once) while the new row is never read; a
 * delete makes the next page skip a live row while the deleted one, already
 * read, is still held. The held rows then match the new count, so the counts
 * alone cannot show the delete. What both change is the count itself, so a
 * walk that sees a page's `total` differ from its first page's starts over
 * from page 1, up to {@link MAX_WALKS} walks. If the count still moves on the
 * last walk, it reads on and reports the largest count it saw, so `truncated`
 * is true and the caller shows "Showing N of M" instead of presenting the
 * list as complete. An insert and a delete between the same two reads leave
 * the count unchanged and are NOT detected (a row can be missing and a
 * deleted row listed); only keyset pagination would close that.
 *
 * Throws {@link AdminListError} on a non-2xx page, and rethrows a network
 * failure: a partial catalog is never returned as if it were whole.
 */
export async function fetchAllPages<T extends { id: string }>(
  url: string,
  {
    maxItems = CATALOG_MAX_ITEMS,
    pageSize = ADMIN_LIST_MAX_PAGE_SIZE,
  }: { maxItems?: number; pageSize?: number } = {},
): Promise<AllPages<T>> {
  for (let walk = 1; ; walk++) {
    const last = walk >= MAX_WALKS;
    const read = await walkPages<T>(url, maxItems, pageSize, !last);
    if (read) return read;
  }
}

/**
 * One walk of {@link fetchAllPages}. Returns `null` when the count moved and
 * `restartOnMove` is set (the caller walks again); otherwise the rows held.
 */
async function walkPages<T extends { id: string }>(
  url: string,
  maxItems: number,
  pageSize: number,
  restartOnMove: boolean,
): Promise<AllPages<T> | null> {
  const byId = new Map<string, T>();
  let total = 0;
  let largest = 0;
  let firstCount: number | null = null;
  let moved = false;
  const maxPages = Math.ceil(maxItems / pageSize);
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(withParams(url, { page: String(page), pageSize: String(pageSize) }), {
      credentials: "same-origin",
    });
    if (!res.ok) throw new AdminListError(res.status);
    const body = (await res.json()) as { items?: unknown; total?: unknown; pageSize?: unknown };
    const count = typeof body.total === "number" && Number.isFinite(body.total) ? body.total : null;
    if (page === 1) {
      firstCount = count;
    } else if (firstCount !== null && count !== null && count !== firstCount) {
      if (restartOnMove) return null;
      moved = true;
    }
    const rows = Array.isArray(body.items) ? (body.items as T[]) : [];
    const before = byId.size;
    for (const row of rows) {
      if (byId.size >= maxItems) break;
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
    total = reportedTotal(body, byId.size);
    largest = Math.max(largest, total);
    const served = typeof body.pageSize === "number" ? body.pageSize : pageSize;
    if (byId.size >= total || byId.size >= maxItems) break;
    if (rows.length < served || byId.size === before) break;
  }
  const items = [...byId.values()];
  const reported = moved ? Math.max(largest, items.length) : total;
  return { items, total: reported, truncated: items.length < reported };
}

export interface AdminSearch<T> {
  /** The newest committed page for {@link AdminSearch.query}; `null` until one arrives. */
  items: T[] | null;
  /** The endpoint's `total` for that page's query (at least `items.length`). */
  total: number;
  /** The newest request failed; `items` still holds the last good page. */
  error: boolean;
  query: string;
  setQuery(next: string): void;
}

/**
 * Server-side search over an admin list endpoint for a picker (see the module
 * comment). `endpoint` may carry fixed filters (`?filter[scope]=org`); the
 * trimmed query goes out as `q`, with {@link PICKER_PAGE_SIZE} rows per answer.
 * The first request runs on mount with no `q`, so an open picker lists the
 * endpoint's first rows before anything is typed. A `null` endpoint sends
 * nothing (a picker whose filters are still loading) and `items` stays `null`
 * until one is given.
 */
export function useAdminSearch<T>(
  endpoint: string | null,
  pageSize: number = PICKER_PAGE_SIZE,
): AdminSearch<T> {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<{ items: T[]; total: number } | null>(null);
  const [error, setError] = useState(false);
  // Monotonic request id: only the newest in-flight fetch may commit results.
  const seq = useRef(0);
  const q = query.trim();

  useEffect(() => {
    if (endpoint === null) return;
    const mySeq = ++seq.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && mySeq === seq.current;
    (async () => {
      try {
        const params: Record<string, string> = { pageSize: String(pageSize) };
        if (q) params.q = q;
        const res = await fetch(withParams(endpoint, params), { credentials: "same-origin" });
        if (!res.ok) {
          if (isCurrent()) setError(true);
          return;
        }
        const body = (await res.json()) as { items?: unknown; total?: unknown };
        if (!isCurrent()) return;
        const items = Array.isArray(body.items) ? (body.items as T[]) : [];
        setError(false);
        setPage({ items, total: reportedTotal(body, items.length) });
      } catch {
        if (isCurrent()) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, q, pageSize]);

  return {
    items: page?.items ?? null,
    total: page?.total ?? 0,
    error,
    query,
    setQuery,
  };
}
