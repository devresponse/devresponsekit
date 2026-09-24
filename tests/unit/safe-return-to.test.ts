import { describe, expect, it } from "vitest";
import { getSafeReturnTo, getSafeReturnToInLocale } from "@/lib/safe-return-to";

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
    expect(getSafeReturnTo("/\evil.example.com")).toBe("/en/app/dashboard");
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

/**
 * F-35: the language switcher keeps `?returnTo=` verbatim, so after a switch
 * the sign-in page holds a returnTo minted in the OLD locale. The auth pages
 * re-point it at their own, or signing in undoes the language just chosen.
 */
describe("getSafeReturnToInLocale", () => {
  it("re-points a returnTo minted in another locale at the page's locale", () => {
    // The signed-out default (proxy / requireSecureSession) after a switch.
    expect(getSafeReturnToInLocale("/en/app/dashboard", "uk")).toBe("/uk/app/dashboard");
    expect(getSafeReturnToInLocale("/en/app/workspace", "fr")).toBe("/fr/app/workspace");
  });

  it("changes only the locale segment: path, query and fragment stay byte-for-byte", () => {
    expect(
      getSafeReturnToInLocale(
        "/en/app/administrator/users?page=3&filter[status]=blocked#grid",
        "es",
      ),
    ).toBe("/es/app/administrator/users?page=3&filter[status]=blocked#grid");
    // A locale-looking segment further along is not the locale segment.
    expect(getSafeReturnToInLocale("/en/app/docs/en/intro?next=/en/app/x", "ja")).toBe(
      "/ja/app/docs/en/intro?next=/en/app/x",
    );
    expect(getSafeReturnToInLocale("/en", "pt")).toBe("/pt");
  });

  it("re-points the SSO launch trampoline, whose own locale= query still wins there", () => {
    expect(getSafeReturnToInLocale("/en/sso/launch?applicationId=portal&locale=en", "fr")).toBe(
      "/fr/sso/launch?applicationId=portal&locale=en",
    );
  });

  it("is a no-op for a returnTo already in the page's locale", () => {
    expect(getSafeReturnToInLocale("/fr/app/workspace", "fr")).toBe("/fr/app/workspace");
  });

  it("sanitizes first: a rejected value falls back to the page locale's dashboard", () => {
    for (const value of [
      null,
      undefined,
      "",
      "https://evil.example.com/x",
      "//evil.example.com/x",
      "/\evil.example.com",
      "/api/sso/launch?applicationId=portal&locale=en",
      "/en/sign-in",
      "/zz/app/dashboard",
    ]) {
      expect(getSafeReturnToInLocale(value, "uk")).toBe("/uk/app/dashboard");
    }
  });

  it("uses the default locale for an unsupported page locale", () => {
    expect(getSafeReturnToInLocale("/fr/app/workspace", "xx")).toBe("/en/app/workspace");
    expect(getSafeReturnToInLocale(null, "xx")).toBe("/en/app/dashboard");
  });
});
