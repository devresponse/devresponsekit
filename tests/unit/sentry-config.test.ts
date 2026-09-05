import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review #22: every Sentry runtime config (Node server, Edge, browser) must
 * install the scrubbers for ALL event kinds — errors (`beforeSend`),
 * transactions (`beforeSendTransaction`), spans (`beforeSendSpan`), and
 * breadcrumbs — and hand the SDK the closed write-time `dataCollection`
 * policy. Sentry is stubbed at the `@sentry/nextjs` boundary so importing a
 * config exercises its real `Sentry.init({...})` call without a DSN or a
 * network.
 */
const init = vi.hoisted(() => vi.fn());
const browserTracingIntegration = vi.hoisted(() => vi.fn(() => ({ name: "BrowserTracing" })));
const replayIntegration = vi.hoisted(() => vi.fn(() => ({ name: "Replay" })));
const captureRouterTransitionStart = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  init,
  browserTracingIntegration,
  replayIntegration,
  captureRouterTransitionStart,
}));

const CONFIGS = [
  ["server", () => import("@/sentry.server.config")],
  ["edge", () => import("@/sentry.edge.config")],
  ["browser", () => import("@/instrumentation-client")],
] as const;

function initOptions(): Record<string, unknown> {
  expect(init).toHaveBeenCalledTimes(1);
  return init.mock.calls[0]?.[0] as Record<string, unknown>;
}

// Each test re-imports its config on a fresh module registry (so `init`
// runs again); the shared module must come from that SAME registry for the
// identity assertions below to hold.
const shared = () => import("@/lib/observability/sentry-shared");

beforeEach(() => {
  vi.resetModules();
  init.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(CONFIGS)("Sentry %s config", (_name, load) => {
  it("installs the scrubbers for errors, transactions, spans, and breadcrumbs", async () => {
    const { scrubBreadcrumb, scrubEvent, scrubSpan, scrubTransaction } = await shared();
    await load();
    const options = initOptions();
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.beforeSendTransaction).toBe(scrubTransaction);
    expect(options.beforeSendSpan).toBe(scrubSpan);
    expect(options.beforeBreadcrumb).toBe(scrubBreadcrumb);
  });

  it("passes the closed write-time collection policy (no cookies / query / bodies / user info)", async () => {
    const { SENTRY_DATA_COLLECTION } = await shared();
    await load();
    const options = initOptions();
    expect(options.dataCollection).toBe(SENTRY_DATA_COLLECTION);
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      queryParams: false,
      httpBodies: [],
    });
    // The deprecated flag is superseded by `dataCollection` (the SDK ignores
    // it once the policy is set); it must never be flipped to true.
    expect(options.sendDefaultPii).not.toBe(true);
  });

  it("stays disabled with no DSN configured", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    await load();
    expect(initOptions().enabled).toBe(false);
  });
});

describe("browser config", () => {
  it("wires the masked replay + tracing integrations and the router hook", async () => {
    const mod = await import("@/instrumentation-client");
    expect(replayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    });
    expect(browserTracingIntegration).toHaveBeenCalled();
    expect(mod.onRouterTransitionStart).toBe(captureRouterTransitionStart);
  });
});
