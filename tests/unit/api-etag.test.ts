import { describe, expect, it } from "vitest";
import { ifMatchSatisfied, userEtag } from "@/lib/api-auth/etag";

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
