import { describe, expect, it } from "vitest";
import { filterMenuByPermissions } from "@/lib/navigation.server";

describe("filterMenuByPermissions", () => {
  const items = [
    { id: "a", label: "A" },
    { id: "b", label: "B", requiredPermissions: ["x"] },
    { id: "c", label: "C", requiredPermissions: ["x", "y"] },
  ];

  it("includes items with no required permissions", () => {
    const result = filterMenuByPermissions(items, []);
    expect(result.map((i) => i.id)).toEqual(["a"]);
  });

  it("includes items the caller is allowed", () => {
    const result = filterMenuByPermissions(items, ["x"]);
    expect(result.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("requires every listed permission", () => {
    const result = filterMenuByPermissions(items, ["x", "y"]);
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores extra permissions", () => {
    const result = filterMenuByPermissions(items, ["x", "y", "z"]);
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("supports anyOfPermissions OR semantics alongside requiredPermissions", () => {
    const orItems = [
      { id: "any-a", label: "A", anyOfPermissions: ["m", "n"] },
      // requiredPermissions (AND) combined with anyOfPermissions (OR):
      // caller must hold every required key AND at least one of the
      // any-of keys.
      {
        id: "both",
        label: "Both",
        requiredPermissions: ["base"],
        anyOfPermissions: ["m", "n"],
      },
    ];
    expect(filterMenuByPermissions(orItems, ["m"]).map((i) => i.id)).toEqual(["any-a"]);
    expect(filterMenuByPermissions(orItems, ["base", "n"]).map((i) => i.id)).toEqual([
      "any-a",
      "both",
    ]);
    expect(filterMenuByPermissions(orItems, ["base"]).map((i) => i.id)).toEqual([]);
    expect(filterMenuByPermissions(orItems, []).map((i) => i.id)).toEqual([]);
  });
});
