import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  APP_ID_RE,
  APP_STATUS_VALUES,
  SSO_AUDIENCE_RE,
  SUBDOMAIN_RE,
  isConsumableAudienceFor,
  isHttpsOrigin,
  isOrgNamespacedAppId,
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

  // R15: the audiences a satellite running as app `acme.crm` can consume. Its
  // consume route accepts only `${SSO_HANDOFF_AUDIENCE_PREFIX}:acme.crm`.
  describe("isConsumableAudienceFor", () => {
    it.each(["devresponse-app:acme.crm", "sso:acme.crm", "a.b-c_d:acme.crm"])(
      "app acme.crm can consume %s",
      (aud) => {
        expect(isConsumableAudienceFor(aud, "acme.crm")).toBe(true);
      },
    );

    it.each([
      "acme.crm", // no prefix at all: the whole audience passed the I-01 check
      ":acme.crm", // an empty prefix
      "x:acme.other", // another id in the same namespace, also passed I-01
      "devresponse-app:crm", // a global app's audience
      "a:b:acme.crm", // a prefix holding a colon
      "dev app:acme.crm", // a prefix holding whitespace
      "devresponse-app:acme.crm.v2", // the id is the whole last segment
      "devresponse-app:xacme.crm",
      "devresponse-app:acme.crm:x",
    ])("app acme.crm cannot consume %s", (aud) => {
      expect(isConsumableAudienceFor(aud, "acme.crm")).toBe(false);
    });

    it("no audience is consumable for an empty id", () => {
      expect(isConsumableAudienceFor("devresponse-app:", "")).toBe(false);
    });

    // The production platform apps (seeded placeholders) carry audiences whose
    // last segment is not their id; only a superadmin, who is not held to this
    // rule, registers such a row.
    it("the platform app devresponse-portal cannot consume devresponse-app:portal", () => {
      expect(isConsumableAudienceFor("devresponse-app:portal", "devresponse-portal")).toBe(false);
    });

    const appId = fc.stringMatching(APP_ID_RE);
    const prefix = fc.string({ minLength: 1 }).filter((p) => !/[:\s]/.test(p));

    it("accepts any prefix without a colon or whitespace, a colon and the id (property)", () => {
      fc.assert(
        fc.property(prefix, appId, (p, id) => {
          expect(isConsumableAudienceFor(`${p}:${id}`, id)).toBe(true);
        }),
      );
    });

    it("refuses the id alone, an empty prefix, or a prefix with a colon or whitespace (property)", () => {
      fc.assert(
        fc.property(prefix, appId, fc.constantFrom(":", " ", "\t"), (p, id, bad) => {
          expect(isConsumableAudienceFor(id, id)).toBe(false);
          expect(isConsumableAudienceFor(`:${id}`, id)).toBe(false);
          expect(isConsumableAudienceFor(`${p}${bad}x:${id}`, id)).toBe(false);
        }),
      );
    });

    it("refuses an audience whose last segment is another id (property)", () => {
      fc.assert(
        fc.property(prefix, appId, appId, (p, id, other) => {
          fc.pre(other !== id);
          expect(isConsumableAudienceFor(`${p}:${other}`, id)).toBe(false);
        }),
      );
    });
  });

  it("APP_STATUS_VALUES is the closed set the schema accepts", () => {
    expect(APP_STATUS_VALUES).toEqual(["available", "disabled"]);
  });
});
