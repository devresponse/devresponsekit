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
});
