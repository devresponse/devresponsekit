import { describe, expect, it } from "vitest";
import {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isHttpsOrigin,
  isOrgNamespacedAppId,
  isOrgNamespacedAudience,
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

  // I-01: the names an org admin may claim, under its org's slug `acme`.
  describe("isOrgNamespacedAppId", () => {
    it.each(["acme.crm", "acme.crm.v2", "acme.a", "acme.x-y_z"])("acme owns %s", (id) => {
      expect(isOrgNamespacedAppId(id, "acme")).toBe(true);
    });

    it.each([
      "crm", // a global name
      "acme", // the bare slug
      "acme.", // nothing after the separator
      "acme-crm", // a hyphen is not the separator
      "acme-corp.crm", // org `acme-corp`'s namespace, not `acme`'s
      "acmecorp.crm",
      "x.acme.crm",
    ])("acme does not own %s", (id) => {
      expect(isOrgNamespacedAppId(id, "acme")).toBe(false);
    });

    it("gives org acme-corp its own namespace", () => {
      expect(isOrgNamespacedAppId("acme-corp.crm", "acme-corp")).toBe(true);
      expect(isOrgNamespacedAppId("acme.crm", "acme-corp")).toBe(false);
    });
  });

  describe("isOrgNamespacedAudience", () => {
    it.each(["devresponse-app:acme.crm", "acme.crm", "a:b:acme.crm"])("acme owns %s", (aud) => {
      expect(isOrgNamespacedAudience(aud, "acme")).toBe(true);
    });

    it.each([
      "devresponse-app:crm", // the audience of a global app
      "crm",
      "acme.crm:crm", // only the last segment names the app
      "devresponse-app:acme.",
      "devresponse-app:acme-corp.crm",
      "acme:crm",
    ])("acme does not own %s", (aud) => {
      expect(isOrgNamespacedAudience(aud, "acme")).toBe(false);
    });
  });

  it("APP_STATUS_VALUES is the closed set the schema accepts", () => {
    expect(APP_STATUS_VALUES).toEqual(["available", "disabled"]);
  });
});
