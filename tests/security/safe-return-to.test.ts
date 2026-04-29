import { describe, expect, it } from "vitest";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Security-focused open-redirect tests for `getSafeReturnTo` (§29.7.1–4).
 *
 * The unit tests under `tests/unit/safe-return-to.test.ts` cover the happy
 * path; this file enumerates known phishing/return-URL bypass tricks and
 * locks the helper down so future refactors cannot regress them.
 */
describe("safe-return-to security", () => {
  const FALLBACK = "/en/app/dashboard";

  it.each([
    "https://evil.example.com/x",
    "http://evil.example.com",
    "HTTPS://evil.example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("rejects absolute or scheme-bearing URL %s", (input) => {
    expect(getSafeReturnTo(input)).toBe(FALLBACK);
  });

  it.each([
    "//evil.example.com",
    "//evil.example.com/foo",
    "//evil.example.com\\@good.example.com",
  ])("rejects protocol-relative URL %s", (input) => {
    expect(getSafeReturnTo(input)).toBe(FALLBACK);
  });

  it.each(["/\\evil.example.com", "/foo\\bar", "/en/app/dashboard\\@evil.example.com"])(
    "rejects backslash-smuggled URL %s",
    (input) => {
      expect(getSafeReturnTo(input)).toBe(FALLBACK);
    },
  );

  it.each(["/api/secret", "/api/sso/launch?applicationId=evil", "/api/auth/sign-in"])(
    "rejects API-route returnTo %s",
    (input) => {
      expect(getSafeReturnTo(input)).toBe(FALLBACK);
    },
  );

  it.each([
    "/en/sign-in",
    "/en/sign-up",
    "/en/forgot-password",
    "/en/blocked",
    "/en/pending-approval",
    "/en/logged-out",
  ])("rejects auth/status page %s", (input) => {
    expect(getSafeReturnTo(input)).toBe(FALLBACK);
  });

  it("rejects URLs whose first path segment is not a supported locale", () => {
    expect(getSafeReturnTo("/admin")).toBe(FALLBACK);
    expect(getSafeReturnTo("/sign-in")).toBe(FALLBACK);
    expect(getSafeReturnTo("/zz/app/dashboard")).toBe(FALLBACK);
  });

  it("ignores non-string types coerced through the helper signature", () => {
    expect(getSafeReturnTo(undefined)).toBe(FALLBACK);
    expect(getSafeReturnTo(null)).toBe(FALLBACK);
  });

  it("preserves an explicit caller-supplied locale when falling back", () => {
    expect(getSafeReturnTo(null, "fr")).toBe("/fr/app/dashboard");
    expect(getSafeReturnTo("/api/x", "uk")).toBe("/uk/app/dashboard");
  });

  it("accepts genuine localized browser paths and leaves them intact", () => {
    expect(getSafeReturnTo("/en/app/workspace")).toBe("/en/app/workspace");
    expect(getSafeReturnTo("/en/app/admin/users")).toBe("/en/app/admin/users");
  });
});
