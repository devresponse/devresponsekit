import { describe, expect, it } from "vitest";
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
    expect(
      updateProfileSchema.safeParse({ name: "Ada", displayName: "x".repeat(121) }).success,
    ).toBe(false);
  });
});
