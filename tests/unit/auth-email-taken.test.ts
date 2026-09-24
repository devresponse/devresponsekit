import { describe, expect, it } from "vitest";
import { APIError } from "better-auth/api";
import { isAuthEmailTakenError } from "@/lib/admin/auth-email-taken";

/**
 * F-30 — `isAuthEmailTakenError` decides whether a failed Better Auth create
 * is the documented 409 (the address is already held) or a 502. The shapes
 * here are the ones better-auth 1.7 raises; tests/db/user-create-failure-audit
 * .db.test.ts produces both for real against Postgres.
 */
describe("isAuthEmailTakenError", () => {
  it("recognises the admin plugin's refusal (USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL)", () => {
    const err = new APIError("BAD_REQUEST", {
      message: "User already exists. Use another email.",
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
    });
    expect(isAuthEmailTakenError(err)).toBe(true);
  });

  it("recognises the core's USER_ALREADY_EXISTS, the same refusal on the sign-up path", () => {
    const err = new APIError("UNPROCESSABLE_ENTITY", {
      message: "User already exists.",
      code: "USER_ALREADY_EXISTS",
    });
    expect(isAuthEmailTakenError(err)).toBe(true);
  });

  it("recognises the raw unique violation a concurrent create's loser gets from Postgres", () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "user_email_key"'),
      {
        code: "23505",
        constraint: "user_email_key",
        table: "user",
      },
    );
    expect(isAuthEmailTakenError(err)).toBe(true);
  });

  it("is structural, so a plain object with the plugin's body counts too", () => {
    expect(isAuthEmailTakenError({ body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" } })).toBe(
      true,
    );
  });

  it.each([
    [
      "another Better Auth refusal",
      new APIError("BAD_REQUEST", { message: "Password too short", code: "PASSWORD_TOO_SHORT" }),
    ],
    [
      "a unique violation on a key that is not the email",
      Object.assign(new Error("duplicate key"), { code: "23505", constraint: "user_pkey" }),
    ],
    [
      "a unique violation with no constraint name",
      Object.assign(new Error("dup"), { code: "23505" }),
    ],
    [
      "another SQLSTATE on the email key",
      Object.assign(new Error("fk"), { code: "23503", constraint: "user_email_key" }),
    ],
    ["a connection failure", new Error("connection reset")],
    ["a body whose code is not a string", { body: { code: 409 } }],
    ["null", null],
    ["a string", "USER_ALREADY_EXISTS"],
  ])("is false for %s (a 502, not a 409)", (_label, err) => {
    expect(isAuthEmailTakenError(err)).toBe(false);
  });
});
