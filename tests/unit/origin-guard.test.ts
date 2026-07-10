import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TrustedOriginsModule from "@/lib/trusted-origins";
import { checkTrustedOrigin } from "@/lib/admin/origin-guard.server";

/**
 * Full-branch coverage for the admin CSRF origin guard (§4). The default test
 * env short-circuits the guard (NODE_ENV="test" → ok), so the REAL matching
 * logic — the part that actually defends production — is only reached by
 * temporarily setting NODE_ENV. `parseOrigin` is kept REAL (importActual);
 * only `getTrustedOrigins` is stubbed so we control the allow-list.
 */
const getTrusted = vi.fn<() => string[]>();

vi.mock("@/lib/trusted-origins", async () => {
  const actual = await vi.importActual<typeof TrustedOriginsModule>("@/lib/trusted-origins");
  return { ...actual, getTrustedOrigins: () => getTrusted() };
});

function req(method: string | undefined, headers: Record<string, string> = {}) {
  return { method, headers: new Headers(headers) };
}

const penv = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = penv.NODE_ENV;
const APP = "https://app.example.com";

beforeEach(() => {
  getTrusted.mockReset().mockReturnValue([]);
});
afterEach(() => {
  penv.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("checkTrustedOrigin", () => {
  it("passes safe methods (GET/HEAD/OPTIONS and default) without consulting the allow-list", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get", undefined]) {
      expect(checkTrustedOrigin(req(m))).toEqual({ ok: true });
    }
    expect(getTrusted).not.toHaveBeenCalled();
  });

  it("fails closed for an empty allow-list in production", () => {
    penv.NODE_ENV = "production";
    getTrusted.mockReturnValue([]);
    expect(checkTrustedOrigin(req("POST"))).toEqual({ ok: false, reason: "untrusted_origin" });
  });

  it("allows an empty allow-list outside production (dev harness)", () => {
    penv.NODE_ENV = "development";
    getTrusted.mockReturnValue([]);
    expect(checkTrustedOrigin(req("POST"))).toEqual({ ok: true });
  });

  it("bypasses the check under NODE_ENV=test even with an allow-list", () => {
    penv.NODE_ENV = "test";
    getTrusted.mockReturnValue([APP]);
    // No Origin header, yet ok — the test bypass fires before matching.
    expect(checkTrustedOrigin(req("DELETE"))).toEqual({ ok: true });
  });

  describe("real matching (production, allow-list set)", () => {
    beforeEach(() => {
      penv.NODE_ENV = "production";
      getTrusted.mockReturnValue([APP]);
    });

    it("accepts a matching Origin header", () => {
      expect(checkTrustedOrigin(req("POST", { origin: APP }))).toEqual({ ok: true });
    });

    it("falls back to the Referer origin when Origin is absent", () => {
      expect(checkTrustedOrigin(req("PATCH", { referer: `${APP}/admin/users` }))).toEqual({
        ok: true,
      });
    });

    it("rejects a request with neither Origin nor Referer as missing_origin", () => {
      expect(checkTrustedOrigin(req("PUT"))).toEqual({ ok: false, reason: "missing_origin" });
    });

    it("rejects an Origin outside the allow-list as untrusted_origin", () => {
      expect(checkTrustedOrigin(req("POST", { origin: "https://evil.example" }))).toEqual({
        ok: false,
        reason: "untrusted_origin",
      });
    });

    it("prefers Origin over Referer when both are present", () => {
      // A trusted Referer must not rescue an untrusted Origin.
      expect(
        checkTrustedOrigin(req("POST", { origin: "https://evil.example", referer: `${APP}/x` })),
      ).toEqual({ ok: false, reason: "untrusted_origin" });
    });
  });
});
