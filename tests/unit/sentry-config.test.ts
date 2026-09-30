import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Not stubbed: the real SDK core and the server and edge SDKs under
// `@sentry/nextjs`, to run each config's options through (R11).
import {
  type BaseTransportOptions,
  type SerializedStreamedSpanContainer,
  createStackParser,
  createTransport,
  getClient,
  getCurrentScope,
  parseEnvelope,
  setCurrentClient,
  startSpan,
} from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import { type NodeOptions, init as nodeInit } from "@sentry/node";
import { type VercelEdgeOptions, init as edgeInit } from "@sentry/vercel-edge";

/**
 * Review #22: every Sentry runtime config (Node server, Edge, browser) must
 * install the scrubbers for ALL event kinds — errors (`beforeSend`), spans
 * (`beforeSendSpan`; Sentry 11 streams spans and sends no transaction events,
 * R11), and breadcrumbs — and hand the SDK the closed write-time
 * `dataCollection` policy. Sentry is stubbed at the `@sentry/nextjs` boundary
 * so importing a config exercises its real `Sentry.init({...})` call without a
 * DSN or a network.
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
  getCurrentScope().setClient(undefined);
});

/** Builds and installs a client from the options a test hands it. */
type StartClient = (options: Record<string, unknown>) => void;

/** A bare core client, which reads no environment variable. */
const startCoreClient: StartClient = (options) => {
  const client = new ServerRuntimeClient({
    ...(options as Omit<ConstructorParameters<typeof ServerRuntimeClient>[0], "stackParser">),
    stackParser: createStackParser(),
  });
  setCurrentClient(client);
  client.init();
};

/**
 * The SDKs `@sentry/nextjs` runs on the server and the edge, which fill an
 * option a config leaves unset from the environment. Their default
 * integrations (the Node HTTP instrumentation among them) are left out.
 */
const RUNTIME_SDK: Record<"server" | "edge", StartClient> = {
  server: (options) => nodeInit({ ...options, defaultIntegrations: false } as NodeOptions),
  edge: (options) =>
    edgeInit({
      ...options,
      defaultIntegrations: false,
      enableOpenTelemetrySetup: false,
    } as VercelEdgeOptions),
};

/**
 * Runs one span with a token in its name and URL through a REAL Sentry 11
 * client built from a config's own `Sentry.init` options, and returns the
 * lifecycle the client resolved, the type of every item the transport
 * received, the spans among them, each envelope's trace header (the dynamic
 * sampling context, which names the root span) and everything sent, as JSON.
 * Only what a test harness must replace is replaced: the DSN, the transport
 * and a 100% sample rate. Whatever else the config passes — the trace
 * lifecycle and the integrations (the browser's tracing and replay ones are
 * the stubs above, which install nothing) — is the config's own.
 */
async function streamWith(options: Record<string, unknown>, start = startCoreClient) {
  const bodies: (string | Uint8Array)[] = [];
  start({
    ...options,
    dsn: "https://public@o1.ingest.sentry.io/1",
    enabled: true,
    tracesSampleRate: 1,
    transport: (transportOptions: BaseTransportOptions) =>
      createTransport(transportOptions, (request) => {
        bodies.push(request.body);
        return Promise.resolve({ statusCode: 200 });
      }),
  });
  const client = getClient()!;
  startSpan(
    { name: "GET /en/invite?token=InviteTok3n", attributes: { "url.query": "token=InviteTok3n" } },
    () => undefined,
  );
  await client.close(2000);
  const envelopes = bodies.map(
    (body) =>
      parseEnvelope(body) as [{ trace?: { transaction?: string } }, [{ type: string }, unknown][]],
  );
  const items = envelopes.flatMap(([, envelopeItems]) => envelopeItems);
  return {
    lifecycle: client.getOptions().traceLifecycle,
    types: items.map(([header]) => header.type),
    spans: items
      .filter(([header]) => header.type === "span")
      .flatMap(([, payload]) => (payload as SerializedStreamedSpanContainer).items),
    traces: envelopes.map(([header]) => header.trace),
    sent: JSON.stringify(envelopes),
  };
}

describe.each(CONFIGS)("Sentry %s config", (_name, load) => {
  it("installs the scrubbers for errors, spans, and breadcrumbs", async () => {
    const { scrubBreadcrumb, scrubEvent, scrubSpan } = await shared();
    await load();
    const options = initOptions();
    expect(options.beforeSend).toBe(scrubEvent);
    expect(options.beforeSendSpan).toBe(scrubSpan);
    expect(options.beforeBreadcrumb).toBe(scrubBreadcrumb);
    // R11: and the one that scrubs the root span's name out of the trace header.
    const integrations = options.integrations as { name: string }[] | undefined;
    expect(integrations?.map((integration) => integration.name)).toContain(
      "ScrubDynamicSamplingContext",
    );
  });

  /**
   * R11: Sentry 11 calls `beforeSendSpan` only when its shape matches the
   * trace lifecycle (streamed spans by default; `withStaticSpan` callbacks
   * under `traceLifecycle: "static"`) and silently skips it otherwise, and
   * under the static lifecycle it builds transaction events, which only
   * `beforeSendTransaction` would see. So the config pins the streaming
   * lifecycle, and the hook it passes must be one the real SDK calls.
   */
  it("streams spans through a beforeSendSpan the real SDK calls (R11)", async () => {
    await load();
    const options = initOptions();
    expect(options.traceLifecycle).toBe("stream");
    expect(options).not.toHaveProperty("beforeSendTransaction");
    const { types, spans, traces, sent } = await streamWith(options);
    expect(types).toEqual(["span"]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("GET /en/invite");
    expect(spans[0]?.attributes).not.toHaveProperty(["url.query"]);
    expect(traces.map((trace) => trace?.transaction)).toEqual(["GET /en/invite"]);
    expect(sent).not.toContain("InviteTok3n");
  });

  it("passes the closed write-time collection policy (no cookies / query / bodies / user info)", async () => {
    const { SENTRY_DATA_COLLECTION } = await shared();
    await load();
    const options = initOptions();
    expect(options.dataCollection).toBe(SENTRY_DATA_COLLECTION);
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      urlQueryParams: false,
      httpBodies: [],
      queues: false,
    });
    // The old flag is superseded by `dataCollection` (Sentry 11 removed it) —
    // it must not be re-introduced at all, or a future reader will believe it
    // still does something.
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
 * R11: the server and edge SDKs take an unset `traceLifecycle` from
 * SENTRY_TRACE_LIFECYCLE (the browser SDK reads no such variable). Set to
 * "static", which is what Sentry's own warning suggests, it would turn every
 * span into a transaction event that no hook scrubs and silently skip
 * `beforeSendSpan`. So each config's options go through its runtime's real
 * `init` with the variable set, where the bare core client above never reads it.
 */
describe.each(SERVER_CONFIGS)(
  "Sentry %s config with SENTRY_TRACE_LIFECYCLE=static",
  (name, load) => {
    it("still streams every span through the scrubber (R11)", async () => {
      vi.stubEnv("SENTRY_TRACE_LIFECYCLE", "static");
      await load();
      const sent = await streamWith(initOptions(), RUNTIME_SDK[name as "server" | "edge"]);
      expect(sent.lifecycle).toBe("stream");
      expect(sent.types).toEqual(["span"]);
      expect(sent.spans[0]?.name).toBe("GET /en/invite");
      expect(sent.sent).not.toContain("InviteTok3n");
    });
  },
);

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
      beforeSendSpan: (span: unknown) => { attributes: object };
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
      name: "GET",
      start_timestamp: 0,
      status: "ok",
      is_segment: true,
      attributes: {
        "http.request.header.x-azure-clientip": ["203.0.113.9"],
        "http.request.method": "GET",
      },
    });
    expect(span.attributes).toEqual({ "http.request.method": "GET" });
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
    expect(integrations.map((integration) => integration.name)).toEqual([
      "BrowserTracing",
      "ScrubDynamicSamplingContext",
    ]);
  });
});
