import { describe, expect, it } from "vitest";
import {
  checkOriginSuffix,
  invalidOriginSuffixes,
  normalizeOriginSuffix,
  registrableDomainOf,
  splitOriginSuffixList,
} from "@/lib/admin/origin-suffixes";

/**
 * Review #14: an `SSO_ALLOWED_ORIGIN_SUFFIXES` entry that is a bare TLD or a
 * public-suffix entry would let an `admin.apps.manage` holder register a
 * token-harvesting origin anyone can obtain under it. Every entry must be a
 * registrable domain (≥1 label beyond the PSL public suffix, ICANN + PRIVATE
 * sections).
 */
describe("checkOriginSuffix", () => {
  it.each(["com", "uk", "io", "local"])("rejects the bare TLD %s", (s) => {
    expect(checkOriginSuffix(s)).toEqual({ ok: false, reason: "public_suffix" });
  });

  it.each(["co.uk", "com.au", "gov.uk"])("rejects the multi-label ICANN public suffix %s", (s) => {
    expect(checkOriginSuffix(s)).toEqual({ ok: false, reason: "public_suffix" });
  });

  it.each(["github.io", "vercel.app", "herokuapp.com"])(
    "rejects the PRIVATE-section public suffix %s (shared hosting)",
    (s) => {
      expect(checkOriginSuffix(s)).toEqual({ ok: false, reason: "public_suffix" });
    },
  );

  it.each([
    "devresponse.com",
    "example.co.uk",
    "apps.devresponse.com",
    "devresponse.ca",
    "devresponse.local",
    "xn--80ak6aa92e.com",
    "someone.github.io",
  ])("accepts the registrable domain %s", (s) => {
    expect(checkOriginSuffix(s)).toEqual({ ok: true });
  });

  it.each(["10.0.0.1", "0.1", "127.0.0.1"])("rejects the IP-ish entry %s", (s) => {
    expect(checkOriginSuffix(s)).toEqual({ ok: false, reason: "ip_address" });
  });

  it.each([
    "",
    "https://foo.example.com",
    "example.com:3000",
    "example.com/path",
    "*.example.com",
    "foo_bar.example.com",
    "-bad.example.com",
    "a..b.com",
    "Example.COM",
  ])("rejects the non-hostname entry %j", (s) => {
    expect(checkOriginSuffix(s)).toEqual({ ok: false, reason: "invalid_hostname" });
  });

  it("accepts localhost only when explicitly allowed (non-production rig)", () => {
    expect(checkOriginSuffix("localhost")).toEqual({
      ok: false,
      reason: "localhost_not_allowed",
    });
    expect(checkOriginSuffix("localhost", { allowLocalhost: true })).toEqual({ ok: true });
    // a bare TLD stays rejected even with the localhost escape hatch
    expect(checkOriginSuffix("com", { allowLocalhost: true })).toEqual({
      ok: false,
      reason: "public_suffix",
    });
  });
});

describe("splitOriginSuffixList / normalizeOriginSuffix", () => {
  it("trims, strips surrounding dots, lowercases, dedupes and drops blanks", () => {
    expect(normalizeOriginSuffix("  .Example.COM. ")).toBe("example.com");
    expect(splitOriginSuffixList(" devresponse.com, .Example.co.uk ,, devresponse.com ")).toEqual([
      "devresponse.com",
      "example.co.uk",
    ]);
  });

  it("treats unset / blank as an empty list", () => {
    expect(splitOriginSuffixList(undefined)).toEqual([]);
    expect(splitOriginSuffixList("")).toEqual([]);
    expect(splitOriginSuffixList(" , ")).toEqual([]);
  });
});

describe("invalidOriginSuffixes", () => {
  it("returns only the offending entries of a mixed list", () => {
    expect(invalidOriginSuffixes("devresponse.com,co.uk,example.co.uk,com,github.io")).toEqual([
      "co.uk",
      "com",
      "github.io",
    ]);
  });

  it("is empty for a clean list and for an unset value", () => {
    expect(invalidOriginSuffixes("devresponse.com,example.co.uk")).toEqual([]);
    expect(invalidOriginSuffixes(undefined)).toEqual([]);
  });

  it("honours the localhost option", () => {
    expect(invalidOriginSuffixes("devresponse.local,localhost")).toEqual(["localhost"]);
    expect(invalidOriginSuffixes("devresponse.local,localhost", { allowLocalhost: true })).toEqual(
      [],
    );
  });
});

describe("registrableDomainOf", () => {
  it("returns the PSL registrable domain of a deployment host", () => {
    expect(registrableDomainOf("app.devresponse.com")).toBe("devresponse.com");
    expect(registrableDomainOf("devresponse.com")).toBe("devresponse.com");
    // The old last-two-labels derivation produced the bare suffix `co.uk` here.
    expect(registrableDomainOf("app.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomainOf("APP.Devresponse.Local")).toBe("devresponse.local");
  });

  it("maps a loopback host to localhost and everything else without a parent to null", () => {
    expect(registrableDomainOf("localhost")).toBe("localhost");
    expect(registrableDomainOf("localhost:3000")).toBe("localhost");
    expect(registrableDomainOf("co.uk")).toBeNull();
    expect(registrableDomainOf("github.io")).toBeNull();
    expect(registrableDomainOf("10.0.0.1")).toBeNull();
    expect(registrableDomainOf("")).toBeNull();
  });
});
