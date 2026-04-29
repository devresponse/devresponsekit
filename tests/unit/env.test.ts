import { describe, expect, it } from "vitest";
import type * as EnvModule from "@/lib/env";
import { getServerEnv } from "@/lib/env";

/**
 * Unit tests for `env.ts`. The module caches the parsed env after the
 * first successful call, so most tests exercise the success path
 * (vitest setup populates the required vars). One test forces a parse
 * failure by clearing a required var and invalidating the module cache.
 */
describe("getServerEnv", () => {
  it("returns a parsed env object with defaults applied", () => {
    const env = getServerEnv();
    expect(env.NODE_ENV).toBe("test");
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(16);
    expect(env.SSO_HANDOFF_TTL_SECONDS).toBeGreaterThan(0);
    expect(env.SEED_DEFAULT_ORGANIZATION_SLUG).toBe("default");
  });

  it("caches the parsed env on subsequent calls", () => {
    const a = getServerEnv();
    const b = getServerEnv();
    expect(a).toBe(b);
  });

  it("throws with invalid_keys list when a required variable is missing", async () => {
    // Re-import the module fresh so the internal cache is empty.
    const original = process.env.SSO_HANDOFF_JWT_SECRET;
    delete process.env.SSO_HANDOFF_JWT_SECRET;
    // Use a query-string suffix on the import specifier so vitest treats
    // it as a distinct module and does not return the already-cached one.
    const fresh = (await import("@/lib/env" + "?fresh")) as typeof EnvModule;
    try {
      expect(() => fresh.getServerEnv()).toThrow(/SSO_HANDOFF_JWT_SECRET/);
    } finally {
      process.env.SSO_HANDOFF_JWT_SECRET = original;
    }
  });
});
