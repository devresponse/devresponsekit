import { describe, expect, it } from "vitest";
import { buildActiveOrgApplyPath, readCookieValue } from "@/lib/scoped-auth";

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

describe("readCookieValue", () => {
  it("extracts a named cookie from the header, among others", () => {
    expect(readCookieValue("a=1; org_signup_hint=acme; b=2", "org_signup_hint")).toBe("acme");
  });

  it("decodes a percent-encoded value", () => {
    expect(readCookieValue("org_signup_hint=a%20b", "org_signup_hint")).toBe("a b");
  });

  it("returns undefined for a missing cookie, empty value, or absent header", () => {
    expect(readCookieValue("a=1; b=2", "org_signup_hint")).toBeUndefined();
    expect(readCookieValue("org_signup_hint=", "org_signup_hint")).toBeUndefined();
    expect(readCookieValue(null, "org_signup_hint")).toBeUndefined();
    expect(readCookieValue(undefined, "org_signup_hint")).toBeUndefined();
  });

  it("does not match on a prefix collision", () => {
    expect(readCookieValue("org_signup_hint_x=nope", "org_signup_hint")).toBeUndefined();
  });
});
