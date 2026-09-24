import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-26: `register()` validates the whole server env schema at Node boot.
 *
 * `getServerEnv()` used to run lazily, at the first import of a module that
 * reads it, so an instance with an invalid variable (a 20-character
 * BETTER_AUTH_SECRET, a divergent API_JWT_ISSUER under MCP_ENABLED) started,
 * passed liveness and readiness, and answered 500 on every page that touched
 * auth, while the docs promised it "fails fast at boot". Pinned: the check
 * runs in the Node runtime before the F-22 key import and before any
 * process-level handler, it throws (so Next fails startup) with the key and
 * its rule but never the value, and it is skipped during `next build` and in
 * the Edge runtime.
 */
describe("instrumentation register() validates the server env (F-26)", () => {
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    vi.doMock("@/sentry.server.config", () => ({}));
    vi.doMock("@/sentry.edge.config", () => ({}));
    vi.doMock("@/lib/env-signing-keys.server", () => ({
      assertSigningKeysImport: () => order.push("keys"),
    }));
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
    vi.doUnmock("@/lib/env-signing-keys.server");
    vi.doUnmock("@/lib/shutdown.server");
    vi.doUnmock("@/lib/process-errors.server");
    vi.doUnmock("@/lib/client-ip-source-warning.server");
    vi.doUnmock("@/lib/env");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const nodeServer = () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
  };

  it("runs first in the Node runtime, before the key import and every handler", async () => {
    vi.doMock("@/lib/env", () => ({ getServerEnv: () => order.push("env") }));
    nodeServer();
    const { register } = await import("@/instrumentation");
    await register();
    expect(order).toEqual(["env", "keys", "shutdown", "process-errors", "client-ip"]);
  });

  it("throws on an invalid env, naming the key and never the value, and nothing after it runs", async () => {
    nodeServer();
    // The real env module, over the review's own example.
    const shortSecret = "twenty-chars-secret!";
    vi.stubEnv("BETTER_AUTH_SECRET", shortSecret);
    const { register } = await import("@/instrumentation");
    const failure = await register().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(
      /^Invalid server environment variables: BETTER_AUTH_SECRET \(/,
    );
    expect((failure as Error).message).not.toContain(shortSecret);
    // No handler that could log the failure and carry on, no key import.
    expect(order).toEqual([]);
  });

  it("passes a valid env through to the rest of boot", async () => {
    nodeServer();
    const { register } = await import("@/instrumentation");
    await register();
    expect(order).toEqual(["keys", "shutdown", "process-errors", "client-ip"]);
  });

  it("skips it during `next build` and in the Edge runtime", async () => {
    const getServerEnv = vi.fn();
    vi.doMock("@/lib/env", () => ({ getServerEnv }));
    vi.stubEnv("BETTER_AUTH_SECRET", "short");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    let { register } = await import("@/instrumentation");
    await register();
    vi.resetModules();
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    ({ register } = await import("@/instrumentation"));
    await register();
    expect(getServerEnv).not.toHaveBeenCalled();
  });
});
