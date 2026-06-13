"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { captureClientError, requestIdFromResponse } from "@/lib/observability/client";

/**
 * URL-backed grid state for the Administrator data grids.
 *
 * docs/admin-manager.md §10 mandates the URL is the source of truth for
 * page, pageSize, sort, filters and `q`. This hook owns that mapping so
 * each grid page does not re-implement it (and risk diverging).
 *
 * Returned setters update the URL via `router.replace` (no back-stack
 * pollution). The hook also auto-fetches on URL change with
 * AbortController cancellation — no SWR/React Query dependency added.
 */

export interface GridState {
  page: number;
  pageSize: number;
  sort: { field: string; direction: "asc" | "desc" }[];
  q: string;
  filters: Record<string, string | string[]>;
}

export interface UseGridStateOptions {
  defaultPageSize?: number;
  defaultSort?: { field: string; direction: "asc" | "desc" }[];
}

export function readGridStateFromParams(
  params: URLSearchParams,
  options: UseGridStateOptions = {},
): GridState {
  const defaultPageSize = options.defaultPageSize ?? 25;
  const pageRaw = Number.parseInt(params.get("page") ?? "1", 10);
  const pageSizeRaw = Number.parseInt(params.get("pageSize") ?? String(defaultPageSize), 10);

  const sort: { field: string; direction: "asc" | "desc" }[] = [];
  for (const raw of params.getAll("sort")) {
    // Use "." as the field/direction separator so the URL stays
    // readable — ":" is encoded by `URLSearchParams.toString()` to
    // `%3A`, while "." is an RFC 3986 unreserved character.
    const [field, dirRaw] = raw.split(".");
    if (!field) continue;
    sort.push({ field, direction: dirRaw === "desc" ? "desc" : "asc" });
  }

  const filters: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const match = /^filter\[([^\]]+)\]$/.exec(key);
    if (!match) continue;
    const name = match[1];
    if (!name) continue;
    const existing = filters[name];
    if (existing === undefined) filters[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else filters[name] = [existing, value];
  }

  return {
    page: Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: Number.isFinite(pageSizeRaw) && pageSizeRaw >= 1 ? pageSizeRaw : defaultPageSize,
    sort: sort.length > 0 ? sort : (options.defaultSort ?? []),
    q: params.get("q") ?? "",
    filters,
  };
}

export function gridStateToSearchParams(
  state: GridState,
  options: UseGridStateOptions = {},
): URLSearchParams {
  const params = new URLSearchParams();
  const defaultPageSize = options.defaultPageSize ?? 25;

  if (state.page !== 1) params.set("page", String(state.page));
  if (state.pageSize !== defaultPageSize) params.set("pageSize", String(state.pageSize));
  for (const s of state.sort) params.append("sort", `${s.field}.${s.direction}`);
  if (state.q) params.set("q", state.q);
  for (const [name, value] of Object.entries(state.filters)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(`filter[${name}]`, v);
    } else if (value) {
      params.set(`filter[${name}]`, value);
    }
  }
  return params;
}

export interface UseGridStateResult {
  state: GridState;
  setPage(page: number): void;
  setPageSize(pageSize: number): void;
  setSort(sort: GridState["sort"]): void;
  setSearch(q: string): void;
  setFilter(name: string, value: string | string[] | null): void;
}

/**
 * Rebuilds an options object from its primitive snapshots so memo/
 * callback dependencies stay primitive — callers usually pass a fresh
 * options literal every render, and depending on its identity would
 * defeat the memoization entirely.
 */
function optionsFromKeys(defaultPageSize: number | undefined, defaultSortKey: string) {
  return {
    defaultPageSize,
    defaultSort: (JSON.parse(defaultSortKey) as GridState["sort"] | null) ?? undefined,
  } satisfies UseGridStateOptions;
}

export function useGridState(options: UseGridStateOptions = {}): UseGridStateResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const searchParamsKey = searchParams.toString();
  const defaultPageSize = options.defaultPageSize;
  const defaultSortKey = JSON.stringify(options.defaultSort ?? null);
  const state = useMemo(
    () =>
      readGridStateFromParams(
        new URLSearchParams(searchParamsKey),
        optionsFromKeys(defaultPageSize, defaultSortKey),
      ),
    // Keys are primitive snapshots so re-renders with structurally equal
    // inputs do not produce a new state reference.
    [searchParamsKey, defaultPageSize, defaultSortKey],
  );

  const replace = useCallback(
    (next: GridState) => {
      const opts = optionsFromKeys(defaultPageSize, defaultSortKey);
      const qs = gridStateToSearchParams(next, opts).toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`);
    },
    [router, pathname, defaultPageSize, defaultSortKey],
  );

  return {
    state,
    setPage: (page) => replace({ ...state, page }),
    setPageSize: (pageSize) => replace({ ...state, pageSize, page: 1 }),
    setSort: (sort) => replace({ ...state, sort, page: 1 }),
    setSearch: (q) => replace({ ...state, q, page: 1 }),
    setFilter: (name, value) => {
      const filters = { ...state.filters };
      if (value === null || (Array.isArray(value) && value.length === 0) || value === "") {
        delete filters[name];
      } else {
        filters[name] = value;
      }
      replace({ ...state, filters, page: 1 });
    },
  };
}

export interface UseGridFetchResult<TItem> {
  data: TItem[] | null;
  total: number;
  isLoading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Fetches a list endpoint, re-running on every URL state change with
 * `AbortController` cancellation so stale responses don't overwrite a
 * newer page. Returns the standard `ListResponse` envelope flattened.
 */
export function useGridFetch<TItem>(
  endpoint: string,
  state: GridState,
  options: UseGridStateOptions = {},
): UseGridFetchResult<TItem> {
  const [reloadToken, setReloadToken] = useState(0);

  // Primitive structural snapshots: changes in URL state retrigger the
  // fetch without re-triggering on every parent render that produces a
  // new `state`/`options` object identity.
  const stateKey = JSON.stringify(state);
  const defaultPageSize = options.defaultPageSize;
  const defaultSortKey = JSON.stringify(options.defaultSort ?? null);
  const fetchKey = `${endpoint}|${stateKey}|${defaultPageSize ?? ""}|${defaultSortKey}|${reloadToken}`;

  // Loading is DERIVED (result is stamped with the key it answered),
  // so the effect never sets state synchronously: a new fetchKey means
  // "loading" by definition until its result lands. Previous items are
  // kept while the next page loads, matching the old behavior.
  const [result, setResult] = useState<{
    forKey: string;
    items: TItem[] | null;
    total: number;
    error: string | null;
  }>({ forKey: "", items: null, total: 0, error: null });

  useEffect(() => {
    const controller = new AbortController();
    const snapshot = JSON.parse(stateKey) as GridState;
    const opts: UseGridStateOptions = {
      defaultPageSize,
      defaultSort: (JSON.parse(defaultSortKey) as GridState["sort"] | null) ?? undefined,
    };

    const qs = gridStateToSearchParams(snapshot, opts).toString();
    const url = `${endpoint}${qs ? `?${qs}` : ""}`;

    fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) {
          const err = new Error(`http_${res.status}`);
          // Only report genuine server failures (5xx). 401/403/404/409 and
          // friends are normal auth/validation flow and would be pure
          // noise. Correlate the report to the server via the response's
          // request id (→ Sentry tag → app_audit_events.request_id).
          if (res.status >= 500) {
            captureClientError(err, {
              endpoint,
              status: res.status,
              requestId: requestIdFromResponse(res),
            });
          }
          throw err;
        }
        return (await res.json()) as { items: TItem[]; total: number };
      })
      .then((body) => {
        setResult({ forKey: fetchKey, items: body.items, total: body.total, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Network / parse failures carry no response; the `http_<n>` errors
        // were already reported above, so capture only the rest here.
        if (!(err instanceof Error) || !/^http_\d+$/.test(err.message)) {
          captureClientError(err, { endpoint });
        }
        setResult((prev) => ({
          forKey: fetchKey,
          items: prev.items,
          total: prev.total,
          error: err instanceof Error ? err.message : "unknown_error",
        }));
      });

    return () => controller.abort();
  }, [fetchKey, endpoint, stateKey, defaultPageSize, defaultSortKey]);

  const settled = result.forKey === fetchKey;
  return {
    data: result.items,
    total: result.total,
    isLoading: !settled,
    error: settled ? result.error : null,
    reload: () => setReloadToken((t) => t + 1),
  };
}
