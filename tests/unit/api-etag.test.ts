import { describe, expect, it } from "vitest";
import { ifMatchPinsVersion, ifMatchSatisfied, userEtag } from "@/lib/api-auth/etag";

describe("etag / If-Match", () => {
  it("derives a stable weak tag from a timestamp", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(userEtag(d)).toBe('W/"2026-01-02T03:04:05.000Z"');
    expect(userEtag("2026-01-02T03:04:05.000Z")).toBe(userEtag(d));
  });

  it("passes when no If-Match is supplied (last-write-wins)", () => {
    expect(ifMatchSatisfied(null, 'W/"x"')).toBe(true);
  });

  it("passes on wildcard and exact match, fails on mismatch", () => {
    const tag = userEtag(new Date("2026-01-02T03:04:05.000Z"));
    expect(ifMatchSatisfied("*", tag)).toBe(true);
    expect(ifMatchSatisfied(tag, tag)).toBe(true);
    expect(ifMatchSatisfied('W/"2020-01-01T00:00:00.000Z"', tag)).toBe(false);
  });
});

describe("review #44: ifMatchPinsVersion decides whether a write is a CAS", () => {
  // A route hands `expectedUpdatedAt` to the mutation ONLY when the caller
  // pinned a concrete version — that is what turns the precondition from a
  // check-then-act into a compare-and-swap in the UPDATE's WHERE. `*` and an
  // absent header mean "any existing entity", i.e. last-write-wins, which must
  // keep working exactly as before.
  const tag = userEtag(new Date("2026-01-02T03:04:05.000Z"));

  it("pins on a concrete tag", () => {
    expect(ifMatchPinsVersion(tag)).toBe(true);
    expect(ifMatchPinsVersion(`${tag}, W/"other"`)).toBe(true);
  });

  it("does NOT pin on `*` or an absent header", () => {
    expect(ifMatchPinsVersion(null)).toBe(false);
    expect(ifMatchPinsVersion("*")).toBe(false);
    expect(ifMatchPinsVersion(" * ")).toBe(false);
    // A list containing the wildcard matches any entity, so it pins nothing.
    expect(ifMatchPinsVersion(`${tag}, *`)).toBe(false);
  });
});
