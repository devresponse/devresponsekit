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

describe("F-03: refuseLinkIntoUnprovenAccount", () => {
  it("refuses a local account whose email has no mailbox proof", async () => {
    const { refuseLinkIntoUnprovenAccount, UNPROVEN_EMAIL_LINK_REJECTION } =
      await import("@/lib/auth-verification-waiver");
    expect(refuseLinkIntoUnprovenAccount({ emailVerificationWaived: true })).toBe(
      UNPROVEN_EMAIL_LINK_REJECTION,
    );
  });

  it("refuses when the local account cannot be found (fail closed)", async () => {
    const { refuseLinkIntoUnprovenAccount } = await import("@/lib/auth-verification-waiver");
    expect(refuseLinkIntoUnprovenAccount(null)).toBeTruthy();
  });

  it("allows a proven account (marker absent or false)", async () => {
    const { refuseLinkIntoUnprovenAccount } = await import("@/lib/auth-verification-waiver");
    expect(refuseLinkIntoUnprovenAccount({ emailVerificationWaived: false })).toBeUndefined();
    expect(refuseLinkIntoUnprovenAccount({ id: "u" })).toBeUndefined();
  });

  it("reuses Better Auth's own refusal code", async () => {
    const { UNPROVEN_EMAIL_LINK_REJECTION } = await import("@/lib/auth-verification-waiver");
    expect(UNPROVEN_EMAIL_LINK_REJECTION.error).toBe("account_not_linked");
  });
});

describe("F-03: validateUserInfoForLinking only gates provider LINKING", () => {
  const ctx = (user: unknown) =>
    ({ context: { internalAdapter: { findUserById: async () => user } } }) as never;

  it.each(["create-user", "sign-in"] as const)("passes %s untouched", async (action) => {
    const { validateUserInfoForLinking } = await import("@/lib/auth-verification-waiver");
    const result = await validateUserInfoForLinking(
      { user: { id: "u1" }, source: { action, method: "oauth", oauth: { providerId: "google" } } },
      ctx({ emailVerificationWaived: true }),
    );
    expect(result).toBeUndefined();
  });

  it("refuses link-account into an unproven account", async () => {
    const { validateUserInfoForLinking } = await import("@/lib/auth-verification-waiver");
    const result = await validateUserInfoForLinking(
      {
        user: { id: "u1" },
        source: { action: "link-account", method: "oauth", oauth: { providerId: "google" } },
      },
      ctx({ emailVerificationWaived: true }),
    );
    expect(result).toMatchObject({ error: "account_not_linked" });
  });
});
