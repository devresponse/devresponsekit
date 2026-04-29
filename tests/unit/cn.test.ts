import { describe, expect, it } from "vitest";
import { cn } from "@/lib/cn";

describe("cn", () => {
  it("joins truthy class values", () => {
    expect(cn("a", "b", false, null, undefined, "c")).toBe("a b c");
  });

  it("merges conflicting tailwind classes (last wins)", () => {
    // tailwind-merge keeps the later utility for the same property.
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("supports arrays and objects (clsx semantics)", () => {
    expect(cn(["a", { b: true, c: false }])).toBe("a b");
  });
});
