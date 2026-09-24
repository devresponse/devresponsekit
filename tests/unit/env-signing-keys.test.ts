import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSigningKeysImport,
  ed25519KeyPairProblem,
  SIGNING_KEY_VARIABLES,
} from "@/lib/env-signing-keys.server";
import { ed25519PrivateJwkProblem } from "@/lib/env-validators";
// drk-deploy cannot import the kit across its package boundary, so it carries
// a copy of the WHOLE key rule: the kit's shape check and its boot import, in
// that order (F-22).
import { specFor as cliSpecFor } from "../../vercel-cli/src/lib/env-spec";
import { ed25519PrivateJwkProblem as cliEd25519PrivateJwkProblem } from "../../vercel-cli/src/lib/secrets";

/**
 * F-22 follow-up: the env schema checks each Ed25519 signing key's SHAPE
 * (`env-validators.ts`, which must stay Edge-safe), and the Node branch of
 * `register()` IMPORTS each one at boot (`env-signing-keys.server.ts`), where
 * an `x` that is not `d`'s public half is caught.
 */

const exportJwk = () =>
  generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" }) as Record<string, string>;
const JWK = exportJwk();
const RAW = JSON.stringify(JWK);
// RFC 8037 Appendix A test vector: a real, consistent pair.
const RFC8037 = JSON.stringify({
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
});
/** Well-formed halves from two different keys: the shape rule passes it. */
const MISMATCHED = JSON.stringify({ ...JWK, x: exportJwk().x });

const DOES_NOT_IMPORT =
  /^does not import as an Ed25519 private key \(is d truncated or corrupted\?\)$/;
const NOT_PUBLIC_HALF = /^has an x member that is not the public half of its d$/;

describe("ed25519KeyPairProblem (F-22, review #50)", () => {
  it("accepts a real key, the RFC 8037 vector, and extra metadata members", () => {
    expect(ed25519KeyPairProblem(RAW)).toBeNull();
    expect(ed25519KeyPairProblem(RFC8037)).toBeNull();
    expect(
      ed25519KeyPairProblem(JSON.stringify({ ...JWK, alg: "EdDSA", kid: "k1", use: "sig" })),
    ).toBeNull();
  });

  it("refuses an x that is not the public half of its d", () => {
    expect(ed25519PrivateJwkProblem(MISMATCHED)).toBeNull(); // the shape is fine
    expect(ed25519KeyPairProblem(MISMATCHED)).toMatch(NOT_PUBLIC_HALF);
    const rfc = JSON.parse(RFC8037) as Record<string, string>;
    expect(ed25519KeyPairProblem(JSON.stringify({ ...rfc, x: JWK.x }))).toMatch(NOT_PUBLIC_HALF);
  });

  it.each([
    ["a truncated d", JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -4) })],
    ["a d one character short", JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -1) })],
    ["no d at all", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: JWK.x })],
    ["no x at all", JSON.stringify({ kty: "OKP", crv: "Ed25519", d: JWK.d })],
    ["not JSON", `${RAW}"`],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
  ])("refuses a value that does not import (%s)", (_label, raw) => {
    expect(ed25519KeyPairProblem(raw)).toMatch(DOES_NOT_IMPORT);
  });

  it("refuses a real private key of another type, which Node WOULD import", () => {
    const others = [
      generateKeyPairSync("x25519").privateKey,
      generateKeyPairSync("ed448").privateKey,
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
    ];
    for (const key of others) {
      const raw = JSON.stringify(key.export({ format: "jwk" }));
      expect(ed25519KeyPairProblem(raw), key.asymmetricKeyType).toMatch(DOES_NOT_IMPORT);
    }
  });

  it("never quotes key material in its sentences", () => {
    for (const raw of [MISMATCHED, JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -4) })]) {
      const problem = ed25519KeyPairProblem(raw) ?? "";
      expect(problem).not.toBe("");
      expect(problem).not.toContain(JWK.d!.slice(0, 12));
      expect(problem).not.toContain(JWK.x!.slice(0, 12));
    }
  });
});

describe("assertSigningKeysImport (F-22)", () => {
  it("covers exactly the Ed25519 private-key variables of the env schema", () => {
    // Completeness guard: a key added to env.ts must be imported at boot too.
    const schema = readFileSync(new URL("../../src/lib/env.ts", import.meta.url), "utf8");
    const inSchema = [...schema.matchAll(/^\s*(\w+): optionalEd25519PrivateJwk\(\)/gm)].map(
      (match) => match[1],
    );
    expect(inSchema).toHaveLength(4);
    expect([...SIGNING_KEY_VARIABLES].sort()).toEqual(inSchema.sort());
  });

  it("passes when every key is unset, blank or sound", () => {
    expect(() => assertSigningKeysImport({})).not.toThrow();
    const blank = Object.fromEntries(
      SIGNING_KEY_VARIABLES.map((name, i) => [name, ["", "   ", "\n", undefined][i]]),
    );
    expect(() => assertSigningKeysImport(blank)).not.toThrow();
    const sound = Object.fromEntries(
      SIGNING_KEY_VARIABLES.map((name) => [name, JSON.stringify(exportJwk())]),
    );
    expect(() => assertSigningKeysImport(sound)).not.toThrow();
  });

  it.each(SIGNING_KEY_VARIABLES)(
    "names %s and its rule, never its value, when it does not import",
    (name) => {
      let message = "";
      try {
        assertSigningKeysImport({ [name]: MISMATCHED });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        `Invalid Ed25519 signing keys at boot: ${name} (has an x member that is not the public half of its d)`,
      );
      const { d, x } = JSON.parse(MISMATCHED) as Record<string, string>;
      expect(message).not.toContain(d!);
      expect(message).not.toContain(x!);
    },
  );

  it("reports a bad shape with the schema's own sentence (it checks shape first)", () => {
    const truncated = JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -4) });
    expect(() => assertSigningKeysImport({ API_JWT_PRIVATE_KEY: truncated })).toThrow(
      /API_JWT_PRIVATE_KEY \(has a d member that is not 43 unpadded base64url characters/,
    );
  });

  it("throws ONE error naming every failing variable, and only those", () => {
    let message = "";
    try {
      assertSigningKeysImport({
        SSO_HANDOFF_PRIVATE_KEY: RAW,
        SSO_HANDOFF_PREVIOUS_PRIVATE_KEY: MISMATCHED,
        API_JWT_PRIVATE_KEY: `${RAW}"`,
        API_JWT_PREVIOUS_PRIVATE_KEY: "",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "Invalid Ed25519 signing keys at boot: " +
        "SSO_HANDOFF_PREVIOUS_PRIVATE_KEY (has an x member that is not the public half of its d); " +
        "API_JWT_PRIVATE_KEY (must be a JSON-encoded Ed25519 private JWK (it is not valid JSON))",
    );
    expect(message).not.toContain(JWK.d!);
  });

  describe("reads process.env by default", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("fails on a bad key in the real environment", () => {
      vi.stubEnv("API_JWT_PREVIOUS_PRIVATE_KEY", MISMATCHED);
      expect(() => assertSigningKeysImport()).toThrow(/API_JWT_PREVIOUS_PRIVATE_KEY \(/);
    });
  });
});

/** Vectors reaching every branch of the whole rule: shape, then import. */
const KEY_VECTORS = [
  RAW,
  RFC8037,
  `${RAW}"`,
  "null",
  JSON.stringify({ ...JWK, crv: "X25519" }),
  JSON.stringify({ kty: "OKP", crv: "Ed25519", x: JWK.x }),
  JSON.stringify({ ...JWK, d: JWK.d!.slice(0, -4) }),
  JSON.stringify({ ...JWK, d: `${JWK.d}=` }),
  JSON.stringify({ ...JWK, x: `${JWK.x}"` }),
  JSON.stringify({ ...JWK, x: JWK.x!.replace(/.$/, "+") }),
  MISMATCHED,
];
const kitRule = (raw: string) => ed25519PrivateJwkProblem(raw) ?? ed25519KeyPairProblem(raw);

describe("drk-deploy's copy of the key rule stays in step with the kit's (F-22)", () => {
  it("returns the same verdict AND sentence as the kit's shape-then-import", () => {
    for (const raw of KEY_VECTORS) {
      expect(cliEd25519PrivateJwkProblem(raw), raw).toBe(kitRule(raw));
    }
    // ...and env:sync refuses to write what the kit would refuse to boot with.
    const validate = cliSpecFor("SSO_HANDOFF_PRIVATE_KEY")?.validate;
    expect(validate).toBeDefined();
    for (const raw of KEY_VECTORS) {
      expect(validate!(raw), raw).toBe(kitRule(raw));
    }
  });

  it("exercises every reachable rejection branch (completeness guard for KEY_VECTORS)", () => {
    // The import-failure branch is not reachable behind the shape check: Node
    // reads any 43-character d as a 32-byte seed, and every seed is a key.
    // ed25519KeyPairProblem's own suite above reaches it directly.
    const branches = [
      /^must be a JSON-encoded Ed25519 private JWK \(it is not valid JSON\)$/,
      /^must be a JSON-encoded Ed25519 private JWK \(a JSON object\)$/,
      /^must be an Ed25519 JWK/,
      /^must carry both the private d and the public x member$/,
      /^has a d member that is not 43 unpadded base64url characters/,
      /^has an x member that is not 43 unpadded base64url characters/,
      NOT_PUBLIC_HALF,
    ];
    const sentences = new Set(KEY_VECTORS.map((raw) => kitRule(raw)).filter((s) => s !== null));
    for (const branch of branches) {
      expect(
        [...sentences].some((s) => branch.test(s)),
        String(branch),
      ).toBe(true);
    }
    for (const sentence of sentences) {
      expect(
        branches.some((b) => b.test(sentence)),
        `unlisted branch: ${sentence}`,
      ).toBe(true);
    }
  });
});

/** The wiring: `register()` imports the keys on Node, outside `next build`, and lets it throw. */
describe("instrumentation register() runs the F-22 key import", () => {
  const order: string[] = [];
  const assertion = vi.fn(() => {
    order.push("keys");
  });

  beforeEach(() => {
    order.length = 0;
    assertion.mockClear();
    vi.doMock("@/sentry.server.config", () => ({}));
    vi.doMock("@/sentry.edge.config", () => ({}));
    vi.doMock("@/lib/shutdown.server", () => ({
      registerGracefulShutdown: () => order.push("shutdown"),
    }));
    vi.doMock("@/lib/process-errors.server", () => ({
      registerProcessErrorHandlers: () => order.push("process-errors"),
    }));
    vi.doMock("@/lib/client-ip-source-warning.server", () => ({
      warnIfClientIpSourceUndeclared: () => order.push("client-ip"),
    }));
  });
  afterEach(() => {
    vi.doUnmock("@/sentry.server.config");
    vi.doUnmock("@/sentry.edge.config");
    vi.doUnmock("@/lib/shutdown.server");
    vi.doUnmock("@/lib/process-errors.server");
    vi.doUnmock("@/lib/client-ip-source-warning.server");
    vi.doUnmock("@/lib/env-signing-keys.server");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const mockAssertion = () =>
    vi.doMock("@/lib/env-signing-keys.server", () => ({ assertSigningKeysImport: assertion }));

  it("calls it in the Node runtime, before any process-level handler is installed", async () => {
    mockAssertion();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    const { register } = await import("@/instrumentation");
    await register();
    expect(assertion).toHaveBeenCalledTimes(1);
    expect(assertion).toHaveBeenCalledWith();
    expect(order).toEqual(["keys", "shutdown", "process-errors", "client-ip"]);
  });

  it("propagates its throw, so Next fails startup", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    // The real module, over a bad key in the environment.
    vi.stubEnv("API_JWT_PREVIOUS_PRIVATE_KEY", MISMATCHED);
    const { register } = await import("@/instrumentation");
    await expect(register()).rejects.toThrow(
      /^Invalid Ed25519 signing keys at boot: API_JWT_PREVIOUS_PRIVATE_KEY \(has an x member that is not the public half of its d\)$/,
    );
    // Nothing after it ran: no handler that could log the failure and go on.
    expect(order).toEqual([]);
  });

  it("skips it during `next build` and in the Edge runtime", async () => {
    mockAssertion();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    let { register } = await import("@/instrumentation");
    await register();
    vi.resetModules();
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    ({ register } = await import("@/instrumentation"));
    await register();
    expect(assertion).not.toHaveBeenCalled();
  });
});
