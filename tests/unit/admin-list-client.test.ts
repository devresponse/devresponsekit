import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminListError, CATALOG_MAX_ITEMS, fetchAllPages } from "@/lib/admin/admin-list.client";

/**
 * F-41: `fetchAllPages` reads a whole admin list for the editors that need
 * every row on screen (a role's permission catalog, an org's roles). They
 * used to read one `pageSize=200` page and treat it as complete, so rows past
 * the 200th could not be assigned and nothing said so.
 *
 * `serve` models an admin list endpoint the way `parseListQuery` answers it:
 * `pageSize` clamped to `maxPageSize` and echoed, `page` offsetting, `total`
 * counting every row.
 */
interface Row {
  id: string;
  key: string;
}

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(4, "0");
    return { id: `id-${k}`, key: `perm.${k}` };
  });
}

const fetchMock = vi.fn();

interface ServeOptions {
  maxPageSize?: number;
  /** Replaces the row set after `page` has been answered (a concurrent write). */
  afterPage?: { page: number; next: Row[] };
  /** Answer every page with the first page (an endpoint that ignores `page`). */
  ignorePage?: boolean;
  /** Leave `total` out of the envelope. */
  noTotal?: boolean;
  /** Status to answer a given page with. */
  failPage?: { page: number; status: number };
}

function serve(initial: Row[], opts: ServeOptions = {}) {
  let data = initial;
  fetchMock.mockImplementation(async (url: string) => {
    const u = new URL(String(url), "http://test.local");
    const page = opts.ignorePage ? 1 : Number(u.searchParams.get("page") ?? "1");
    const asked = Number(u.searchParams.get("pageSize") ?? "25");
    const pageSize = Math.min(asked, opts.maxPageSize ?? 200);
    if (opts.failPage?.page === page) {
      return { ok: false, status: opts.failPage.status, json: async () => ({}) };
    }
    const items = data.slice((page - 1) * pageSize, page * pageSize);
    const body = opts.noTotal ? { items } : { items, page, pageSize, total: data.length };
    if (opts.afterPage?.page === page) data = opts.afterPage.next;
    return { ok: true, status: 200, json: async () => body };
  });
}

function requested(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchAllPages (F-41)", () => {
  it("pages until it holds `total` rows, in the endpoint's order", async () => {
    const all = rows(450);
    serve(all);

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got.items).toEqual(all);
    expect(got).toMatchObject({ total: 450, truncated: false });
    expect(requested()).toEqual([
      "/api/administrator/permissions?page=1&pageSize=200",
      "/api/administrator/permissions?page=2&pageSize=200",
      "/api/administrator/permissions?page=3&pageSize=200",
    ]);
    // The 201st key, the one the single-page read could never offer.
    expect(got.items.map((r) => r.key)).toContain("perm.0201");
  });

  it("keeps the endpoint's own filters and sends each fetch with the session cookie", async () => {
    serve(rows(3));

    await fetchAllPages<Row>("/api/administrator/roles?filter[organization]=o1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/administrator/roles?filter[organization]=o1&page=1&pageSize=200",
      { credentials: "same-origin" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at the cap and reports the shortfall", async () => {
    serve(rows(1000));

    const got = await fetchAllPages<Row>("/api/administrator/permissions", { maxItems: 300 });

    expect(got.items).toHaveLength(300);
    expect(got).toMatchObject({ total: 1000, truncated: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps a runaway catalog at CATALOG_MAX_ITEMS by default", async () => {
    serve(rows(CATALOG_MAX_ITEMS + 150));

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got.items).toHaveLength(CATALOG_MAX_ITEMS);
    expect(got).toMatchObject({ total: CATALOG_MAX_ITEMS + 150, truncated: true });
    expect(fetchMock).toHaveBeenCalledTimes(CATALOG_MAX_ITEMS / 200);
  });

  it("re-reads from page 1 when a row is inserted ahead of the page boundary", async () => {
    // Between the two reads a row is inserted AHEAD of the boundary: the old
    // 200th row reappears first on page 2 and the new row is never read. Page
    // 2's count (251) differs from page 1's (250), so the walk starts over.
    const before = rows(250);
    const inserted = { id: "id-0000", key: "perm.0000" };
    serve(before, { afterPage: { page: 1, next: [inserted, ...before] } });

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got.items).toEqual([inserted, ...before]);
    expect(got).toMatchObject({ total: 251, truncated: false });
    expect(requested()).toEqual([
      "/api/administrator/permissions?page=1&pageSize=200",
      "/api/administrator/permissions?page=2&pageSize=200",
      "/api/administrator/permissions?page=1&pageSize=200",
      "/api/administrator/permissions?page=2&pageSize=200",
    ]);
  });

  it("re-reads from page 1 when a row is deleted ahead of the page boundary", async () => {
    // A delete AHEAD of the boundary shifts the old 201st row onto page 1,
    // which was already read, so page 2 never serves it. The deleted row is
    // still held from page 1, so the rows held (249) match page 2's count
    // (249) and only the count's CHANGE (250 -> 249) shows the miss.
    const before = rows(250);
    const after = before.filter((r) => r.id !== "id-0010");
    serve(before, { afterPage: { page: 1, next: after } });

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got.items).toEqual(after);
    expect(got.items.map((r) => r.id)).toContain("id-0201");
    expect(got.items.map((r) => r.id)).not.toContain("id-0010");
    expect(got).toMatchObject({ total: 249, truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports a shortfall when the count keeps moving on every walk", async () => {
    // Each page-1 answer is followed by a delete ahead of the boundary, so
    // no walk sees one count throughout. After the last walk the largest
    // count it saw is reported: the caller shows "Showing N of M" instead of
    // presenting a list with a live row missing as complete.
    let data = rows(250);
    fetchMock.mockImplementation(async (url: string) => {
      const u = new URL(String(url), "http://test.local");
      const page = Number(u.searchParams.get("page"));
      const items = data.slice((page - 1) * 200, page * 200);
      const body = { items, page, pageSize: 200, total: data.length };
      if (page === 1) data = data.slice(1);
      return { ok: true, status: 200, json: async () => body };
    });

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    // Three walks of two pages each; the last one held 247 of the 248 its
    // first page counted (the row the delete shifted onto page 1 is missed).
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(got.items).toHaveLength(247);
    expect(got).toMatchObject({ total: 248, truncated: true });
  });

  it("never reports a total below the rows it holds", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: rows(3), page: 1, pageSize: 200, total: 1 }),
    });

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got.items).toHaveLength(3);
    expect(got).toMatchObject({ total: 3, truncated: false });
  });

  it("follows the page size the envelope echoes when the endpoint clamps lower", async () => {
    serve(rows(250), { maxPageSize: 100 });

    const got = await fetchAllPages<Row>("/api/administrator/roles");

    expect(got.items).toHaveLength(250);
    expect(got.truncated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops when a page adds nothing new (an endpoint that ignores `page`)", async () => {
    serve(rows(450), { ignorePage: true });

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got.items).toHaveLength(200);
    expect(got).toMatchObject({ total: 450, truncated: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an envelope without `total` as one complete page", async () => {
    serve(rows(3), { noTotal: true });

    const got = await fetchAllPages<Row>("/api/administrator/permissions");

    expect(got).toMatchObject({ total: 3, truncated: false });
    expect(got.items).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a failed page instead of returning a partial catalog", async () => {
    serve(rows(450), { failPage: { page: 2, status: 500 } });

    const read = fetchAllPages<Row>("/api/administrator/permissions");

    await expect(read).rejects.toBeInstanceOf(AdminListError);
    await expect(read).rejects.toMatchObject({ status: 500 });
  });
});
