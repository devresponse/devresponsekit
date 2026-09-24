import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  USER_NAME_MAX_LENGTH,
  checkUserName,
  optionalUserNameSchema,
  sanitizeUserName,
  userNameSchema,
} from "@/lib/user-name";

/**
 * F-21 — the one rule for a person's name (src/lib/user-name.ts).
 *
 * Example tests pin the characters the rule is about; the property tests bound
 * the whole input space: whatever a provider or a caller sends, a stored name
 * never carries a control, bidi or invisible character, never exceeds the
 * bound, and the two entry points (refuse vs. sanitize) never store two
 * spellings of one accepted name.
 */

const MAX = USER_NAME_MAX_LENGTH;

/** Independent restatement of the forbidden set, so a regex typo cannot hide. */
function isForbidden(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x061c ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/** Every code point, lone surrogate halves included (a `for…of` yields them singly). */
function codePoints(value: string): number[] {
  return [...value].map((c) => c.codePointAt(0)!);
}

/** A stored name's shape: what every accepted or sanitized name must satisfy. */
function expectStorable(name: string): void {
  expect(codePoints(name).some(isForbidden)).toBe(false);
  expect(name.length).toBeLessThanOrEqual(MAX);
  expect(name).toBe(name.normalize("NFC"));
  expect(name).toBe(name.trim());
  // One space per run: U+0020, or a lone ideographic space kept as typed.
  expect(name).not.toMatch(/\s{2}|[^\S \u3000]/u);
}

// Characters the rule is about, mixed into ordinary text so the properties
// reach them far more often than uniform Unicode would.
const SPECIAL = [
  "\t",
  "\n",
  "\r",
  "\u0000",
  "\u007f",
  "\u0085",
  "\u00a0",
  "\u061c",
  "\u200b",
  "\u200c",
  "\u200d",
  "\u200e",
  "\u200f",
  "\u2028",
  "\u2029",
  "\u202a",
  "\u202e",
  "\u2060",
  "\u2066",
  "\u2069",
  "\u3000",
  "\ufeff",
  "\ud800",
  "\udfff",
  "\u0301",
  "\u0323",
  "\u093c",
  "\u0958",
  "\u11a8",
  "e",
  "\uac00",
  " ",
  "  ",
  "\u{1f600}",
  "\u{1f469}\u200d\u{1f4bb}",
];
const piece = fc.oneof(
  fc.constantFrom(...SPECIAL),
  fc.string({ unit: "binary", maxLength: 8 }),
  fc.string({ unit: "grapheme", maxLength: 8 }),
  fc.string({ unit: "grapheme-ascii", maxLength: 12 }),
);
const anyName = fc.oneof(
  fc.array(piece, { maxLength: 30 }).map((parts) => parts.join("")),
  // Long enough to cross the bound and exercise truncation.
  fc.array(piece, { minLength: 40, maxLength: 120 }).map((parts) => parts.join("")),
  fc.string({ unit: "binary", maxLength: 400 }),
);

describe("F-21: checkUserName (a name somebody typed)", () => {
  it("accepts an ordinary name and stores one canonical spelling", () => {
    expect(checkUserName("Ada Lovelace")).toEqual({ ok: true, name: "Ada Lovelace" });
    // Surrounding whitespace (a pasted trailing newline too) is not an error.
    expect(checkUserName("  Ada   Lovelace \n")).toEqual({ ok: true, name: "Ada Lovelace" });
    // A non-breaking space, and any run of two or more spaces, becomes one
    // ordinary space.
    expect(checkUserName("Ada\u00a0Lovelace")).toEqual({ ok: true, name: "Ada Lovelace" });
    expect(checkUserName("Ada\u00a0\u3000Lovelace")).toEqual({ ok: true, name: "Ada Lovelace" });
    // NFC: "e" + combining acute is stored as "é".
    expect(checkUserName("Rene\u0301e")).toEqual({ ok: true, name: "Ren\u00e9e" });
  });

  it("keeps a single ideographic space as typed (a ja/zh input method's space key)", () => {
    expect(checkUserName("\u5c71\u7530\u3000\u592a\u90ce")).toEqual({
      ok: true,
      name: "\u5c71\u7530\u3000\u592a\u90ce",
    });
    expect(sanitizeUserName("\u5c71\u7530\u3000\u592a\u90ce")).toBe(
      "\u5c71\u7530\u3000\u592a\u90ce",
    );
    // A run of them is still one ordinary space, and the edges are trimmed.
    expect(checkUserName("\u3000\u5c71\u7530\u3000\u3000\u592a\u90ce\u3000")).toEqual({
      ok: true,
      name: "\u5c71\u7530 \u592a\u90ce",
    });
    expect(sanitizeUserName("\u5c71\u7530\u3000\u200b\u3000\u592a\u90ce")).toBe(
      "\u5c71\u7530 \u592a\u90ce",
    );
  });

  it("keeps ZWNJ / ZWJ, which Hindi and emoji sequences need", () => {
    expect(checkUserName("\u0915\u094d\u200d\u0937")).toEqual({
      ok: true,
      name: "\u0915\u094d\u200d\u0937",
    });
    expect(checkUserName("\u092e\u0948\u0902\u200c\u0928\u0947")).toEqual({
      ok: true,
      name: "\u092e\u0948\u0902\u200c\u0928\u0947",
    });
    expect(checkUserName("Dev \u{1f469}\u200d\u{1f4bb}")).toEqual({
      ok: true,
      name: "Dev \u{1f469}\u200d\u{1f4bb}",
    });
  });

  it.each([
    ["a line break", "Ann\nLee"],
    ["a carriage return", "Ann\rLee"],
    ["a tab", "Ann\tLee"],
    ["NUL", "Ann\u0000Lee"],
    ["DEL", "Ann\u007fLee"],
    ["NEL", "Ann\u0085Lee"],
    ["a line separator", "Ann\u2028Lee"],
    ["a paragraph separator", "Ann\u2029Lee"],
    ["a right-to-left override", "Ann \u202egnp.exe"],
    ["a left-to-right embedding", "Ann\u202aLee"],
    ["a first-strong isolate", "Ann\u2068Lee\u2069"],
    ["a right-to-left mark", "Ann\u200fLee"],
    ["an Arabic letter mark", "Ann\u061cLee"],
    ["a zero-width space", "evil\u200b.example"],
    ["a word joiner", "Ann\u2060Lee"],
    ["an interior BOM", "Ann\ufeffLee"],
    ["a lone surrogate", "Ann\ud800Lee"],
    ["a bidi control at the edge", "\u202eAnn"],
  ])("refuses a name containing %s", (_label, raw) => {
    expect(checkUserName(raw)).toEqual({ ok: false, problem: "nameCharacters" });
  });

  it("refuses an empty or blank name", () => {
    expect(checkUserName("")).toEqual({ ok: false, problem: "required" });
    expect(checkUserName(" \n\t ")).toEqual({ ok: false, problem: "required" });
  });

  it(`bounds the name at ${MAX} UTF-16 units, counted after collapsing whitespace`, () => {
    expect(checkUserName("x".repeat(MAX))).toEqual({ ok: true, name: "x".repeat(MAX) });
    expect(checkUserName("x".repeat(MAX + 1))).toEqual({ ok: false, problem: "max" });
    expect(checkUserName("x".repeat(5_000_000))).toEqual({ ok: false, problem: "max" });
    const spaced = `${"x".repeat(MAX / 2)}     ${"x".repeat(MAX / 2 - 1)}`;
    expect(checkUserName(spaced)).toEqual({
      ok: true,
      name: `${"x".repeat(MAX / 2)} ${"x".repeat(MAX / 2 - 1)}`,
    });
  });

  it("does not by itself stop a lure (that is the email's job, see auth.ts)", () => {
    // The finding's own example is short and printable. The bound stops the
    // megabyte case and the control characters; greeting by the address
    // instead of an unproven name is what keeps this text out of the email.
    const lure =
      "Your payroll account is suspended. Re-confirm within 24h at https://evil.example/login - IT Security";
    expect(checkUserName(lure)).toEqual({ ok: true, name: lure });
  });
});

describe("F-21: sanitizeUserName (a name nobody can correct)", () => {
  it("turns line breaks into spaces and drops the other forbidden characters", () => {
    expect(sanitizeUserName("Ann\r\nLee")).toBe("Ann Lee");
    expect(sanitizeUserName("Ann\tLee")).toBe("Ann Lee");
    expect(sanitizeUserName("\u202eAnn\u2066 Lee\u2069\u0000")).toBe("Ann Lee");
    expect(sanitizeUserName("evil\u200b.example")).toBe("evil.example");
    expect(sanitizeUserName("Ann \u202e Lee")).toBe("Ann Lee");
  });

  it("truncates a provider's 5000-character name to the bound", () => {
    const name = sanitizeUserName(`${"Ann ".repeat(1250)}\n`);
    expect(name.length).toBeLessThanOrEqual(MAX);
    expect(name.startsWith("Ann Ann")).toBe(true);
    expectStorable(name);
  });

  it("never splits a surrogate pair at the bound", () => {
    const name = sanitizeUserName(`${"a".repeat(MAX - 1)}\u{1f600}tail`);
    expect(name).toBe("a".repeat(MAX - 1));
    expect(sanitizeUserName(`${"a".repeat(MAX - 2)}\u{1f600}tail`)).toBe(
      `${"a".repeat(MAX - 2)}\u{1f600}`,
    );
  });

  it("may leave nothing: the caller decides what an empty name means", () => {
    expect(sanitizeUserName("\u202e\u200b\n")).toBe("");
  });
});

describe("F-21: the rule's invariants over arbitrary input (properties)", () => {
  it("a sanitized name is always storable, and sanitizing is idempotent", () => {
    fc.assert(
      fc.property(anyName, (raw) => {
        const name = sanitizeUserName(raw);
        expectStorable(name);
        expect(sanitizeUserName(name)).toBe(name);
      }),
      { numRuns: 2000 },
    );
  });

  it("an accepted name is storable, re-accepted unchanged, and sanitizes to itself", () => {
    fc.assert(
      fc.property(anyName, (raw) => {
        const result = checkUserName(raw);
        if (!result.ok) return;
        expectStorable(result.name);
        expect(result.name).not.toBe("");
        expect(checkUserName(result.name)).toEqual(result);
        // One spelling whichever entry point stored it.
        expect(sanitizeUserName(raw)).toBe(result.name);
      }),
      { numRuns: 2000 },
    );
  });

  it("a refusal names the right reason", () => {
    fc.assert(
      fc.property(anyName, (raw) => {
        const result = checkUserName(raw);
        if (result.ok) return;
        const hasForbidden = codePoints(raw.trim()).some(isForbidden);
        if (result.problem === "nameCharacters") expect(hasForbidden).toBe(true);
        else expect(hasForbidden).toBe(false);
        if (result.problem === "required") expect(sanitizeUserName(raw)).toBe("");
        if (result.problem === "max") expect(sanitizeUserName(raw).length).toBeLessThanOrEqual(MAX);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("F-21: the zod fields the forms and routes share", () => {
  it("userNameSchema parses to the stored spelling and reports validation.* keys", () => {
    expect(userNameSchema.parse("  Ada   Lovelace ")).toBe("Ada Lovelace");
    const issues = (raw: string) =>
      userNameSchema.safeParse(raw).error?.issues.map((issue) => issue.message);
    expect(issues("Ann\nLee")).toEqual(["nameCharacters"]);
    expect(issues("   ")).toEqual(["required"]);
    expect(issues("x".repeat(MAX + 1))).toEqual(["max"]);
    // Required: the form's asterisk is derived from rejecting `undefined`.
    expect(userNameSchema.safeParse(undefined).success).toBe(false);
  });

  it("optionalUserNameSchema treats blank as no name and checks everything else", () => {
    expect(optionalUserNameSchema.parse("")).toBe("");
    expect(optionalUserNameSchema.parse("   ")).toBe("");
    expect(optionalUserNameSchema.parse(" Ada ")).toBe("Ada");
    expect(optionalUserNameSchema.safeParse("\u202eAda").error?.issues[0]?.message).toBe(
      "nameCharacters",
    );
    expect(optionalUserNameSchema.safeParse("x".repeat(MAX + 1)).success).toBe(false);
  });
});
