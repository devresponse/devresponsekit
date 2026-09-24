import { describe, expect, it } from "vitest";
import { USER_NAME_MAX_LENGTH } from "@/lib/user-name";
import { hasDisplayName, updateProfileSchema } from "@/lib/validation/account";

/**
 * The absent/null/value distinction on `displayName` is a CONTRACT of the
 * shared profile schema, not an implementation detail of the route (review
 * #187). `PATCH /api/account/profile` is a partial update, so:
 *
 *   - key absent → leave the stored value alone,
 *   - `null`     → clear it,
 *   - a string   → set it (trimmed).
 *
 * `?? null` cannot tell the first two apart, which is how a `{ name }`-only
 * PATCH silently wiped the display name. This suite pins both halves: that
 * Zod does not materialize the absent key, and that `hasDisplayName` reads
 * exactly that fact.
 */
describe("review #187: updateProfileSchema distinguishes absent from null", () => {
  it("does not materialize an OMITTED displayName", () => {
    const parsed = updateProfileSchema.parse({ name: "Ada" });
    expect("displayName" in parsed).toBe(false);
    expect(hasDisplayName(parsed)).toBe(false);
    // The trap the old route fell into: both cases collapse to `null` here.
    expect(parsed.displayName ?? null).toBeNull();
  });

  it("keeps an explicit null", () => {
    const parsed = updateProfileSchema.parse({ name: "Ada", displayName: null });
    expect(hasDisplayName(parsed)).toBe(true);
    expect(parsed.displayName).toBeNull();
  });

  it("keeps (and trims) a value", () => {
    const parsed = updateProfileSchema.parse({ name: "Ada", displayName: "  Ada L.  " });
    expect(hasDisplayName(parsed)).toBe(true);
    expect(parsed.displayName).toBe("Ada L.");
  });

  it("still rejects an unknown key and an over-long value", () => {
    expect(updateProfileSchema.safeParse({ name: "Ada", nope: 1 }).success).toBe(false);
    const tooLong = "x".repeat(USER_NAME_MAX_LENGTH + 1);
    expect(updateProfileSchema.safeParse({ name: "Ada", displayName: tooLong }).success).toBe(
      false,
    );
    expect(updateProfileSchema.safeParse({ name: tooLong }).success).toBe(false);
  });
});

/**
 * F-21: both fields follow the shared name rule (`user-name.ts`). The route
 * writes `name` to Better Auth and `displayName` to `app_users`, which the
 * invitation email quotes, so a control or bidi character is refused with the
 * `validation.nameCharacters` key rather than stored.
 */
describe("F-21: updateProfileSchema applies the shared name rule", () => {
  it("shares the sign-up bound (a name the sign-up accepted can be re-saved)", () => {
    const longest = "x".repeat(USER_NAME_MAX_LENGTH);
    expect(updateProfileSchema.parse({ name: longest, displayName: longest })).toEqual({
      name: longest,
      displayName: longest,
    });
  });

  it("refuses a control or bidi character in either field", () => {
    const messages = (input: unknown) =>
      updateProfileSchema.safeParse(input).error?.issues.map((issue) => issue.message);
    expect(messages({ name: "Ada\nLovelace" })).toEqual(["nameCharacters"]);
    expect(messages({ name: "Ada", displayName: "Ada \u202eL." })).toEqual(["nameCharacters"]);
  });

  it("stores the canonical spelling and keeps blank as no display name", () => {
    expect(
      updateProfileSchema.parse({ name: " Ada \u00a0 Lovelace ", displayName: "   " }),
    ).toEqual({
      name: "Ada Lovelace",
      displayName: "",
    });
  });
});
