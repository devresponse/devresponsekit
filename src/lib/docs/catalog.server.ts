import "server-only";
import { getServerEnv } from "@/lib/env";
import { getDocumentSource } from "./source/index.server";
import type { DocCatalogEntry, DocSpace } from "./source/types";

/**
 * Catalog assembly: caching, visibility filtering, and grouping.
 *
 * The pure helpers (`filterCatalogForViewer`, `groupCatalog`,
 * `sortEntries`) take their inputs explicitly so they can be unit-tested
 * without a source or environment. `getCatalog` adds a short in-memory
 * cache over the active {@link DocumentSource}.
 */

export interface DocGroup {
  group: string;
  items: DocCatalogEntry[];
}

/** Sorts by `order` ascending, breaking ties on title (locale-agnostic). */
export function sortEntries(entries: DocCatalogEntry[]): DocCatalogEntry[] {
  return [...entries].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Filters the catalog to what a viewer with `permissions` may see:
 *   - `internal` docs are dropped unless `internalVisible` is true.
 *   - a doc with `requires` is dropped unless ALL keys are granted.
 *
 * Pure: the same input always yields the same output.
 */
export function filterCatalogForViewer(
  entries: DocCatalogEntry[],
  permissions: ReadonlyArray<string>,
  internalVisible: boolean,
): DocCatalogEntry[] {
  const granted = new Set(permissions);
  return entries.filter((entry) => {
    if (entry.visibility === "internal" && !internalVisible) return false;
    if (entry.requires.length > 0 && !entry.requires.every((key) => granted.has(key))) {
      return false;
    }
    return true;
  });
}

/** Groups entries by `group`, sorting groups by name and items by order. */
export function groupCatalog(entries: DocCatalogEntry[]): DocGroup[] {
  const byGroup = new Map<string, DocCatalogEntry[]>();
  for (const entry of entries) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }
  return [...byGroup.entries()]
    .map(([group, items]) => ({ group, items: sortEntries(items) }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

interface CacheState {
  entries: DocCatalogEntry[];
  expires: number;
}
const caches = new Map<DocSpace, CacheState>();
const CACHE_TTL_MS = 30_000;

/**
 * Returns the full, unfiltered catalog for a space, cached briefly (one
 * cache per space so docs and help never bleed into each other). Callers
 * apply `filterCatalogForViewer` with the request's permission set —
 * caching the unfiltered list keeps the cache permission-independent.
 *
 * `now` is injectable for tests; defaults to `Date.now()` in production.
 */
export async function getCatalog(
  space: DocSpace = "docs",
  now: number = Date.now(),
): Promise<DocCatalogEntry[]> {
  const cache = caches.get(space);
  if (cache && cache.expires > now) return cache.entries;
  const entries = await getDocumentSource(space).listCatalog();
  caches.set(space, { entries, expires: now + CACHE_TTL_MS });
  return entries;
}

/** Test seam: clear the catalog caches. */
export function clearCatalogCache(): void {
  caches.clear();
}

/**
 * Convenience: the grouped catalog a given viewer may see, ready for the
 * sidebar/landing.
 */
export async function getVisibleGroupedCatalog(
  permissions: ReadonlyArray<string>,
  space: DocSpace = "docs",
): Promise<DocGroup[]> {
  const internalVisible = getServerEnv().DOCS_INTERNAL_VISIBLE;
  const entries = await getCatalog(space);
  return groupCatalog(filterCatalogForViewer(entries, permissions, internalVisible));
}

/** Whether a viewer may see the document at `slug`, given the catalog. */
export async function canViewDoc(
  slug: string,
  permissions: ReadonlyArray<string>,
  space: DocSpace = "docs",
): Promise<boolean> {
  const internalVisible = getServerEnv().DOCS_INTERNAL_VISIBLE;
  const entries = await getCatalog(space);
  const match = entries.find((entry) => entry.slug === slug);
  if (!match) return false;
  return filterCatalogForViewer([match], permissions, internalVisible).length === 1;
}
