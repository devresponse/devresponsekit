"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

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
    const [field, dirRaw] = raw.split(":");
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
  for (const s of state.sort) params.append("sort", `${s.field}:${s.direction}`);
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

export function useGridState(options: UseGridStateOptions = {}): UseGridStateResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const searchParamsKey = searchParams.toString();
  const defaultSortKey = JSON.stringify(options.defaultSort ?? null);
  const state = useMemo(
    () => readGridStateFromParams(new URLSearchParams(searchParamsKey), options),
    // Keys are primitive snapshots so re-renders with structurally equal
    // inputs do not produce a new state reference.
    [searchParamsKey, options.defaultPageSize, defaultSortKey, options],
  );

  const replace = useCallback(
    (next: GridState) => {
      const qs = gridStateToSearchParams(next, options).toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`);
    },
    [router, pathname, options],
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
  const [data, setData] = useState<TItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateKey = JSON.stringify(state);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const qs = gridStateToSearchParams(state, optionsRef.current).toString();
    const url = `${endpoint}${qs ? `?${qs}` : ""}`;

    fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`http_${res.status}`);
        }
        return (await res.json()) as { items: TItem[]; total: number };
      })
      .then((body) => {
        setData(body.items);
        setTotal(body.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "unknown_error");
        setLoading(false);
      });

    return () => controller.abort();
    // `stateKey` is a primitive structural snapshot — change in URL
    // state retriggers the fetch without re-triggering on every parent
    // render that produces a new `state` object identity.
  }, [endpoint, stateKey, reloadToken]);

  return {
    data,
    total,
    isLoading,
    error,
    reload: () => setReloadToken((t) => t + 1),
  };
}
