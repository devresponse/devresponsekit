import { describe, expect, it } from "vitest";
import { localizedPath, pickLocale } from "@/lib/locale";
import { defaultLocale, isSupportedLocale, locales } from "@/config/i18n-config";

describe("pickLocale", () => {
  it("returns the locale for every supported value", () => {
    for (const locale of locales) {
      expect(pickLocale(locale)).toBe(locale);
    }
  });

  it("falls back to default for unknown values", () => {
    expect(pickLocale("zz")).toBe(defaultLocale);
    expect(pickLocale(null)).toBe(defaultLocale);
    expect(pickLocale(undefined)).toBe(defaultLocale);
    expect(pickLocale(42)).toBe(defaultLocale);
    expect(pickLocale({})).toBe(defaultLocale);
  });
});

describe("localizedPath", () => {
  it("prepends the locale segment to a normal path", () => {
    expect(localizedPath("en", "/app/dashboard")).toBe("/en/app/dashboard");
    expect(localizedPath("fr", "/app/dashboard")).toBe("/fr/app/dashboard");
  });

  it("prepends a slash if missing", () => {
    expect(localizedPath("en", "app")).toBe("/en/app");
  });

  it("returns just the locale prefix for the root path", () => {
    expect(localizedPath("en", "/")).toBe("/en");
  });
});

describe("isSupportedLocale", () => {
  it("accepts every declared locale", () => {
    for (const locale of locales) {
      expect(isSupportedLocale(locale)).toBe(true);
    }
  });

  it("rejects untrusted input", () => {
    expect(isSupportedLocale("ZZ")).toBe(false);
    expect(isSupportedLocale("en-US")).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(123)).toBe(false);
  });
});
