import { describe, expect, it } from "vitest";
import {
  USER_NAME_INPUT_PATHS,
  boundedUserName,
  isUserNameInputCall,
  resetEmailGreetingName,
} from "@/lib/auth-user-name";
import { EMAIL_VERIFICATION_WAIVED_FIELD } from "@/lib/auth-verification-waiver";

/**
 * F-21: the pure pieces of Better Auth's side of the name rule
 * (src/lib/auth-user-name.ts). The hook and the email callbacks are driven
 * through the real auth instance in
 * tests/security/auth-user-name-bound.test.ts.
 */

describe("F-21: isUserNameInputCall", () => {
  it("matches exactly the two endpoints that take a caller-chosen name", () => {
    expect(USER_NAME_INPUT_PATHS).toEqual(["/sign-up/email", "/update-user"]);
    for (const path of USER_NAME_INPUT_PATHS) expect(isUserNameInputCall({ path })).toBe(true);
    for (const path of ["/sign-in/email", "/admin/create-user", "/sign-up/email/x", undefined]) {
      expect(isUserNameInputCall({ path })).toBe(false);
    }
  });
});

describe("F-21: boundedUserName (the database hooks)", () => {
  it("bounds a name and leaves a write without one alone", () => {
    expect(boundedUserName({ name: "Ann\nLee" })).toEqual({ name: "Ann Lee" });
    expect(boundedUserName({ name: "x".repeat(5000) }).name).toHaveLength(200);
    // `/update-user` passes `name: undefined` when only other fields change.
    expect(boundedUserName({ name: undefined, image: "x" })).toEqual({});
    expect(boundedUserName({ banned: true })).toEqual({});
    expect(boundedUserName({ name: null })).toEqual({});
  });
});

describe("F-21: resetEmailGreetingName", () => {
  const base = { email: "owner@example.com", name: "Ada Lovelace" };

  it("uses the name only for a proven address", () => {
    expect(resetEmailGreetingName({ ...base, emailVerified: true })).toBe("Ada Lovelace");
    expect(resetEmailGreetingName({ ...base, emailVerified: false })).toBe(base.email);
    expect(resetEmailGreetingName({ ...base })).toBe(base.email);
    expect(resetEmailGreetingName({ ...base, emailVerified: null })).toBe(base.email);
  });

  it("treats a waived verification as unproven", () => {
    expect(
      resetEmailGreetingName({
        ...base,
        emailVerified: true,
        [EMAIL_VERIFICATION_WAIVED_FIELD]: true,
      } as Parameters<typeof resetEmailGreetingName>[0]),
    ).toBe(base.email);
  });

  it("falls back to the address when a proven account has no name", () => {
    expect(resetEmailGreetingName({ ...base, name: "", emailVerified: true })).toBe(base.email);
    expect(resetEmailGreetingName({ ...base, name: null, emailVerified: true })).toBe(base.email);
  });
});
