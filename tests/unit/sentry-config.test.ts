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
const addEventProcessor = vi.hoisted(() => vi.fn());
const browserTracingIntegration = vi.hoisted(() => vi.fn(() => ({ name: "BrowserTracing" })));
// The real integration's shape as far as the config relies on it: the rrweb
// options it hands to `record()` (F-23).
const replayIntegration = vi.hoisted(() =>
  vi.fn((): object => ({ name: "Replay", _recordingOptions: {} })),
);
const captureRouterTransitionStart = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({
  init,
  addEventProcessor,
  browserTracingIntegration,
  replayIntegration,
  captureRouterTransitionStart,
}));

const CONFIGS = [
  ["server", () => import("@/sentry.server.config")],
  ["edge", () => import("@/sentry.edge.config")],
  ["browser", () => import("@/instrumentation-client")],
] as const;

const SERVER_CONFIGS = CONFIGS.filter(([name]) => name !== "browser");

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
  addEventProcessor.mockClear();
  replayIntegration.mockClear();
  // The identity assertions hold for the default (`xff`) client-IP source;
  // the CLIENT_IP_SOURCE suite below sets its own.
  vi.stubEnv("CLIENT_IP_SOURCE", "");
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
      urlQueryParams: false,
      httpBodies: [],
    });
    // The deprecated flag is superseded by `dataCollection` (the SDK ignores
    // it once the policy is set) — it must not be re-introduced at all, or a
    // future reader will believe it still does something.
    expect(options.sendDefaultPii).toBeUndefined();
    // The policy also denies the IP-bearing proxy headers the old
    // `sendDefaultPii: false` bridge used to filter (review #22).
    const dc = options.dataCollection as { httpHeaders: { request: { deny: string[] } } };
    expect(dc.httpHeaders.request.deny).toEqual(
      expect.arrayContaining(["x-forwarded-for", "x-real-ip", "forwarded", "x-drk-client-ip"]),
    );
  });

  it("stays disabled with no DSN configured", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    await load();
    expect(initOptions().enabled).toBe(false);
  });
});

/**
 * F-23 (folded from F-17): the header CLIENT_IP_SOURCE names is the client IP,
 * and `x-azure-clientip` matches none of the shared deny rules. The server
 * runtimes read the setting and deny it; the browser, which never receives
 * that header and cannot read server env, keeps the shared policy.
 */
describe.each(SERVER_CONFIGS)("Sentry %s config with CLIENT_IP_SOURCE", (_name, load) => {
  it("denies the configured header at write time and in every hook", async () => {
    vi.stubEnv("CLIENT_IP_SOURCE", "X-Azure-ClientIP");
    await load();
    const options = initOptions() as {
      dataCollection: { httpHeaders: Record<"request" | "response", { deny: string[] }> };
      beforeSend: (event: unknown, hint: unknown) => { request: { headers: object } };
      beforeSendSpan: (span: unknown) => { data: object };
    };
    expect(options.dataCollection.httpHeaders.request.deny).toContain("x-azure-clientip");
    expect(options.dataCollection.httpHeaders.response.deny).toContain("x-azure-clientip");
    const event = options.beforeSend(
      { request: { headers: { "X-Azure-ClientIP": "203.0.113.9", Accept: "*/*" } } },
      {},
    );
    expect(event.request.headers).toEqual({ Accept: "*/*" });
    const span = options.beforeSendSpan({
      span_id: "s",
      trace_id: "t",
      start_timestamp: 0,
      data: { "http.request.header.x_azure_clientip": "203.0.113.9", "http.method": "GET" },
    });
    expect(span.data).toEqual({ "http.method": "GET" });
  });

  it.each(["cf-connecting-ip", "xff", "not a header"])(
    "keeps the shared hooks for CLIENT_IP_SOURCE=%s (already denied, or no header)",
    async (value) => {
      vi.stubEnv("CLIENT_IP_SOURCE", value);
      const { SENTRY_DATA_COLLECTION, scrubEvent } = await shared();
      await load();
      expect(initOptions().beforeSend).toBe(scrubEvent);
      expect(initOptions().dataCollection).toBe(SENTRY_DATA_COLLECTION);
    },
  );
});

describe("browser config", () => {
  it("wires the masked replay + tracing integrations and the router hook", async () => {
    const { scrubReplayRecordingEvent } = await shared();
    const mod = await import("@/instrumentation-client");
    expect(replayIntegration).toHaveBeenCalledWith({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      // F-23: hidden inputs (the SSO handoff token) are masked too, and the
      // SDK's own recording frames are scrubbed.
      mask: ['input[type="hidden"]'],
      beforeAddRecordingEvent: scrubReplayRecordingEvent,
    });
    expect(browserTracingIntegration).toHaveBeenCalled();
    expect(mod.onRouterTransitionStart).toBe(captureRouterTransitionStart);
  });

  it("installs the rrweb scrubber and the replay_event processor (F-23)", async () => {
    const { scrubReplayEvent, scrubRrwebEvent } = await shared();
    await import("@/instrumentation-client");
    const integrations = initOptions().integrations as {
      name: string;
      _recordingOptions?: { plugins: { eventProcessor: unknown }[] };
    }[];
    const replay = integrations.find((integration) => integration.name === "Replay")!;
    expect(replay._recordingOptions?.plugins.map((plugin) => plugin.eventProcessor)).toEqual([
      scrubRrwebEvent,
    ]);
    expect(addEventProcessor).toHaveBeenCalledWith(scrubReplayEvent);
  });

  it("leaves Session Replay out when the rrweb scrubber cannot be installed", async () => {
    replayIntegration.mockImplementationOnce(() => ({ name: "Replay" }));
    await import("@/instrumentation-client");
    const integrations = initOptions().integrations as { name: string }[];
    expect(integrations.map((integration) => integration.name)).toEqual(["BrowserTracing"]);
  });
});
