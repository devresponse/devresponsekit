import { describe, expect, it } from "vitest";
import { toDate } from "@/lib/db-types";

describe("toDate", () => {
  it("returns Date instances unchanged", () => {
    const d = new Date("2026-01-02T03:04:05.000Z");
    expect(toDate(d)).toBe(d);
  });

  it("parses ISO strings", () => {
    const d = toDate("2026-01-02T03:04:05.000Z");
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("parses numeric epoch milliseconds", () => {
    const d = toDate(1_700_000_000_000);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(1_700_000_000_000);
  });

  it("falls back to the epoch for unexpected values", () => {
    expect(toDate(null).getTime()).toBe(0);
    expect(toDate(undefined).getTime()).toBe(0);
    expect(toDate({}).getTime()).toBe(0);
  });
});
