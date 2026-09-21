import { describe, expect, it } from "vitest";
import {
  buildSsoLaunchApiPath,
  buildSsoLaunchReturnPath,
  parseSsoLaunchParams,
} from "@/lib/sso-launch-return";
import { getSafeReturnTo } from "@/lib/safe-return-to";
import { locales } from "@/config/i18n-config";

/**
 * Unit tests for the signed-out SSO launch continuation builders.
 *
 * These carry the real proof for this feature: `vitest.config.ts` excludes
 * `src/app/**\/page.tsx` from coverage, so logic left in the trampoline page
 * would have no unit-level test at all. That is why the decisions live here.
 */

const VALID_ID = "portal";

describe("parseSsoLaunchParams", () => {
  it("accepts a well-formed id and supported locale", () => {
    expect(parseSsoLaunchParams(VALID_ID, "fr")).toEqual({
      applicationId: "portal",
      locale: "fr",
    });
  });

  it("narrows an unsupported or missing locale to the default", () => {
    for (const locale of ["zz", "../evil", "", undefined, null, ["en"]]) {
      expect(parseSsoLaunchParams(VALID_ID, locale as never)).toEqual({
        applicationId: "portal",
        locale: "en",
      });
    }
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["array-valued", ["a", "b"]],
    ["uppercase", "A-UPPER"],
    ["path traversal", "../../etc"],
    ["protocol-relative", "//evil.example.com"],
    ["query smuggling", "x&locale=zz"],
    ["fragment", "x#frag"],
    ["question mark", "x?y=1"],
    ["slash", "x/y"],
    ["leading hyphen", "-leading-hyphen"],
    ["backslash", "x\\y"],
    ["whitespace", "x y"],
    ["too long", "a".repeat(129)],
  ])("rejects a %s applicationId", (_label, value) => {
    expect(parseSsoLaunchParams(value as never, "en")).toBeNull();
  });

  it("accepts an id at exactly the length ceiling", () => {
    const maxLength = "a".repeat(128);
    expect(parseSsoLaunchParams(maxLength, "en")?.applicationId).toBe(maxLength);
  });
});

describe("buildSsoLaunchReturnPath", () => {
  it("builds the localized page path the sanitizer accepts", () => {
    expect(buildSsoLaunchReturnPath(VALID_ID, "fr")).toBe(
      "/fr/sso/launch?applicationId=portal&locale=fr",
    );
  });

  it("returns null for anything the parser rejects", () => {
    expect(buildSsoLaunchReturnPath("BAD_UPPER", "en")).toBeNull();
    expect(buildSsoLaunchReturnPath(undefined, "en")).toBeNull();
  });

  it("NEVER produces an /api/ path, whatever it is given", () => {
    for (const id of [VALID_ID, "a.b_c-d", "x9"]) {
      for (const locale of [...locales, "zz", ""]) {
        const built = buildSsoLaunchReturnPath(id, locale);
        expect(built).not.toBeNull();
        expect(built!.startsWith("/api/")).toBe(false);
      }
    }
  });

  it("RECONSTRUCTS the path rather than echoing input", () => {
    // Proves URLSearchParams encoding, not concatenation: the id round-trips
    // through a parse of the built value.
    const built = buildSsoLaunchReturnPath("a.b_c-d", "uk")!;
    expect(built.startsWith("/uk/sso/launch?")).toBe(true);
    const parsed = new URL(built, "https://example.test");
    expect(parsed.pathname).toBe("/uk/sso/launch");
    expect(parsed.searchParams.get("applicationId")).toBe("a.b_c-d");
    expect(parsed.searchParams.get("locale")).toBe("uk");
  });
});

describe("buildSsoLaunchApiPath", () => {
  it("builds the real launch endpoint path", () => {
    expect(buildSsoLaunchApiPath(VALID_ID, "es")).toBe(
      "/api/sso/launch?applicationId=portal&locale=es",
    );
  });

  it("returns null for anything the parser rejects", () => {
    expect(buildSsoLaunchApiPath("//evil.example.com", "en")).toBeNull();
  });

  it("always starts with the literal endpoint prefix", () => {
    const built = buildSsoLaunchApiPath("a.b_c-d", "ja")!;
    expect(built.startsWith("/api/sso/launch?")).toBe(true);
    const parsed = new URL(built, "https://example.test");
    expect(parsed.pathname).toBe("/api/sso/launch");
    expect(parsed.searchParams.get("applicationId")).toBe("a.b_c-d");
  });
});

describe("round trip with getSafeReturnTo", () => {
  /**
   * THE tripwire for this feature, and the reason it is a test rather than a
   * comment: the launch route and the return-target sanitizer must agree. If
   * anyone ever adds `sso` to the rejected-segment list in
   * `src/lib/safe-return-to.ts`, the continuation silently reverts to dumping
   * users on the dashboard — the exact bug this feature fixes — and every other
   * check in the repository would still pass.
   */
  it.each([...locales])("survives the sanitizer unchanged for locale %s", (locale) => {
    const built = buildSsoLaunchReturnPath(VALID_ID, locale)!;
    expect(built).not.toBeNull();
    expect(getSafeReturnTo(built, locale)).toBe(built);
  });

  it("still collapses the raw API path, so the /api/ deny is intact", () => {
    // Pins that this feature did NOT take the shortcut of allow-listing the
    // launch endpoint inside the sanitizer.
    expect(getSafeReturnTo("/api/sso/launch?applicationId=portal&locale=en", "en")).toBe(
      "/en/app/dashboard",
    );
  });
});
