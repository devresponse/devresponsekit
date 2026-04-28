import { describe, expect, it } from "vitest";
import { getSafeReturnTo } from "@/lib/safe-return-to";

describe("getSafeReturnTo", () => {
  it("returns the dashboard fallback for null/undefined", () => {
    expect(getSafeReturnTo(null)).toBe("/en/app/dashboard");
    expect(getSafeReturnTo(undefined)).toBe("/en/app/dashboard");
  });

  it("rejects absolute URLs", () => {
    expect(getSafeReturnTo("https://evil.example.com/x")).toBe("/en/app/dashboard");
    expect(getSafeReturnTo("http://evil.example.com")).toBe("/en/app/dashboard");
  });

  it("rejects protocol-relative URLs", () => {
    expect(getSafeReturnTo("//evil.example.com/x")).toBe("/en/app/dashboard");
  });

  it("rejects backslash smuggling", () => {
    expect(getSafeReturnTo("/\\evil.example.com")).toBe("/en/app/dashboard");
  });

  it("rejects API and auth/status routes", () => {
    expect(getSafeReturnTo("/api/secret")).toBe("/en/app/dashboard");
    expect(getSafeReturnTo("/en/sign-in")).toBe("/en/app/dashboard");
    expect(getSafeReturnTo("/en/blocked")).toBe("/en/app/dashboard");
    expect(getSafeReturnTo("/en/pending-approval")).toBe("/en/app/dashboard");
    expect(getSafeReturnTo("/en/logged-out")).toBe("/en/app/dashboard");
  });

  it("rejects unsupported locales", () => {
    expect(getSafeReturnTo("/zz/app/dashboard")).toBe("/en/app/dashboard");
  });

  it("accepts valid localized browser paths", () => {
    expect(getSafeReturnTo("/en/app/workspace")).toBe("/en/app/workspace");
    expect(getSafeReturnTo("/fr/app/dashboard", "fr")).toBe("/fr/app/dashboard");
  });

  it("uses the supplied locale for the fallback", () => {
    expect(getSafeReturnTo(null, "fr")).toBe("/fr/app/dashboard");
    expect(getSafeReturnTo("/api/x", "uk")).toBe("/uk/app/dashboard");
  });
});
