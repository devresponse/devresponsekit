import { describe, expect, it } from "vitest";
import {
  DATE_FORMAT_OPTIONS,
  isDateFormatOption,
  isValidTimeZone,
  normalizeOptional,
} from "@/lib/account/preferences";
import {
  ACCOUNT_SECTIONS,
  getVisibleAccountSections,
} from "@/app/[locale]/(secure)/app/account/_sections";

/**
 * Unit tests for the Account preferences helpers and section registry.
 * These are the pure pieces shared by the client form and the API
 * route's Zod schema, so they must agree on the allowed value sets.
 */
describe("isDateFormatOption", () => {
  it("accepts every declared option and rejects others", () => {
    for (const opt of DATE_FORMAT_OPTIONS) {
      expect(isDateFormatOption(opt)).toBe(true);
    }
    expect(isDateFormatOption("nope")).toBe(false);
    expect(isDateFormatOption(123)).toBe(false);
    expect(isDateFormatOption(null)).toBe(false);
  });
});

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/Kyiv")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("rejects unknown, empty, and overlong values", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("x".repeat(65))).toBe(false);
  });
});

describe("normalizeOptional", () => {
  it("maps system/empty/null to null and trims otherwise", () => {
    expect(normalizeOptional(null)).toBeNull();
    expect(normalizeOptional(undefined)).toBeNull();
    expect(normalizeOptional("")).toBeNull();
    expect(normalizeOptional("  ")).toBeNull();
    expect(normalizeOptional("system")).toBeNull();
    expect(normalizeOptional("  fr ")).toBe("fr");
  });
});

describe("account section registry", () => {
  it("every section is user-level (requires only shell.view, never admin.*)", () => {
    for (const section of ACCOUNT_SECTIONS) {
      expect(section.requires).toContain("shell.view");
      expect(section.requires.some((p) => p.startsWith("admin."))).toBe(false);
    }
  });

  it("shows all sections to a baseline member and hides them without shell.view", () => {
    expect(getVisibleAccountSections(["shell.view"])).toHaveLength(ACCOUNT_SECTIONS.length);
    expect(getVisibleAccountSections([])).toHaveLength(0);
  });
});
