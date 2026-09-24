import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-17: a self-hosted production deployment that has not declared
 * `CLIENT_IP_SOURCE` gets ONE structured warning at boot. The default trusts
 * X-Forwarded-For, which is safe only behind an edge that overwrites it, and
 * nothing in a request says whether one is there. Vercel (whose edge does)
 * and an explicit value (any valid one, `xff` included) stay quiet.
 */
const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability/logger.server", () => ({ logger: { warn } }));

beforeEach(() => {
  warn.mockClear();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("CLIENT_IP_SOURCE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load() {
  return import("@/lib/client-ip-source-warning.server");
}

describe("warnIfClientIpSourceUndeclared (F-17)", () => {
  it("warns once, structured, in self-hosted production with no CLIENT_IP_SOURCE", async () => {
    const { warnIfClientIpSourceUndeclared, CLIENT_IP_SOURCE_DOCS } = await load();
    expect(warnIfClientIpSourceUndeclared()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toEqual({
      kind: "client-ip-source",
      clientIpSource: "xff",
      trustedProxyCount: 1,
      docs: CLIENT_IP_SOURCE_DOCS,
    });
    expect(CLIENT_IP_SOURCE_DOCS).toBe("docs/configuration.md#reverse-proxy--limits");
    expect(message).toMatch(/CLIENT_IP_SOURCE is unset/);
    expect(message).toMatch(/overwrites the client's X-Forwarded-For/);
  });

  it("treats a blank value as unset", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "   ");
    const { warnIfClientIpSourceUndeclared } = await load();
    expect(warnIfClientIpSourceUndeclared()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is silenced by ANY explicit value, `xff` included", async () => {
    const { warnIfClientIpSourceUndeclared } = await load();
    for (const value of ["xff", "x-real-ip", "cf-connecting-ip"]) {
      vi.stubEnv("CLIENT_IP_SOURCE", value);
      expect(warnIfClientIpSourceUndeclared(), value).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet on Vercel, whose edge overwrites X-Forwarded-For", async () => {
    vi.stubEnv("VERCEL", "1");
    const { warnIfClientIpSourceUndeclared } = await load();
    expect(warnIfClientIpSourceUndeclared()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet outside production", async () => {
    const { warnIfClientIpSourceUndeclared } = await load();
    for (const env of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(warnIfClientIpSourceUndeclared(), env).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

/** The wiring: `register()` runs the check once, on Node, outside `next build`. */
describe("instrumentation register() runs the F-17 check", () => {
  const check = vi.fn();

  beforeEach(() => {
    check.mockClear();
    vi.doMock("@/sentry.server.config", () => ({}));
    vi.doMock("@/sentry.edge.config", () => ({}));
    vi.doMock("@/lib/shutdown.server", () => ({ registerGracefulShutdown: vi.fn() }));
    vi.doMock("@/lib/process-errors.server", () => ({ registerProcessErrorHandlers: vi.fn() }));
    vi.doMock("@/lib/client-ip-source-warning.server", () => ({
      warnIfClientIpSourceUndeclared: check,
    }));
  });
  afterEach(() => {
    vi.doUnmock("@/sentry.server.config");
    vi.doUnmock("@/sentry.edge.config");
    vi.doUnmock("@/lib/shutdown.server");
    vi.doUnmock("@/lib/process-errors.server");
    vi.doUnmock("@/lib/client-ip-source-warning.server");
  });

  it("calls it in the Node runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    const { register } = await import("@/instrumentation");
    await register();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("skips it during `next build` and in the Edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    let { register } = await import("@/instrumentation");
    await register();
    vi.resetModules();
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    ({ register } = await import("@/instrumentation"));
    await register();
    expect(check).not.toHaveBeenCalled();
  });
});
