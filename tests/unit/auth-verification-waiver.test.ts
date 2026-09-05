import { describe, expect, it } from "vitest";
import {
  EMAIL_VERIFICATION_WAIVED_FIELD,
  EMAIL_VERIFICATION_WAIVED_USER_FIELD,
  isEmailVerificationWaived,
} from "@/lib/auth-verification-waiver";

/**
 * Review 2026-09-04 #2 — the policy-waived verification marker.
 *
 * The field definition is what makes the marker trustworthy: `input: false`
 * means Better Auth discards any client-supplied value (the hook is the only
 * writer) and `defaultValue: false` means every other creation path records
 * "not waived". The reader must treat anything but a literal `true` as not
 * waived — including `null` from rows created before the column existed.
 */
describe("EMAIL_VERIFICATION_WAIVED_USER_FIELD", () => {
  it("is a server-only boolean that defaults to false", () => {
    expect(EMAIL_VERIFICATION_WAIVED_FIELD).toBe("emailVerificationWaived");
    expect(EMAIL_VERIFICATION_WAIVED_USER_FIELD).toEqual({
      type: "boolean",
      required: false,
      defaultValue: false,
      input: false,
    });
  });
});

describe("isEmailVerificationWaived", () => {
  it("is true only for a literal true marker", () => {
    expect(isEmailVerificationWaived({ emailVerificationWaived: true })).toBe(true);
  });

  it("is false for false, null (legacy row), absent, or non-boolean values", () => {
    expect(isEmailVerificationWaived({ emailVerificationWaived: false })).toBe(false);
    expect(isEmailVerificationWaived({ emailVerificationWaived: null })).toBe(false);
    expect(isEmailVerificationWaived({ emailVerified: true })).toBe(false);
    expect(isEmailVerificationWaived({ emailVerificationWaived: "true" })).toBe(false);
    expect(isEmailVerificationWaived({ emailVerificationWaived: 1 })).toBe(false);
  });

  it("is false for a missing or non-object user", () => {
    expect(isEmailVerificationWaived(undefined)).toBe(false);
    expect(isEmailVerificationWaived(null)).toBe(false);
    expect(isEmailVerificationWaived("user")).toBe(false);
  });
});
