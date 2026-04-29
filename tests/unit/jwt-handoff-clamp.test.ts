import { describe, expect, it } from "vitest";
import { clampSsoHandoffTtl, SSO_HANDOFF_MAX_TTL_SECONDS } from "@/lib/jwt-handoff.server";

describe("clampSsoHandoffTtl", () => {
  it("returns 1 for non-positive inputs", () => {
    expect(clampSsoHandoffTtl(0)).toBe(1);
    expect(clampSsoHandoffTtl(-50)).toBe(1);
  });

  it("clamps to the documented 60 second maximum", () => {
    expect(SSO_HANDOFF_MAX_TTL_SECONDS).toBe(60);
    expect(clampSsoHandoffTtl(60)).toBe(60);
    expect(clampSsoHandoffTtl(61)).toBe(60);
    expect(clampSsoHandoffTtl(60_000)).toBe(60);
  });

  it("passes through values inside the safe range", () => {
    expect(clampSsoHandoffTtl(1)).toBe(1);
    expect(clampSsoHandoffTtl(30)).toBe(30);
    expect(clampSsoHandoffTtl(45)).toBe(45);
  });
});
