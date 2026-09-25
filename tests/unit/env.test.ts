import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";
import { getServerEnv, intFromEnv, invalidServerEnvKeys } from "@/lib/env";

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
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.SSO_HANDOFF_TTL_SECONDS).toBeGreaterThan(0);
  });

  it("caches the parsed env on subsequent calls", () => {
    const a = getServerEnv();
    const b = getServerEnv();
    expect(a).toBe(b);
  });

  it("throws with invalid_keys list when a required variable is missing", async () => {
    // Re-import the module fresh so the internal cache is empty.
    const original = process.env.SSO_HANDOFF_ISSUER;
    delete process.env.SSO_HANDOFF_ISSUER;
    // Use a query-string suffix on the import specifier so vitest treats
    // it as a distinct module and does not return the already-cached one.
    const fresh = (await import("@/lib/env" + "?fresh")) as typeof EnvModule;
    try {
      expect(() => fresh.getServerEnv()).toThrow(/SSO_HANDOFF_ISSUER/);
    } finally {
      process.env.SSO_HANDOFF_ISSUER = original;
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
  "SSO_HANDOFF_PRIVATE_KEY",
  "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY",
  "SSO_HANDOFF_ISSUER",
  "API_JWT_ENABLED",
  "API_JWT_PRIVATE_KEY",
  "API_JWT_PREVIOUS_PRIVATE_KEY",
  "MAILGUN_BASE_URL",
  "ADMIN_TRUSTED_ORIGINS",
  "COOKIE_DOMAIN",
  "PGPOOL_MAX",
  "CRON_SECRET",
  "METRICS_TOKEN",
  "SSO_ALLOWED_ORIGIN_SUFFIXES",
  "MCP_AUDIENCE_GRACE",
  "MCP_ENABLED",
  "MCP_FORWARD_CLIENT_IP",
  "MCP_DISPATCH_BASE_URL",
  "API_JWT_ISSUER",
  "BETTER_AUTH_URL",
  "SESSION_ABSOLUTE_LIFETIME_HOURS",
  "API_KEY_USAGE_TOUCH_INTERVAL_SECONDS",
  "CLIENT_IP_SOURCE",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "MAILGUN_API_KEY",
  "MAILGUN_DOMAIN",
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

describe("MCP_AUDIENCE_GRACE (RFC 8707 rollout flag, review #50/#53)", () => {
  it("is OFF by default — /api/mcp requires the MCP audience", async () => {
    const { mod, restore } = await loadEnvWith({ MCP_AUDIENCE_GRACE: undefined });
    try {
      expect(mod.getServerEnv().MCP_AUDIENCE_GRACE).toBe(false);
    } finally {
      restore();
    }
  });

  it("accepts 1 / true and treats anything else as off", async () => {
    for (const [value, expected] of [
      ["1", true],
      ["true", true],
      ["", false],
      ["0", false],
      ["yes", false],
    ] as const) {
      const { mod, restore } = await loadEnvWith({ MCP_AUDIENCE_GRACE: value });
      try {
        expect(mod.getServerEnv().MCP_AUDIENCE_GRACE, value).toBe(expected);
      } finally {
        restore();
      }
    }
  });
});

/**
 * MCP discovery consistency (review #57). `/.well-known/oauth-authorization-
 * server` is served from BETTER_AUTH_URL and names the token + JWKS endpoints
 * under that origin, but advertises `issuer` = API_JWT_ISSUER. RFC 8414 §3.3
 * requires the issuer to be the URL the metadata was retrieved from, so a
 * divergent issuer yields a document a compliant client MUST reject — and no
 * metadata is served at the issuer's own origin to fix it. Fail at boot.
 */
describe("API_JWT_ISSUER / BETTER_AUTH_URL consistency when MCP_ENABLED (review #57)", () => {
  it("refuses a divergent issuer while the gateway is on", async () => {
    const { mod, restore } = await loadEnvWith({
      MCP_ENABLED: "1",
      BETTER_AUTH_URL: "https://app.example.com",
      API_JWT_ISSUER: "https://issuer.example.net",
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/API_JWT_ISSUER/);
    } finally {
      restore();
    }
  });

  it("accepts an unset (or empty) issuer, or an identical one", async () => {
    for (const issuer of [undefined, "", "https://app.example.com"]) {
      const { mod, restore } = await loadEnvWith({
        MCP_ENABLED: "1",
        BETTER_AUTH_URL: "https://app.example.com",
        API_JWT_ISSUER: issuer,
      });
      try {
        expect(() => mod.getServerEnv(), String(issuer)).not.toThrow();
      } finally {
        restore();
      }
    }
  });

  it("refuses an issuer that differs only by a trailing slash since F-22 (iss is an exact string)", async () => {
    // Review #57 tolerated it for the discovery check, but the value is
    // stamped into every token as `iss` and verifiers compare it exactly;
    // the discovery document advertises it trimmed, so the two disagreed.
    const { mod, restore } = await loadEnvWith({
      MCP_ENABLED: "1",
      BETTER_AUTH_URL: "https://app.example.com",
      API_JWT_ISSUER: "https://app.example.com/",
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/API_JWT_ISSUER \(must not end with "\/"/);
    } finally {
      restore();
    }
  });

  it("leaves a divergent issuer alone while MCP is dark (nothing advertises it)", async () => {
    const { mod, restore } = await loadEnvWith({
      MCP_ENABLED: undefined,
      BETTER_AUTH_URL: "https://app.example.com",
      API_JWT_ISSUER: "https://issuer.example.net",
    });
    try {
      expect(mod.getServerEnv().API_JWT_ISSUER).toBe("https://issuer.example.net");
    } finally {
      restore();
    }
  });
});

describe("MCP self-call knobs (review #55)", () => {
  it("defaults to forwarding the client IP to BETTER_AUTH_URL (today's behaviour)", async () => {
    const { mod, restore } = await loadEnvWith({
      MCP_FORWARD_CLIENT_IP: undefined,
      MCP_DISPATCH_BASE_URL: undefined,
    });
    try {
      const env = mod.getServerEnv();
      expect(env.MCP_FORWARD_CLIENT_IP).toBe(true);
      expect(env.MCP_DISPATCH_BASE_URL).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("lets an operator turn the forwarding off and point the hop at an internal origin", async () => {
    const { mod, restore } = await loadEnvWith({
      MCP_FORWARD_CLIENT_IP: "0",
      MCP_DISPATCH_BASE_URL: "http://127.0.0.1:3000",
    });
    try {
      const env = mod.getServerEnv();
      expect(env.MCP_FORWARD_CLIENT_IP).toBe(false);
      expect(env.MCP_DISPATCH_BASE_URL).toBe("http://127.0.0.1:3000");
    } finally {
      restore();
    }
  });
});

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

/**
 * Review #14: `SSO_ALLOWED_ORIGIN_SUFFIXES` bounds where SSO handoff tokens
 * may be sent. A bare TLD / public-suffix entry must fail BOOT (loud), a
 * production deployment that leaves it unset must be warned (registration
 * then fails closed in `allowedOriginSuffixes()`), and a clean list boots.
 */
describe("SSO_ALLOWED_ORIGIN_SUFFIXES boot validation (review #14)", () => {
  it.each(["co.uk", "com", "github.io"])(
    "refuses to boot when the list contains the public suffix %s",
    async (suffix) => {
      const { mod, restore } = await loadEnvWith({ SSO_ALLOWED_ORIGIN_SUFFIXES: suffix });
      try {
        expect(() => mod.getServerEnv()).toThrow(/SSO_ALLOWED_ORIGIN_SUFFIXES/);
      } finally {
        restore();
      }
    },
  );

  it("refuses to boot when ONE entry of a mixed list is a public suffix", async () => {
    const { mod, restore } = await loadEnvWith({
      SSO_ALLOWED_ORIGIN_SUFFIXES: "devresponse.com,co.uk",
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/SSO_ALLOWED_ORIGIN_SUFFIXES/);
    } finally {
      restore();
    }
  });

  it("boots with registrable domains (example.co.uk, devresponse.com)", async () => {
    const { mod, restore } = await loadEnvWith({
      SSO_ALLOWED_ORIGIN_SUFFIXES: "example.co.uk, devresponse.com",
    });
    try {
      expect(mod.getServerEnv().SSO_ALLOWED_ORIGIN_SUFFIXES).toBe("example.co.uk, devresponse.com");
    } finally {
      restore();
    }
  });

  it("tolerates localhost outside production but refuses it in production", async () => {
    const dev = await loadEnvWith({
      NODE_ENV: "development",
      SSO_ALLOWED_ORIGIN_SUFFIXES: "devresponse.local,localhost",
    });
    try {
      expect(() => dev.mod.getServerEnv()).not.toThrow();
    } finally {
      dev.restore();
    }
    const prod = await loadEnvWith({
      NODE_ENV: "production",
      SSO_ALLOWED_ORIGIN_SUFFIXES: "devresponse.local,localhost",
    });
    try {
      expect(() => prod.mod.getServerEnv()).toThrow(/SSO_ALLOWED_ORIGIN_SUFFIXES/);
    } finally {
      prod.restore();
    }
  });

  it("boots but warns loudly when unset in production (registration fails closed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      SSO_ALLOWED_ORIGIN_SUFFIXES: undefined,
    });
    try {
      expect(() => mod.getServerEnv()).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/SSO_ALLOWED_ORIGIN_SUFFIXES is unset/);
      // cached parse ⇒ the warning is emitted once per process, not per call
      mod.getServerEnv();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      restore();
    }
  });

  it("does not warn when unset outside production (the host-derived fallback applies)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "development",
      SSO_ALLOWED_ORIGIN_SUFFIXES: undefined,
    });
    try {
      mod.getServerEnv();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      restore();
    }
  });

  it("does not warn during the production build phase", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      SSO_ALLOWED_ORIGIN_SUFFIXES: undefined,
    });
    try {
      mod.getServerEnv();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
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

describe("signing-secret hygiene (audit #12/#22)", () => {
  const VALID = "a".repeat(40);
  const VALID2 = "b".repeat(40);
  // The RFC 8037 Appendix A Ed25519 private JWK: the shape the schema checks
  // (32-byte x and d), and a real, consistent pair besides.
  const ED25519_JWK = JSON.stringify({
    kty: "OKP",
    crv: "Ed25519",
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  });

  it("rejects a BETTER_AUTH_SECRET shorter than 32 chars", async () => {
    const { mod, restore } = await loadEnvWith({ BETTER_AUTH_SECRET: "short-secret" });
    try {
      expect(() => mod.getServerEnv()).toThrow(/BETTER_AUTH_SECRET/);
    } finally {
      restore();
    }
  });

  it("accepts a >=32-char BETTER_AUTH_SECRET with no SSO signing key (SSO is optional, review #5)", async () => {
    const { mod, restore } = await loadEnvWith({
      BETTER_AUTH_SECRET: VALID,
      SSO_HANDOFF_PRIVATE_KEY: undefined,
    });
    try {
      expect(mod.getServerEnv().SSO_HANDOFF_PRIVATE_KEY).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("treats an empty SSO_HANDOFF_PRIVATE_KEY as unset", async () => {
    const { mod, restore } = await loadEnvWith({
      BETTER_AUTH_SECRET: VALID,
      SSO_HANDOFF_PRIVATE_KEY: "",
    });
    try {
      expect(mod.getServerEnv().SSO_HANDOFF_PRIVATE_KEY).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("accepts a well-formed Ed25519 private JWK as SSO_HANDOFF_PRIVATE_KEY", async () => {
    const { mod, restore } = await loadEnvWith({
      BETTER_AUTH_SECRET: VALID,
      SSO_HANDOFF_PRIVATE_KEY: ED25519_JWK,
    });
    try {
      expect(mod.getServerEnv().SSO_HANDOFF_PRIVATE_KEY).toBe(ED25519_JWK);
    } finally {
      restore();
    }
  });

  it.each([
    ["not JSON", VALID2],
    ["a symmetric-looking secret", JSON.stringify({ kty: "oct", k: VALID2 })],
    ["a public-only JWK (no d)", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "abc" })],
    ["the wrong curve", JSON.stringify({ kty: "OKP", crv: "X25519", x: "abc", d: "def" })],
  ])("fails at boot on a malformed SSO_HANDOFF_PRIVATE_KEY (%s)", async (_label, raw) => {
    const { mod, restore } = await loadEnvWith({
      BETTER_AUTH_SECRET: VALID,
      SSO_HANDOFF_PRIVATE_KEY: raw,
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/SSO_HANDOFF_PRIVATE_KEY/);
    } finally {
      restore();
    }
  });

  it("fails at boot on a malformed SSO_HANDOFF_PREVIOUS_PRIVATE_KEY", async () => {
    const { mod, restore } = await loadEnvWith({
      BETTER_AUTH_SECRET: VALID,
      SSO_HANDOFF_PRIVATE_KEY: ED25519_JWK,
      SSO_HANDOFF_PREVIOUS_PRIVATE_KEY: "{}",
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/SSO_HANDOFF_PREVIOUS_PRIVATE_KEY/);
    } finally {
      restore();
    }
  });

  it("rejects one keypair doing double duty as SSO handoff AND API JWT signer", async () => {
    const { mod, restore } = await loadEnvWith({
      BETTER_AUTH_SECRET: VALID,
      SSO_HANDOFF_PRIVATE_KEY: ED25519_JWK,
      API_JWT_PRIVATE_KEY: ED25519_JWK,
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/SSO_HANDOFF_PRIVATE_KEY/);
    } finally {
      restore();
    }
  });

  it("refuses the .env.example placeholder secret in production", async () => {
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "replace-with-strong-random-secret",
    });
    try {
      expect(() => mod.getServerEnv()).toThrow(/BETTER_AUTH_SECRET/);
    } finally {
      restore();
    }
  });
});

/**
 * The two knobs added by reviews #200 and #201. Both MUST leave today's
 * behaviour alone when unset — an absolute session cap and a coarser
 * `last_used_at` are policy changes an operator opts into, not defaults this
 * change set imposes.
 */
describe("session + credential hygiene knobs (#200, #201)", () => {
  it("leaves SESSION_ABSOLUTE_LIFETIME_HOURS undefined when unset (no cap)", async () => {
    const { mod, restore } = await loadEnvWith({ SESSION_ABSOLUTE_LIFETIME_HOURS: undefined });
    try {
      expect(mod.getServerEnv().SESSION_ABSOLUTE_LIFETIME_HOURS).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("coerces a configured SESSION_ABSOLUTE_LIFETIME_HOURS to a number", async () => {
    const { mod, restore } = await loadEnvWith({ SESSION_ABSOLUTE_LIFETIME_HOURS: "168" });
    try {
      expect(mod.getServerEnv().SESSION_ABSOLUTE_LIFETIME_HOURS).toBe(168);
    } finally {
      restore();
    }
  });

  it.each(["0", "-1", "abc", "9000"])(
    "rejects an out-of-range SESSION_ABSOLUTE_LIFETIME_HOURS (%s) at boot",
    async (value) => {
      const { mod, restore } = await loadEnvWith({ SESSION_ABSOLUTE_LIFETIME_HOURS: value });
      try {
        expect(() => mod.getServerEnv()).toThrow(/SESSION_ABSOLUTE_LIFETIME_HOURS/);
      } finally {
        restore();
      }
    },
  );

  it("defaults API_KEY_USAGE_TOUCH_INTERVAL_SECONDS to 60 and accepts 0", async () => {
    const unset = await loadEnvWith({ API_KEY_USAGE_TOUCH_INTERVAL_SECONDS: undefined });
    try {
      expect(unset.mod.getServerEnv().API_KEY_USAGE_TOUCH_INTERVAL_SECONDS).toBe(60);
    } finally {
      unset.restore();
    }
    const zero = await loadEnvWith({ API_KEY_USAGE_TOUCH_INTERVAL_SECONDS: "0" });
    try {
      expect(zero.mod.getServerEnv().API_KEY_USAGE_TOUCH_INTERVAL_SECONDS).toBe(0);
    } finally {
      zero.restore();
    }
  });

  it("rejects a negative API_KEY_USAGE_TOUCH_INTERVAL_SECONDS at boot", async () => {
    const { mod, restore } = await loadEnvWith({ API_KEY_USAGE_TOUCH_INTERVAL_SECONDS: "-1" });
    try {
      expect(() => mod.getServerEnv()).toThrow(/API_KEY_USAGE_TOUCH_INTERVAL_SECONDS/);
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

describe("CLIENT_IP_SOURCE boot validation (F-17)", () => {
  it("defaults to unset (the `xff` model) and accepts xff, x-real-ip and a header name", async () => {
    for (const value of [undefined, "", "xff", "x-real-ip", "X-Real-IP", "cf-connecting-ip"]) {
      const { mod, restore } = await loadEnvWith({ CLIENT_IP_SOURCE: value });
      try {
        expect(mod.getServerEnv().CLIENT_IP_SOURCE, String(value)).toBe(value);
      } finally {
        restore();
      }
    }
  });

  it("refuses to boot on a value the runtime would read as no source at all", async () => {
    for (const value of [
      "x-forwarded-for",
      "x-drk-client-ip",
      "forwarded",
      "x real ip",
      "x-real-ip,cf-connecting-ip",
    ]) {
      const { mod, restore } = await loadEnvWith({ CLIENT_IP_SOURCE: value });
      try {
        expect(() => mod.getServerEnv(), value).toThrow(/CLIENT_IP_SOURCE/);
      } finally {
        restore();
      }
    }
  });
});

/**
 * F-22: every origin-valued variable must be an http(s) origin (https in
 * production unless loopback), COOKIE_DOMAIN must cover BETTER_AUTH_URL, and
 * the signing keys' shape is checked at parse (the Node boot hook imports them:
 * tests/unit/env-signing-keys.test.ts). The production outage behind it was
 * SSO_HANDOFF_ISSUER=httsp://demo.devresponse.ca, which PARSES as a URL — so
 * these vectors use the typo itself, not `not-a-url`.
 */
describe("origin-valued variables (F-22)", () => {
  const ED25519 = () =>
    JSON.stringify(generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }));

  async function expectBoot(patch: Record<string, string | undefined>, error?: RegExp) {
    const { mod, restore } = await loadEnvWith(patch);
    try {
      if (error) expect(() => mod.getServerEnv(), JSON.stringify(patch)).toThrow(error);
      else expect(() => mod.getServerEnv(), JSON.stringify(patch)).not.toThrow();
    } finally {
      restore();
    }
  }

  it.each([
    "httsp://demo.devresponse.ca",
    "ftp://demo.devresponse.ca",
    "https:/demo.devresponse.ca",
    "https://demo.devresponse.ca/",
    "https://demo.devresponse.ca/path",
    "https://Demo.devresponse.ca",
    "devresponse",
  ])("refuses SSO_HANDOFF_ISSUER=%s at boot", async (issuer) => {
    await expectBoot({ SSO_HANDOFF_ISSUER: issuer }, /SSO_HANDOFF_ISSUER \(must/);
  });

  it("says WHY in the boot error, so a write-only variable can still be fixed", async () => {
    await expectBoot(
      { SSO_HANDOFF_ISSUER: "httsp://demo.devresponse.ca" },
      /SSO_HANDOFF_ISSUER \(must use the http: or https: scheme, not "httsp:"\)/,
    );
    await expectBoot(
      { SSO_HANDOFF_ISSUER: "https://demo.devresponse.ca/" },
      /drop the trailing slash/,
    );
  });

  it.each([
    "httsp://app.example.com",
    "ftp://app.example.com",
    "https:/app.example.com",
    "https://app.example.com/app",
    "https://app.example.com?x=1",
  ])("refuses BETTER_AUTH_URL=%s at boot", async (url) => {
    await expectBoot({ BETTER_AUTH_URL: url }, /BETTER_AUTH_URL \(must/);
  });

  it("tolerates a trailing slash on BETTER_AUTH_URL (the URL builders trim it)", async () => {
    await expectBoot({ BETTER_AUTH_URL: "https://app.example.com/" });
  });

  it("requires https in production, except on a loopback host", async () => {
    await expectBoot(
      { NODE_ENV: "production", BETTER_AUTH_URL: "http://example.com" },
      /BETTER_AUTH_URL \(must use https: in production/,
    );
    await expectBoot(
      { NODE_ENV: "production", SSO_HANDOFF_ISSUER: "http://example.com" },
      /SSO_HANDOFF_ISSUER \(must use https: in production/,
    );
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      await expectBoot({ NODE_ENV: "production", BETTER_AUTH_URL: url, SSO_HANDOFF_ISSUER: url });
    }
    // Outside production any http host is fine (the local SSO rig's .local hosts).
    await expectBoot({
      NODE_ENV: "development",
      BETTER_AUTH_URL: "http://devresponse.local:3000",
      SSO_HANDOFF_ISSUER: "http://devresponse.local:3000",
    });
  });

  it("refuses a bad API_JWT_ISSUER, MCP_DISPATCH_BASE_URL or MAILGUN_BASE_URL", async () => {
    await expectBoot({ API_JWT_ISSUER: "httsp://app.example.com" }, /API_JWT_ISSUER \(must/);
    await expectBoot({ API_JWT_ISSUER: "devresponse-api" }, /API_JWT_ISSUER \(must/);
    await expectBoot({ MCP_DISPATCH_BASE_URL: "ftp://127.0.0.1:3000" }, /MCP_DISPATCH_BASE_URL/);
    await expectBoot(
      { NODE_ENV: "production", MCP_DISPATCH_BASE_URL: "http://10.0.0.5:3000" },
      /MCP_DISPATCH_BASE_URL \(must use https: in production/,
    );
    await expectBoot({ NODE_ENV: "production", MCP_DISPATCH_BASE_URL: "http://127.0.0.1:3000" });
    await expectBoot({ MAILGUN_BASE_URL: "httsp://api.eu.mailgun.net" }, /MAILGUN_BASE_URL/);
    await expectBoot({ MAILGUN_BASE_URL: "https://api.eu.mailgun.net/v3" }, /MAILGUN_BASE_URL/);
    await expectBoot({ MAILGUN_BASE_URL: "https://api.eu.mailgun.net" });
    // Tolerated, because the Mailgun client trims it (email-providers.test.ts).
    await expectBoot({ MAILGUN_BASE_URL: "https://api.eu.mailgun.net/" });
  });

  it("treats an empty API_JWT_ISSUER / MCP_DISPATCH_BASE_URL as unset", async () => {
    const { mod, restore } = await loadEnvWith({ API_JWT_ISSUER: "", MCP_DISPATCH_BASE_URL: "" });
    try {
      const env = mod.getServerEnv();
      expect(env.API_JWT_ISSUER).toBeUndefined();
      expect(env.MCP_DISPATCH_BASE_URL).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("checks every ADMIN_TRUSTED_ORIGINS entry", async () => {
    await expectBoot({ ADMIN_TRUSTED_ORIGINS: " https://a.example.com , https://b.example.com " });
    await expectBoot(
      { ADMIN_TRUSTED_ORIGINS: "https://a.example.com,httsp://b.example.com" },
      /ADMIN_TRUSTED_ORIGINS \(every entry must be an http\(s\) origin; entry 2 must use the http: or https: scheme, not "httsp:"\)/,
    );
    await expectBoot(
      { ADMIN_TRUSTED_ORIGINS: "https://a.example.com/path" },
      /ADMIN_TRUSTED_ORIGINS/,
    );
    await expectBoot(
      { NODE_ENV: "production", ADMIN_TRUSTED_ORIGINS: "http://preview.example.com" },
      /ADMIN_TRUSTED_ORIGINS/,
    );
  });

  it("names a bad ADMIN_TRUSTED_ORIGINS entry by position, never echoing its credentials", async () => {
    const { mod, restore } = await loadEnvWith({
      ADMIN_TRUSTED_ORIGINS: "https://a.example.com,https://ops:hunter2-secret@b.example.com",
    });
    try {
      let message = "";
      try {
        mod.getServerEnv();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/ADMIN_TRUSTED_ORIGINS \(.*entry 2 must be an origin/);
      expect(message).toContain("(https://b.example.com)");
      expect(message).not.toContain("hunter2-secret");
      expect(message).not.toContain("ops:");
    } finally {
      restore();
    }
  });

  it("requires COOKIE_DOMAIN to cover BETTER_AUTH_URL and not be a public suffix", async () => {
    const prod = { NODE_ENV: "production", BETTER_AUTH_URL: "https://demo.devresponse.ca" };
    // The live Option C shape: the kit on demo.devresponse.ca under .devresponse.ca.
    await expectBoot({ ...prod, COOKIE_DOMAIN: ".devresponse.ca" });
    await expectBoot({ ...prod, COOKIE_DOMAIN: "" });
    await expectBoot(
      { ...prod, COOKIE_DOMAIN: ".devresponse.com" },
      /COOKIE_DOMAIN \(must be BETTER_AUTH_URL's host \(demo\.devresponse\.ca\) or a parent domain/,
    );
    await expectBoot({ ...prod, COOKIE_DOMAIN: ".ca" }, /COOKIE_DOMAIN \(.*public suffix/);
    // auth.ts sends the RAW value as `Domain=`, and a browser drops the cookie
    // for an FQDN trailing dot or a doubled leading dot, so those fail boot
    // even though their normalised form covers the host.
    for (const spelling of ["devresponse.ca.", ".devresponse.ca.", "..devresponse.ca"]) {
      await expectBoot(
        { ...prod, COOKIE_DOMAIN: spelling },
        /COOKIE_DOMAIN \(must be written as devresponse\.ca or \.devresponse\.ca/,
      );
    }
    await expectBoot({ ...prod, COOKIE_DOMAIN: ".DevResponse.CA" });
    await expectBoot(
      {
        NODE_ENV: "production",
        BETTER_AUTH_URL: "https://app.example.co.uk",
        COOKIE_DOMAIN: ".co.uk",
      },
      /COOKIE_DOMAIN \(.*public suffix/,
    );
    await expectBoot(
      { NODE_ENV: "production", BETTER_AUTH_URL: "https://app.example.com", COOKIE_DOMAIN: ".com" },
      /COOKIE_DOMAIN/,
    );
    // The local SSO rig (integration guide section 6.6).
    await expectBoot({
      NODE_ENV: "development",
      BETTER_AUTH_URL: "http://devresponse.local:3000",
      COOKIE_DOMAIN: ".devresponse.local",
    });
  });

  it("checks the shape of both JWT signing keys at parse (review #50)", async () => {
    const current = ED25519();
    await expectBoot({ API_JWT_ENABLED: "1", API_JWT_PRIVATE_KEY: current });
    await expectBoot({
      API_JWT_ENABLED: "1",
      API_JWT_PRIVATE_KEY: current,
      API_JWT_PREVIOUS_PRIVATE_KEY: ED25519(),
    });
    const jwk = JSON.parse(current) as Record<string, string>;
    for (const bad of [
      `${current}"`, // a trailing quote
      JSON.stringify({ ...jwk, d: jwk.d!.slice(0, -4) }), // a truncated d
      JSON.stringify({ ...jwk, d: `${jwk.d}=` }), // a padded d
      JSON.stringify({ ...jwk, x: `${jwk.x}"` }), // a stray quote inside x
      JSON.stringify({ ...jwk, crv: "X25519" }), // the wrong curve
    ]) {
      await expectBoot(
        { API_JWT_ENABLED: "1", API_JWT_PRIVATE_KEY: bad },
        /API_JWT_PRIVATE_KEY \(/,
      );
      // The previous key is checked whether or not it is ever used to verify:
      // a bad one breaks the whole key set, current-key tokens included.
      await expectBoot(
        { API_JWT_ENABLED: "1", API_JWT_PRIVATE_KEY: current, API_JWT_PREVIOUS_PRIVATE_KEY: bad },
        /API_JWT_PREVIOUS_PRIVATE_KEY \(/,
      );
    }
  });

  it("checks the SSO handoff keys' shape too (a truncated d no longer parses)", async () => {
    const jwk = JSON.parse(ED25519()) as Record<string, string>;
    await expectBoot(
      { SSO_HANDOFF_PRIVATE_KEY: JSON.stringify({ ...jwk, d: jwk.d!.slice(0, -1) }) },
      /SSO_HANDOFF_PRIVATE_KEY \(has a d member that is not 43 unpadded base64url characters/,
    );
  });

  it("leaves a mismatched x to the Node boot hook, which env.ts cannot run", async () => {
    // Pairing x with d takes node:crypto, and env.ts is in the Edge graph, so
    // the schema accepts this; assertSigningKeysImport refuses it at boot
    // (tests/unit/env-signing-keys.test.ts).
    const jwk = JSON.parse(ED25519()) as Record<string, string>;
    const mismatched = JSON.stringify({ ...jwk, x: JSON.parse(ED25519()).x });
    await expectBoot({ SSO_HANDOFF_PRIVATE_KEY: mismatched });
    await expectBoot({
      API_JWT_ENABLED: "1",
      API_JWT_PREVIOUS_PRIVATE_KEY: mismatched,
      API_JWT_PRIVATE_KEY: ED25519(),
    });
  });

  it("never echoes a secret in the boot error", async () => {
    const secret = ED25519();
    const { mod, restore } = await loadEnvWith({ API_JWT_PRIVATE_KEY: `${secret}"` });
    try {
      let message = "";
      try {
        mod.getServerEnv();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/API_JWT_PRIVATE_KEY/);
      expect(message).not.toContain((JSON.parse(secret) as { d: string }).d);
    } finally {
      restore();
    }
  });

  it("still boots the build-phase placeholders (NODE_ENV=production, http://localhost:3000)", async () => {
    // `next build` falls back to these when the real env is invalid; they
    // parse under NODE_ENV=production, so the loopback exemption is what
    // keeps every build green.
    const { mod, restore } = await loadEnvWith({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
      SSO_HANDOFF_ISSUER: "httsp://demo.devresponse.ca",
    });
    try {
      const env = mod.getServerEnv();
      expect(env.NODE_ENV).toBe("production");
      expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
      expect(env.SSO_HANDOFF_ISSUER).toBe("http://localhost:3000");
    } finally {
      restore();
    }
  });

  it("boots the CI browser job's env (next start under NODE_ENV=production)", async () => {
    await expectBoot({
      NODE_ENV: "production",
      CI: "true",
      BETTER_AUTH_URL: "http://localhost:3000",
      SSO_HANDOFF_ISSUER: "http://localhost:3000",
      AUTH_RATE_LIMIT_DISABLED: "1",
      API_JWT_ENABLED: "1",
      API_JWT_PRIVATE_KEY: ED25519(),
      MCP_ENABLED: "1",
      SSO_ALLOWED_ORIGIN_SUFFIXES: "devresponse.com",
    });
  });

  it("boots the live production shape (demo.devresponse.ca, Option C cookie)", async () => {
    await expectBoot({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://demo.devresponse.ca",
      SSO_HANDOFF_ISSUER: "https://demo.devresponse.ca",
      COOKIE_DOMAIN: ".devresponse.ca",
      SSO_ALLOWED_ORIGIN_SUFFIXES: "devresponse.ca",
    });
  });
});

/**
 * F-27: with a provider in production, the sender must be one a provider
 * sends from. The default `DevResponse <no-reply@localhost>` booted with
 * EMAIL_PROVIDER + RESEND_API_KEY set and failed every reset, verification and
 * invitation email on attempt 1. Development, tests, the outbox-only mode,
 * `next build`'s placeholders and CI's `next start` (no provider) are
 * unaffected. The value rule's own vectors are in env-validators.test.ts.
 */
describe("EMAIL_FROM with a real provider in production (F-27)", () => {
  const RESEND = { NODE_ENV: "production", EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" };
  const MAILGUN = {
    NODE_ENV: "production",
    EMAIL_PROVIDER: "mailgun",
    MAILGUN_API_KEY: "key-test",
    MAILGUN_DOMAIN: "mg.devresponse.ca",
  };

  async function expectBoot(patch: Record<string, string | undefined>, error?: RegExp) {
    const { mod, restore } = await loadEnvWith(patch);
    try {
      if (error) expect(() => mod.getServerEnv(), JSON.stringify(patch)).toThrow(error);
      else expect(() => mod.getServerEnv(), JSON.stringify(patch)).not.toThrow();
    } finally {
      restore();
    }
  }

  it("refuses to boot when EMAIL_FROM is left on its localhost default", async () => {
    await expectBoot(
      { ...RESEND, EMAIL_FROM: undefined },
      /EMAIL_FROM \(must be set when EMAIL_PROVIDER is set in production: unset, it defaults to DevResponse <no-reply@localhost>/,
    );
  });

  it.each([
    "DevResponse <no-reply@devresponse.ca>",
    "no-reply@devresponse.ca",
    '"DevResponse, Inc." <no-reply@mail.devresponse.ca>',
    "  DevResponse <No-Reply@DevResponse.CA>  ",
    "onboarding@resend.dev",
  ])("boots with a real sender, bare or in display-name form: %s", async (from) => {
    await expectBoot({ ...RESEND, EMAIL_FROM: from });
  });

  it.each([
    [
      "App <no-reply@localhost>",
      /EMAIL_FROM \(must be on a domain verified.*localhost is reserved/,
    ],
    ["no-reply@devresponse.local", /devresponse\.local is reserved/],
    ["no-reply@app.localhost", /app\.localhost is reserved/],
    ["App <no-reply@example.com>", /example\.com is reserved/],
    ["no-reply@mail.example.org", /mail\.example\.org is reserved/],
    ["no-reply@10.0.0.5", /not 10\.0\.0\.5 \(an IP address/],
    ["no-reply@mailhost", /not mailhost \(an IP address, a single label/],
    ["DevResponse no-reply@devresponse.ca", /EMAIL_FROM \(must be a sender address/],
    ["", /EMAIL_FROM \(must be a sender address/],
  ])("refuses %j in production with a provider", async (from, error) => {
    await expectBoot({ ...RESEND, EMAIL_FROM: from }, error);
  });

  it("leaves development and tests alone, even with a provider set", async () => {
    for (const NODE_ENV of ["development", "test"]) {
      await expectBoot({ ...RESEND, NODE_ENV, EMAIL_FROM: undefined });
      await expectBoot({ ...RESEND, NODE_ENV, EMAIL_FROM: "no-reply@devresponse.local" });
    }
  });

  it("leaves the outbox-only mode alone in production (no provider, nothing is sent)", async () => {
    await expectBoot({ NODE_ENV: "production", EMAIL_PROVIDER: undefined, EMAIL_FROM: undefined });
    await expectBoot({
      NODE_ENV: "production",
      EMAIL_PROVIDER: undefined,
      EMAIL_FROM: "no-reply@localhost",
    });
  });

  it("still boots the build-phase placeholders when the runtime sender is refused", async () => {
    const { mod, restore } = await loadEnvWith({
      ...RESEND,
      NEXT_PHASE: "phase-production-build",
      EMAIL_FROM: undefined,
    });
    try {
      const env = mod.getServerEnv();
      expect(env.EMAIL_PROVIDER).toBeUndefined();
      expect(env.NODE_ENV).toBe("production");
    } finally {
      restore();
    }
  });

  it("names EMAIL_FROM, and only its name, for the readiness log", async () => {
    const { mod, restore } = await loadEnvWith({ ...RESEND, EMAIL_FROM: undefined });
    try {
      expect(mod.invalidServerEnvKeys()).toEqual(["EMAIL_FROM"]);
    } finally {
      restore();
    }
  });

  it("with Mailgun, accepts a sender on MAILGUN_DOMAIN's registrable domain (relaxed DMARC alignment)", async () => {
    for (const from of [
      "App <no-reply@mg.devresponse.ca>",
      "App <no-reply@devresponse.ca>",
      "no-reply@news.devresponse.ca",
    ]) {
      await expectBoot({ ...MAILGUN, EMAIL_FROM: from });
    }
    await expectBoot({
      ...MAILGUN,
      MAILGUN_DOMAIN: "mg.example-shop.co.uk",
      EMAIL_FROM: "no-reply@example-shop.co.uk",
    });
  });

  it("with Mailgun, refuses a sender on another domain (Mailgun accepts it, receivers reject it)", async () => {
    await expectBoot(
      { ...MAILGUN, EMAIL_FROM: "App <no-reply@other.ca>" },
      /EMAIL_FROM \(must be on MAILGUN_DOMAIN's domain \(devresponse\.ca or a subdomain of it\): Mailgun signs as mg\.devresponse\.ca, so mail from other\.ca fails DMARC alignment/,
    );
    // A registrable domain, not a string suffix: co.uk is a public suffix.
    await expectBoot(
      { ...MAILGUN, MAILGUN_DOMAIN: "mg.example-shop.co.uk", EMAIL_FROM: "no-reply@other.co.uk" },
      /MAILGUN_DOMAIN's domain \(example-shop\.co\.uk/,
    );
    // The reserved-domain rule still comes first.
    await expectBoot({ ...MAILGUN, EMAIL_FROM: undefined }, /must be set when EMAIL_PROVIDER/);
  });
});

describe("operator secrets CRON_SECRET / METRICS_TOKEN (review #92/#222)", () => {
  const STRONG = "s".repeat(40);

  it("are undefined when unset — the consuming routes keep failing closed", async () => {
    const { mod, restore } = await loadEnvWith({
      CRON_SECRET: undefined,
      METRICS_TOKEN: undefined,
    });
    try {
      const env = mod.getServerEnv();
      expect(env.CRON_SECRET).toBeUndefined();
      expect(env.METRICS_TOKEN).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("treat an empty string as unset (an `X=` line in .env must not enable the endpoint)", async () => {
    const { mod, restore } = await loadEnvWith({ CRON_SECRET: "", METRICS_TOKEN: "" });
    try {
      const env = mod.getServerEnv();
      expect(env.CRON_SECRET).toBeUndefined();
      expect(env.METRICS_TOKEN).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("reject a CRON_SECRET shorter than 32 chars at boot", async () => {
    const { mod, restore } = await loadEnvWith({ CRON_SECRET: "x" });
    try {
      expect(() => mod.getServerEnv()).toThrow(/CRON_SECRET/);
    } finally {
      restore();
    }
  });

  it("reject a METRICS_TOKEN shorter than 32 chars at boot", async () => {
    const { mod, restore } = await loadEnvWith({ METRICS_TOKEN: "short-token" });
    try {
      expect(() => mod.getServerEnv()).toThrow(/METRICS_TOKEN/);
    } finally {
      restore();
    }
  });

  it("accept >=32-char values verbatim", async () => {
    const { mod, restore } = await loadEnvWith({ CRON_SECRET: STRONG, METRICS_TOKEN: STRONG });
    try {
      const env = mod.getServerEnv();
      expect(env.CRON_SECRET).toBe(STRONG);
      expect(env.METRICS_TOKEN).toBe(STRONG);
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

describe("invalidServerEnvKeys — names only, for the readiness log (F-26)", () => {
  it("is empty for a valid environment", () => {
    expect(invalidServerEnvKeys()).toEqual([]);
  });

  it("names each failing key once, sorted, and never a value or a rule", () => {
    const keys = invalidServerEnvKeys({
      ...process.env,
      SSO_HANDOFF_ISSUER: "httsp://issuer.example.com",
      BETTER_AUTH_SECRET: "short-secret-value",
    });
    expect(keys).toEqual(["BETTER_AUTH_SECRET", "SSO_HANDOFF_ISSUER"]);
    expect(JSON.stringify(keys)).not.toMatch(/short-secret|httsp|chars/);
    expect(invalidServerEnvKeys({ ...process.env, PGPOOL_MAX: "abc" })).toEqual(["PGPOOL_MAX"]);
  });

  it("reports an issue that names no key as (schema)", () => {
    expect(invalidServerEnvKeys(null as unknown as NodeJS.ProcessEnv)).toEqual(["(schema)"]);
  });
});
