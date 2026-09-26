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

  /**
   * I-17: the checks above read the raw string, but the browser resolves dot
   * segments (and deletes tabs and line breaks) before it navigates, so each
   * of these used to pass the sanitizer and then land on a path it refuses.
   */
  it.each([
    "/en/../api/preferences/active-org/apply?org=other",
    "/en/../api/administrator/export/users",
    "/en/%2e%2e/api/administrator/users",
    "/en/%2E%2E/api/x",
    "/en/.%2e/api/x",
    "/en/%2e./api/x",
    "/en/app/../../api/x",
    "/en/./sign-in",
    "/en/%2e/sign-up",
    "/en/app/../sign-in",
    "/en/..//evil.example.com",
    "/en/.\t./api/x",
    "/en/sign\t-in",
    "/en/sign\n-in",
    "/en/app/x/..",
    "/en/app/x/.",
  ])("rejects a path the browser would resolve elsewhere: %j", (input) => {
    expect(getSafeReturnTo(input)).toBe(FALLBACK);
  });

  it.each([
    "/en/app/administrator/users/a.b",
    "/en/app/docs/v1.2/setup",
    "/en/app/.well-known",
    "/en/app/.../x",
    "/en/app/x?next=/en/../api/y",
    "/en/app/x#../../api/y",
  ])("keeps a dot that is not a dot segment, or sits outside the path: %j", (input) => {
    expect(getSafeReturnTo(input)).toBe(input);
  });

  /**
   * I-17: the page segment is judged without the query or the fragment, which
   * select nothing the browser routes on, and the URL parser strips a trailing
   * space or C0 control. Each of these used to come back unchanged and land on
   * the sign-in or blocked page. DEL, C1 and an encoded `/` or `\` in the path
   * are refused because Better Auth refuses them as a `callbackURL`.
   */
  it.each([
    "/en/sign-in?x=1",
    "/en/sign-in#x",
    "/en/blocked?y",
    "/en/sign-up?returnTo=%2Fen%2Fapp",
    "/en/sign-in ",
    "/en/sign-in\u0000",
    "/en/sign-in\u001f",
    "/en/app/dashboard ",
    "/en/app/x\u007f",
    "/en/app/x\u0085",
    "/en/app/a%2Fb",
    "/en/app/a%5cb",
  ])(
    "rejects a value that resolves onto a refused page or that Better Auth refuses: %j",
    (input) => {
      expect(getSafeReturnTo(input)).toBe(FALLBACK);
    },
  );

  it.each(["/en/app/x?next=%2Fen%2Fapp", "/en/app/search?q=a b", "/en/app/x#sign-in"])(
    "keeps an encoded separator, a space or a page name outside the path: %j",
    (input) => {
      expect(getSafeReturnTo(input)).toBe(input);
    },
  );

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
