import { describe, expect, it } from "vitest";
import { buildActiveOrgApplyPath } from "@/lib/scoped-auth";

describe("buildActiveOrgApplyPath", () => {
  it("builds the apply-org path with an encoded org + next", () => {
    expect(buildActiveOrgApplyPath("acme", "/en/app/dashboard")).toBe(
      "/api/preferences/active-org/apply?org=acme&next=%2Fen%2Fapp%2Fdashboard",
    );
  });

  it("percent-encodes special characters in both params", () => {
    const path = buildActiveOrgApplyPath("a c&e", "/en/app?x=1");
    expect(path).toContain("org=a+c%26e");
    expect(path).toContain("next=%2Fen%2Fapp%3Fx%3D1");
  });
});
