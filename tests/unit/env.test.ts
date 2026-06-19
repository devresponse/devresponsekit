import { afterEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";
import { getServerEnv, intFromEnv } from "@/lib/env";

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

  it("fails at boot when SSO_HANDOFF_APPLICATION_ID is missing (P3-6)", async () => {
    // The consume endpoint needs prefix + app id together to compute the
    // expected audience; a missing app id must fail at boot, not first handoff.
    const original = process.env.SSO_HANDOFF_APPLICATION_ID;
    delete process.env.SSO_HANDOFF_APPLICATION_ID;
    const fresh = (await import("@/lib/env" + "?fresh-appid")) as typeof EnvModule;
    try {
      expect(() => fresh.getServerEnv()).toThrow(/SSO_HANDOFF_APPLICATION_ID/);
    } finally {
      process.env.SSO_HANDOFF_APPLICATION_ID = original;
    }
  });
});

/**
 * Loads a fresh copy of the env module with `patch` applied to process.env
 * (a value of `undefined` deletes the key), returning the module plus a
 * `restore()` to undo the changes. `CI` is cleared unless the patch sets it,
 * because GitHub Actions sets `CI=true` ambiently and several cases below
 * assert the non-CI behavior. `vi.resetModules()` busts the module cache so
 * each case re-parses (getServerEnv caches after the first success).
 */
const TOUCHED_KEYS = [
  "NODE_ENV",
  "CI",
  "AUTH_RATE_LIMIT_DISABLED",
  "SKIP_ENV_VALIDATION",
  "NEXT_PHASE",
  "BETTER_AUTH_SECRET",
  "PGPOOL_MAX",
] as const;

async function loadEnvWith(patch: Record<string, string | undefined>) {
  // process.env types NODE_ENV as read-only; treat it as a plain string map.
  const penv = process.env as Record<string, string | undefined>;
  const snapshot: Record<string, string | undefined> = {};
  for (const k of TOUCHED_KEYS) snapshot[k] = penv[k];
  const restore = () => {
    for (const k of TOUCHED_KEYS) {
      if (snapshot[k] === undefined) delete penv[k];
      else penv[k] = snapshot[k];
    }
  };
  if (!("CI" in patch)) delete penv.CI;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete penv[k];
    else penv[k] = v;
  }
  vi.resetModules();
  const mod = (await import("@/lib/env")) as typeof EnvModule;
  return { mod, restore };
}

describe("AUTH_RATE_LIMIT_DISABLED production guard (AUTH-5)", () => {
  it("throws in production when enabled outside CI", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      AUTH_RATE_LIMIT_DISABLED: "1",
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/AUTH_RATE_LIMIT_DISABLED/);
    } finally {
      restore();
    }
  });

  it("is permitted in production under CI (browser job runs next start)", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      AUTH_RATE_LIMIT_DISABLED: "1",
      CI: "true",
    });
    try {
      expect(mod.getServerEnv().AUTH_RATE_LIMIT_DISABLED).toBe(true);
    } finally {
      restore();
    }
  });

  it("is permitted outside production", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "development",
      AUTH_RATE_LIMIT_DISABLED: "1",
    });
    try {
      expect(mod.getServerEnv().AUTH_RATE_LIMIT_DISABLED).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("SKIP_ENV_VALIDATION build-phase escape (OPS-6)", () => {
  it("does NOT mask missing secrets at production runtime", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      SKIP_ENV_VALIDATION: "1",
      BETTER_AUTH_SECRET: undefined,
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/Invalid server environment variables/);
    } finally {
      restore();
    }
  });

  it("still substitutes placeholders for a non-production build harness", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "development",
      SKIP_ENV_VALIDATION: "1",
      BETTER_AUTH_SECRET: undefined,
    });
    try {
      expect(() => mod.getServerEnv()).not.toThrow();
    } finally {
      restore();
    }
  });

  it("substitutes placeholders during the genuine Next production build", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      BETTER_AUTH_SECRET: undefined,
    });
    try {
      expect(() => mod.getServerEnv()).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe("pool/proxy env validation (P2-12)", () => {
  it("applies positive-integer defaults when unset", () => {
    const env = getServerEnv();
    expect(typeof env.PGPOOL_MAX).toBe("number");
    expect(env.PGPOOL_MAX).toBeGreaterThanOrEqual(1);
    expect(env.PG_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(1);
    expect(env.PG_STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(1);
    expect(env.TRUSTED_PROXY_COUNT).toBeGreaterThanOrEqual(1);
  });

  it("fails fast at boot on a non-numeric PGPOOL_MAX (no silent NaN)", async () => {
    const { mod, restore } = await loadEnvWith({ PGPOOL_MAX: "abc" });
    try {
      expect(() => mod.getServerEnv()).toThrow(/PGPOOL_MAX/);
    } finally {
      restore();
    }
  });
});

describe("intFromEnv — NaN-safe numeric env read (P2-12)", () => {
  const KEY = "TEST_INT_FROM_ENV";
  const penv = process.env as Record<string, string | undefined>;
  afterEach(() => {
    delete penv[KEY];
  });

  it("returns the parsed integer when valid", () => {
    penv[KEY] = "42";
    expect(intFromEnv(KEY, 7)).toBe(42);
  });

  it("falls back to the default when unset", () => {
    expect(intFromEnv(KEY, 7)).toBe(7);
  });

  it("falls back on a non-numeric value instead of producing NaN", () => {
    penv[KEY] = "abc";
    expect(intFromEnv(KEY, 7)).toBe(7);
  });

  it("falls back on a non-integer value", () => {
    penv[KEY] = "3.5";
    expect(intFromEnv(KEY, 7)).toBe(7);
  });

  it("enforces the minimum (default 1)", () => {
    penv[KEY] = "0";
    expect(intFromEnv(KEY, 7)).toBe(7);
    penv[KEY] = "1";
    expect(intFromEnv(KEY, 7)).toBe(1);
  });
});
