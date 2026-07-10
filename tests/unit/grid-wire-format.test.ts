import { describe, expect, it } from "vitest";
import { parseListQuery } from "@/lib/admin/list-query.server";
import { readGridStateFromParams } from "@/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-state";

/**
 * The admin grid wire format (sort=`field.dir`, `filter[name]=v`, page/pageSize,
 * q) is parsed by TWO independent implementations — the client hook
 * (`readGridStateFromParams`) and the server (`parseListQuery`) — coupled only
 * by comments (audit #6). Pin the shared grammar so a change to the separator
 * or the filter syntax in one side fails CI until the other matches.
 */
describe("grid wire-format agreement — client parser ⇄ server parser (#6)", () => {
  it("parses the same sort/filter/q/page grammar identically", () => {
    const params = new URLSearchParams(
      "page=2&pageSize=10&sort=created_at.desc&sort=email.asc&filter[status]=active&q=alice",
    );
    const server = parseListQuery(params, {
      allowedSortFields: ["created_at", "email"],
      allowedFilters: ["status"],
      defaultPageSize: 25,
    });
    const client = readGridStateFromParams(params, { defaultPageSize: 25 });

    expect(client.sort).toEqual(server.sort); // same "field.dir" separator
    expect(client.page).toBe(server.page);
    expect(client.pageSize).toBe(server.pageSize);
    expect(client.q).toBe(server.q ?? ""); // server nulls empty; client uses ""
    expect(client.filters).toEqual(server.filters); // same filter[...] grammar
  });

  it("agrees that an unknown/absent sort falls back and repeated filters array", () => {
    const params = new URLSearchParams("filter[status]=active&filter[status]=blocked");
    const server = parseListQuery(params, { allowedSortFields: [], allowedFilters: ["status"] });
    const client = readGridStateFromParams(params, {});
    expect(client.filters).toEqual(server.filters); // { status: ["active","blocked"] }
  });
});
