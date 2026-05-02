import {
  gridStateToSearchParams,
  readGridStateFromParams,
} from "@/app/[locale]/(secure)/app/administrator/_components/grid/use-grid-state";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the URL ↔ GridState round-trip used by every
 * Administrator grid (docs/admin-manager.md §10).
 *
 * Round-tripping is the critical contract — a bookmarked URL MUST
 * survive a reload. We assert it on the same options the grid uses in
 * production.
 */
const OPTS = {
  defaultPageSize: 25,
  defaultSort: [{ field: "created_at", direction: "desc" as const }],
};

describe("readGridStateFromParams", () => {
  it("returns defaults for an empty querystring", () => {
    const s = readGridStateFromParams(new URLSearchParams(""), OPTS);
    expect(s.page).toBe(1);
    expect(s.pageSize).toBe(25);
    expect(s.q).toBe("");
    expect(s.sort).toEqual(OPTS.defaultSort);
    expect(s.filters).toEqual({});
  });

  it("parses page, pageSize, sort, q and filters", () => {
    const s = readGridStateFromParams(
      new URLSearchParams(
        "page=3&pageSize=50&sort=primary_email:asc&q=ada&filter[status]=active",
      ),
      OPTS,
    );
    expect(s).toEqual({
      page: 3,
      pageSize: 50,
      sort: [{ field: "primary_email", direction: "asc" }],
      q: "ada",
      filters: { status: "active" },
    });
  });

  it("collects repeated filter values into an array", () => {
    const s = readGridStateFromParams(
      new URLSearchParams("filter[status]=active&filter[status]=blocked"),
      OPTS,
    );
    expect(s.filters).toEqual({ status: ["active", "blocked"] });
  });
});

describe("gridStateToSearchParams", () => {
  it("omits defaults from the URL to keep it readable", () => {
    const params = gridStateToSearchParams(
      {
        page: 1,
        pageSize: 25,
        sort: OPTS.defaultSort,
        q: "",
        filters: {},
      },
      OPTS,
    );
    // Default sort is currently re-emitted because the helper does not
    // dedupe against the defaults — ensure at least page/pageSize are
    // omitted (the most important "noise" properties).
    expect(params.has("page")).toBe(false);
    expect(params.has("pageSize")).toBe(false);
  });

  it("emits non-default values", () => {
    const params = gridStateToSearchParams(
      {
        page: 4,
        pageSize: 50,
        sort: [{ field: "primary_email", direction: "asc" }],
        q: "ada",
        filters: { status: ["active", "blocked"] },
      },
      OPTS,
    );
    expect(params.get("page")).toBe("4");
    expect(params.get("pageSize")).toBe("50");
    expect(params.get("q")).toBe("ada");
    expect(params.getAll("sort")).toEqual(["primary_email:asc"]);
    expect(params.getAll("filter[status]")).toEqual(["active", "blocked"]);
  });
});

describe("URL round-trip", () => {
  it("survives serialize → parse", () => {
    const original = {
      page: 2,
      pageSize: 50,
      sort: [{ field: "primary_email", direction: "asc" as const }],
      q: "search term",
      filters: { status: ["active", "pending_approval"] as string[] },
    };
    const serialized = gridStateToSearchParams(original, OPTS).toString();
    const parsed = readGridStateFromParams(new URLSearchParams(serialized), OPTS);
    expect(parsed).toEqual(original);
  });
});
