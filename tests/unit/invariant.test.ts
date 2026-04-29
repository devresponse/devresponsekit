import { describe, expect, it } from "vitest";
import { invariant } from "@/lib/invariant";

describe("invariant", () => {
  it("returns silently for defined values", () => {
    expect(() => invariant("x", "should not throw")).not.toThrow();
    expect(() => invariant(0, "zero is defined")).not.toThrow();
    expect(() => invariant(false, "false is defined")).not.toThrow();
    expect(() => invariant({}, "object is defined")).not.toThrow();
  });

  it("throws with the contract message for null/undefined", () => {
    expect(() => invariant(null, "value missing")).toThrow(/Invariant failed: value missing/);
    expect(() => invariant(undefined, "value missing")).toThrow(/Invariant failed: value missing/);
  });
});
