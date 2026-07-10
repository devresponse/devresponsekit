import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { getSafeReturnTo } from "@/lib/safe-return-to";
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
