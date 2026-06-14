import { describe, it, expect, afterEach } from "vitest";
import {
  allowedOriginSuffixes,
  isAllowedEnterpriseOrigin,
} from "@/lib/admin/enterprise-apps.server";

afterEach(() => {
  delete process.env.SSO_ALLOWED_ORIGIN_SUFFIXES;
  delete process.env.NEXT_PUBLIC_PRODUCTION_HOST;
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
