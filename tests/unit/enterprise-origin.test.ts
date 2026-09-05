import { describe, it, expect, afterEach } from "vitest";
import {
  allowedOriginSuffixes,
  isAllowedEnterpriseOrigin,
} from "@/lib/admin/enterprise-apps.server";

// process.env types NODE_ENV as read-only; treat it as a plain string map.
const penv = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = penv.NODE_ENV;

afterEach(() => {
  delete process.env.SSO_ALLOWED_ORIGIN_SUFFIXES;
  delete process.env.NEXT_PUBLIC_PRODUCTION_HOST;
  penv.NODE_ENV = ORIGINAL_NODE_ENV;
});

/**
 * P2-5: an enterprise app's origin is the SSO handoff redirect target, so
 * an `admin.apps.manage` holder must not be able to point it at an
 * arbitrary origin they control.
 */
describe("isAllowedEnterpriseOrigin", () => {
  it("allows hosts at or under a configured suffix", () => {
    process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = "devresponse.com";
    expect(isAllowedEnterpriseOrigin("https://analytics.devresponse.com")).toBe(true);
    expect(isAllowedEnterpriseOrigin("https://devresponse.com")).toBe(true);
  });

  it("rejects an attacker-controlled origin (incl. suffix-spoofing)", () => {
    process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = "devresponse.com";
    expect(isAllowedEnterpriseOrigin("https://evil.com")).toBe(false);
    expect(isAllowedEnterpriseOrigin("https://devresponse.com.evil.com")).toBe(false);
    expect(isAllowedEnterpriseOrigin("https://notdevresponse.com")).toBe(false);
  });

  it("rejects non-HTTPS even under an allowed suffix", () => {
    process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = "devresponse.com";
    expect(isAllowedEnterpriseOrigin("http://app.devresponse.com")).toBe(false);
  });

  it("derives the suffix from NEXT_PUBLIC_PRODUCTION_HOST when unset", () => {
    process.env.NEXT_PUBLIC_PRODUCTION_HOST = "app.devresponse.com";
    expect(allowedOriginSuffixes()).toEqual(["devresponse.com"]);
    expect(isAllowedEnterpriseOrigin("https://portal.devresponse.com")).toBe(true);
  });

  it("fails closed when nothing is configured", () => {
    expect(allowedOriginSuffixes()).toEqual([]);
    expect(isAllowedEnterpriseOrigin("https://app.devresponse.com")).toBe(false);
  });
});

/**
 * Review #14: the allow-list itself must never be a bare TLD / public suffix
 * (an org admin could then register `https://attacker.co.uk` and harvest
 * handoff tokens), and production must not silently derive one.
 */
describe("allowedOriginSuffixes (review #14)", () => {
  describe("configured entries are validated", () => {
    it.each(["co.uk", "com", "github.io"])(
      "ignores the bare public suffix %s so no origin under it is registrable",
      (suffix) => {
        process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = suffix;
        expect(allowedOriginSuffixes()).toEqual([]);
        expect(isAllowedEnterpriseOrigin(`https://attacker.${suffix}`)).toBe(false);
      },
    );

    it("keeps the registrable entries of a mixed list and drops the rest", () => {
      process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = "co.uk, example.co.uk, devresponse.com, com";
      expect(allowedOriginSuffixes()).toEqual(["example.co.uk", "devresponse.com"]);
      expect(isAllowedEnterpriseOrigin("https://app.example.co.uk")).toBe(true);
      expect(isAllowedEnterpriseOrigin("https://portal.devresponse.com")).toBe(true);
      expect(isAllowedEnterpriseOrigin("https://attacker.co.uk")).toBe(false);
      expect(isAllowedEnterpriseOrigin("https://attacker.com")).toBe(false);
    });

    it("accepts localhost outside production (local satellite rig) but not in production", () => {
      process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = "devresponse.local,localhost";
      penv.NODE_ENV = "development";
      expect(allowedOriginSuffixes()).toEqual(["devresponse.local", "localhost"]);
      expect(isAllowedEnterpriseOrigin("https://localhost:8443")).toBe(true);

      penv.NODE_ENV = "production";
      expect(allowedOriginSuffixes()).toEqual(["devresponse.local"]);
      expect(isAllowedEnterpriseOrigin("https://localhost:8443")).toBe(false);
      expect(isAllowedEnterpriseOrigin("https://app1.devresponse.local")).toBe(true);
    });
  });

  describe("unset in production fails closed", () => {
    it("derives nothing from a multi-part-TLD host (previously yielded bare co.uk)", () => {
      penv.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_PRODUCTION_HOST = "app.example.co.uk";
      expect(allowedOriginSuffixes()).toEqual([]);
      expect(isAllowedEnterpriseOrigin("https://attacker.co.uk")).toBe(false);
      expect(isAllowedEnterpriseOrigin("https://app.example.co.uk")).toBe(false);
    });

    it("derives nothing even from a plain .com host — registration is denied", () => {
      penv.NODE_ENV = "production";
      process.env.NEXT_PUBLIC_PRODUCTION_HOST = "app.devresponse.com";
      expect(allowedOriginSuffixes()).toEqual([]);
      expect(isAllowedEnterpriseOrigin("https://portal.devresponse.com")).toBe(false);
    });

    it("still honours an explicit list in production", () => {
      penv.NODE_ENV = "production";
      process.env.SSO_ALLOWED_ORIGIN_SUFFIXES = "devresponse.com";
      expect(allowedOriginSuffixes()).toEqual(["devresponse.com"]);
      expect(isAllowedEnterpriseOrigin("https://portal.devresponse.com")).toBe(true);
    });
  });

  describe("unset outside production keeps deriving from the host", () => {
    it.each(["development", "test"])("derives the registrable domain under NODE_ENV=%s", (env) => {
      penv.NODE_ENV = env;
      process.env.NEXT_PUBLIC_PRODUCTION_HOST = "app.devresponse.com";
      expect(allowedOriginSuffixes()).toEqual(["devresponse.com"]);
      expect(isAllowedEnterpriseOrigin("https://portal.devresponse.com")).toBe(true);
    });

    it("derives the PSL registrable domain, never the bare public suffix", () => {
      penv.NODE_ENV = "development";
      process.env.NEXT_PUBLIC_PRODUCTION_HOST = "app.example.co.uk";
      expect(allowedOriginSuffixes()).toEqual(["example.co.uk"]);
      expect(isAllowedEnterpriseOrigin("https://portal.example.co.uk")).toBe(true);
      expect(isAllowedEnterpriseOrigin("https://attacker.co.uk")).toBe(false);
    });

    it("derives localhost from a loopback host", () => {
      penv.NODE_ENV = "development";
      process.env.NEXT_PUBLIC_PRODUCTION_HOST = "localhost:3000";
      expect(allowedOriginSuffixes()).toEqual(["localhost"]);
      expect(isAllowedEnterpriseOrigin("https://localhost:8443")).toBe(true);
    });

    it("derives nothing from a host that is itself a public suffix", () => {
      penv.NODE_ENV = "development";
      process.env.NEXT_PUBLIC_PRODUCTION_HOST = "co.uk";
      expect(allowedOriginSuffixes()).toEqual([]);
      expect(isAllowedEnterpriseOrigin("https://attacker.co.uk")).toBe(false);
    });
  });
});
