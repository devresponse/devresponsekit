import { describe, expect, it } from "vitest";
import {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isHttpsOrigin,
} from "@/lib/admin/enterprise-apps.server";

/**
 * Unit tests for the enterprise-apps validator helpers
 * (docs/admin-manager.md §8.7). The route handlers and the
 * client form both consume these helpers, so pinning the rules here
 * means a regression in either layer surfaces immediately.
 */
describe("enterprise-apps validators", () => {
  describe("SUBDOMAIN_RE", () => {
    it.each(["a", "docs", "my-app", "my-app-1", "abc123", "a".repeat(63)])("accepts %s", (s) => {
      expect(SUBDOMAIN_RE.test(s)).toBe(true);
    });

    it.each(["", "-leading", "trailing-", "UPPER", "with_underscore", "with.dot", "a".repeat(64)])(
      "rejects %s",
      (s) => {
        expect(SUBDOMAIN_RE.test(s)).toBe(false);
      },
    );
  });

  describe("APP_ID_RE", () => {
    it.each(["docs", "devresponse-docs", "v1.app", "my_app", "a"])("accepts %s", (s) => {
      expect(APP_ID_RE.test(s)).toBe(true);
    });

    it.each(["", "-leading", "Upper", "has space", "a".repeat(129)])("rejects %s", (s) => {
      expect(APP_ID_RE.test(s)).toBe(false);
    });
  });

  describe("SSO_AUDIENCE_RE", () => {
    it.each(["devresponse-app:docs", "audience", "v1:my.app"])("accepts %s", (s) => {
      expect(SSO_AUDIENCE_RE.test(s)).toBe(true);
    });

    it.each(["", "Upper", "has space"])("rejects %s", (s) => {
      expect(SSO_AUDIENCE_RE.test(s)).toBe(false);
    });
  });

  describe("isHttpsOrigin", () => {
    it.each([
      "https://example.com",
      "https://example.com/",
      "https://docs.example.com",
      "https://localhost:8443",
    ])("accepts %s", (s) => {
      expect(isHttpsOrigin(s)).toBe(true);
    });

    it.each([
      "",
      "http://example.com",
      "https://example.com/path",
      "https://example.com/?q=1",
      "https://example.com#hash",
      "ftp://example.com",
      "not-a-url",
    ])("rejects %s", (s) => {
      expect(isHttpsOrigin(s)).toBe(false);
    });
  });

  it("APP_STATUS_VALUES is the closed set the schema accepts", () => {
    expect(APP_STATUS_VALUES).toEqual(["available", "disabled"]);
  });
});
