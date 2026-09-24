import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { getSafeReturnTo, getSafeReturnToInLocale } from "@/lib/safe-return-to";
import { likeContains } from "@/lib/admin/list-query.server";

/**
 * FUZZ the injection/redirection surfaces: instead of a handful of known-bad
 * strings, bound the whole input space so no smuggling vector survives a
 * refactor. Attack-biased generators are mixed with arbitrary strings.
 */
const SUPPORTED = ["en", "fr", "es", "uk", "pt", "zh", "hi", "ja"];

const attackish = fc.oneof(
  fc.string(),
  fc.webUrl(),
  fc.constantFrom(
    "//evil.com",
    "/\\evil.com",
    "\\/evil.com",
    "https://evil.com",
    "http://evil.com/x",
    "/api/administrator/users",
    "javascript:alert(1)",
    "/en/sign-in",
    "/en/forgot-password",
    "////evil",
    "/%2f%2fevil",
    "/en/app/x?next=//evil",
    // The SSO launch continuation shapes. The property below asserts no input
    // ever yields an `/api/` result, but the generator never sampled a value
    // of this shape, so the assertion was not actually exercised against the
    // one path a caller now deliberately round-trips through the sanitizer.
    "/en/sso/launch?applicationId=x&locale=en",
    "/api/sso/launch?applicationId=x&locale=en",
  ),
  fc.tuple(fc.constantFrom("//", "/\\", "\\/"), fc.domain()).map(([p, d]) => p + d),
);

describe("getSafeReturnTo — open-redirect fuzzing", () => {
  it("NEVER returns a value that could leave the origin, for ANY input", () => {
    fc.assert(
      fc.property(attackish, fc.constantFrom(...SUPPORTED, "xx", ""), (input, locale) => {
        const r = getSafeReturnTo(input, locale);
        expect(r.startsWith("/")).toBe(true);
        expect(r.startsWith("//")).toBe(false); // protocol-relative
        expect(r.includes("\\")).toBe(false); // backslash smuggling
        expect(r.startsWith("/api/")).toBe(false); // no API/auth loop
      }),
    );
  });

  it("returns the input UNCHANGED only when it is a same-origin localized non-auth path", () => {
    const AUTH = new Set([
      "sign-in",
      "sign-up",
      "forgot-password",
      "blocked",
      "pending-approval",
      "logged-out",
    ]);
    fc.assert(
      fc.property(attackish, (input) => {
        const r = getSafeReturnTo(input, "en");
        if (r === input) {
          expect(input.startsWith("/")).toBe(true);
          expect(input.startsWith("//")).toBe(false);
          expect(input.includes("\\")).toBe(false);
          const seg = input.split("/");
          expect(SUPPORTED).toContain(seg[1]);
          expect(AUTH.has(seg[2] ?? "")).toBe(false);
        }
      }),
    );
  });
});

/**
 * F-35: the auth pages re-point a sanitized returnTo at their own locale. The
 * `attackish` strings almost never start with a supported locale, so they would
 * leave the swap itself unexercised; `localizedPath` samples values that do, in
 * every locale and on the page segments the sanitizer judges.
 */
const localizedPath = fc
  .tuple(
    fc.constantFrom(...SUPPORTED),
    fc.constantFrom("app", "sso", "sign-in", "sign-up", "api", "", "en", "fr"),
    fc.string(),
  )
  .map(([locale, segment, rest]) => `/${locale}/${segment}${rest}`);

describe("getSafeReturnToInLocale — re-pointing never changes the sanitizer's verdict", () => {
  it("returns a value the sanitizer accepts UNCHANGED, in the page's locale, for ANY input", () => {
    fc.assert(
      fc.property(
        fc.oneof(attackish, localizedPath),
        fc.constantFrom(...SUPPORTED, "xx", ""),
        (input, locale) => {
          const pageLocale = SUPPORTED.includes(locale) ? locale : "en";
          const r = getSafeReturnToInLocale(input, locale);
          expect(getSafeReturnTo(r, pageLocale)).toBe(r);
          expect(r.split("/")[1]).toBe(pageLocale);
        },
      ),
    );
  });

  it("differs from the bare sanitizer's answer in the locale segment ONLY", () => {
    fc.assert(
      fc.property(
        fc.oneof(attackish, localizedPath),
        fc.constantFrom(...SUPPORTED),
        (input, locale) => {
          const sanitized = getSafeReturnTo(input, locale).split("/");
          const repointed = getSafeReturnToInLocale(input, locale).split("/");
          expect(repointed.length).toBe(sanitized.length);
          expect(repointed.slice(2)).toEqual(sanitized.slice(2));
        },
      ),
    );
  });
});

describe("likeContains — LIKE-metacharacter escaping fuzzing", () => {
  it("escapes so the pattern matches the term LITERALLY (no % / _ / \\ smuggling)", () => {
    fc.assert(
      fc.property(fc.string(), (term) => {
        const wrapped = likeContains(term);
        expect(wrapped.startsWith("%")).toBe(true);
        expect(wrapped.endsWith("%")).toBe(true);
        // Postgres LIKE default-escapes with `\`: reversing `\c` → `c` over the
        // escaped middle must reproduce the EXACT term — i.e. every `%`, `_`,
        // and `\` was neutralized, none left to act as a wildcard.
        const inner = wrapped.slice(1, -1);
        expect(inner.replace(/\\(.)/g, "$1")).toBe(term);
      }),
    );
  });
});
