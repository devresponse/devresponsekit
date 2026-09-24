import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
// The real `onRequestError` capture (Vitest resolves `@sentry/nextjs` to its
// server build), fed into a real `@sentry/core` client (hoisted, see .npmrc).
import { captureRequestError } from "@sentry/nextjs";
import {
  ServerRuntimeClient,
  addOutgoingRequestBreadcrumb,
  createStackParser,
  createTransport,
  getCurrentScope,
  getIsolationScope,
  httpHeadersToSpanAttributes,
  requestDataIntegration,
  setCurrentClient,
} from "@sentry/core";
import {
  type SentryScrubbers,
  SENTRY_DATA_COLLECTION,
  createSentryScrubbers,
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  scrubTransaction,
  type TransactionEvent,
} from "@/lib/observability/sentry-shared";

/**
 * F-23, the server channels. `captureRequestError` (what `onRequestError` in
 * src/instrumentation.ts calls) puts Next's raw request path, query and all,
 * in `contexts.nextjs.request_path`, which no scrubber read. And the header
 * `CLIENT_IP_SOURCE` names (folded in from F-17) was denied only if the
 * static rules happened to match it.
 */

const IP = "203.0.113.9";
const TOKEN = "Qx9InviteTokenValue";

/**
 * Captures one error through the real `captureRequestError` and returns the
 * event as it leaves `beforeSend`: a real client with the `RequestData`
 * integration (which turns the request headers captureRequestError records
 * into `event.request.headers`, filtered by the policy).
 */
async function captureThroughSdk(
  scrubbers: Partial<SentryScrubbers>,
  request: { path: string; headers: Record<string, string> },
  beforeCapture?: () => void,
): Promise<ErrorEvent> {
  let sent: ErrorEvent | undefined;
  const client = new ServerRuntimeClient({
    dsn: "https://public@o1.ingest.sentry.io/1",
    integrations: [requestDataIntegration()],
    stackParser: createStackParser(),
    transport: (options) => createTransport(options, () => Promise.resolve({ statusCode: 200 })),
    dataCollection: scrubbers.dataCollection,
    beforeBreadcrumb: scrubbers.beforeBreadcrumb,
    beforeSend: (event, hint) => {
      sent = scrubbers.beforeSend ? scrubbers.beforeSend(event, hint) : event;
      return sent;
    },
  });
  setCurrentClient(client);
  client.init();
  beforeCapture?.();
  captureRequestError(
    new Error("connection timeout"),
    { path: request.path, method: "GET", headers: request.headers },
    { routerKind: "App Router", routePath: "/[locale]/invite", routeType: "render" },
  );
  await client.flush(2000);
  expect(sent, "the SDK sent no event").toBeDefined();
  return sent!;
}

afterEach(() => {
  getCurrentScope().setClient(undefined);
  getIsolationScope().clearBreadcrumbs();
});

const DEFAULT_SCRUBBERS = createSentryScrubbers([]);

describe("contexts.nextjs.request_path (F-23)", () => {
  it("strips the query from an invite path captured by onRequestError", async () => {
    const event = await captureThroughSdk(DEFAULT_SCRUBBERS, {
      path: `/en/invite?token=${TOKEN}&email=alice@example.com`,
      headers: { "user-agent": "ua" },
    });
    expect(event.contexts?.nextjs).toEqual({
      request_path: "/en/invite",
      router_kind: "App Router",
      router_path: "/[locale]/invite",
      route_type: "render",
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain("alice@example.com");
  });

  it("redacts Better Auth's reset token path segment", async () => {
    const event = await captureThroughSdk(DEFAULT_SCRUBBERS, {
      path: `/api/auth/reset-password/${TOKEN}?callbackURL=%2Fen%2Freset-password`,
      headers: {},
    });
    expect(event.contexts?.nextjs?.request_path).toBe("/api/auth/reset-password/[redacted-token]");
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("treats any URL- or path-named context value the same way", () => {
    const event = scrubEvent(
      {
        contexts: {
          custom: {
            page_url: `https://app/en/invite?token=${TOKEN}`,
            resumePath: `/en/sso/confirm?token=${TOKEN}`,
            label: "kept?as-is",
            count: 3,
          },
        },
      } as unknown as ErrorEvent,
      {},
    );
    expect(event.contexts?.custom).toEqual({
      page_url: "https://app/en/invite",
      resumePath: "/en/sso/confirm",
      label: "kept?as-is",
      count: 3,
    });
  });

  it("scrubs the transaction name of an error event too", () => {
    const event = scrubEvent({ transaction: `/en/invite?token=${TOKEN}` } as ErrorEvent, {});
    expect(event.transaction).toBe("/en/invite");
  });
});

/**
 * The server SDK's outgoing-request breadcrumb (`addOutgoingRequestBreadcrumb`
 * for node:http; node-core's fetch breadcrumb builds the same data) keeps a
 * sanitized `url` but copies the query and fragment into `http.query` /
 * `http.fragment`, whatever `dataCollection` says. The MCP gateway's call to
 * /api/v1 carries the tool's arguments in that query.
 */
describe("outgoing-request breadcrumbs (F-23)", () => {
  type OutgoingRequest = Parameters<typeof addOutgoingRequestBreadcrumb>[0];
  type IncomingResponse = Parameters<typeof addOutgoingRequestBreadcrumb>[1];
  const recordOutgoingRequest = () =>
    addOutgoingRequestBreadcrumb(
      {
        method: "GET",
        protocol: "https:",
        host: "app.example",
        path: `/api/v1/users?email=alice@example.com&token=${TOKEN}#${TOKEN}`,
        getHeaders: () => ({}),
      } as unknown as OutgoingRequest,
      { statusCode: 200 } as IncomingResponse,
    );
  const SCRUBBED = {
    status_code: 200,
    url: "https://app.example/api/v1/users",
    "http.method": "GET",
  };
  const onlyCrumb = (event: ErrorEvent) => {
    expect(event.breadcrumbs).toHaveLength(1);
    return event.breadcrumbs![0]!.data;
  };

  it("is needed: the closed write-time policy still records the query and fragment", async () => {
    const event = await captureThroughSdk(
      { dataCollection: SENTRY_DATA_COLLECTION },
      { path: "/en/app", headers: {} },
      recordOutgoingRequest,
    );
    expect(onlyCrumb(event)).toMatchObject({
      "http.query": `?email=alice@example.com&token=${TOKEN}`,
      "http.fragment": `#${TOKEN}`,
    });
  });

  it("drops them as the breadcrumb is recorded", async () => {
    const event = await captureThroughSdk(
      DEFAULT_SCRUBBERS,
      { path: "/en/app", headers: {} },
      () => {
        recordOutgoingRequest();
        expect(getIsolationScope().getScopeData().breadcrumbs[0]?.data).toEqual(SCRUBBED);
      },
    );
    expect(onlyCrumb(event)).toEqual(SCRUBBED);
    expect(JSON.stringify(event)).not.toContain(TOKEN);
    expect(JSON.stringify(event)).not.toContain("alice@example.com");
  });

  it("drops them in beforeSend when the breadcrumb hook did not run", async () => {
    const event = await captureThroughSdk(
      { dataCollection: SENTRY_DATA_COLLECTION, beforeSend: scrubEvent },
      { path: "/en/app", headers: {} },
      recordOutgoingRequest,
    );
    expect(onlyCrumb(event)).toEqual(SCRUBBED);
  });
});

describe("createSentryScrubbers: the CLIENT_IP_SOURCE header (F-23, from F-17)", () => {
  // Azure Front Door's client-IP header: no `-ip` suffix, no listed name.
  const AZURE = "x-azure-clientip";

  it("returns the shared policy and hooks when there is nothing to add", () => {
    for (const extra of [
      [],
      [""],
      ["  "],
      ["x-real-ip"],
      ["CF-Connecting-IP"],
      ["x_forwarded_for"],
    ]) {
      expect(createSentryScrubbers(extra)).toEqual({
        dataCollection: SENTRY_DATA_COLLECTION,
        beforeSend: scrubEvent,
        beforeSendTransaction: scrubTransaction,
        beforeSendSpan: scrubSpan,
        beforeBreadcrumb: scrubBreadcrumb,
      });
    }
  });

  it("is needed: the shared rules ship that header", async () => {
    const event = await captureThroughSdk(DEFAULT_SCRUBBERS, {
      path: "/en/app",
      headers: { [AZURE]: IP, "user-agent": "ua" },
    });
    expect(event.request?.headers?.[AZURE]).toBe(IP);
  });

  it("drops the header from a captured server error, at write time and in beforeSend", async () => {
    const scrubbers = createSentryScrubbers([" X-Azure-ClientIP "]);
    const event = await captureThroughSdk(scrubbers, {
      path: "/en/app",
      headers: { [AZURE]: IP, "user-agent": "ua" },
    });
    expect(event.request?.headers).toEqual({ "user-agent": "ua" });
    expect(JSON.stringify(event)).not.toContain(IP);
    // Write time: the SDK's own filter already withholds it.
    const recorded = httpHeadersToSpanAttributes(
      { [AZURE]: IP, "user-agent": "ua" },
      new ServerRuntimeClient({
        integrations: [],
        stackParser: createStackParser(),
        transport: (options) => createTransport(options, () => Promise.resolve({})),
        dataCollection: scrubbers.dataCollection,
      }).getDataCollectionOptions(),
      "request",
    );
    expect(recorded["http.request.header.x_azure_clientip"]).not.toBe(IP);
    expect(recorded["http.request.header.user_agent"]).toBe("ua");
  });

  it("drops the header's span attributes from transactions and standalone spans", () => {
    const scrubbers = createSentryScrubbers([AZURE]);
    const data = () => ({
      "http.request.header.x_azure_clientip": IP,
      "http.request.header.user_agent": "ua",
    });
    const tx = scrubbers.beforeSendTransaction(
      {
        type: "transaction",
        request: { headers: { "X-Azure-ClientIP": IP, Accept: "text/html" } },
        contexts: { trace: { trace_id: "t", span_id: "s", data: data() } },
        spans: [{ span_id: "c", trace_id: "t", start_timestamp: 0, data: data() }],
      } as unknown as TransactionEvent,
      {},
    );
    expect(JSON.stringify(tx)).not.toContain(IP);
    expect(tx.request?.headers).toEqual({ Accept: "text/html" });
    const span = scrubbers.beforeSendSpan({
      span_id: "c",
      trace_id: "t",
      start_timestamp: 0,
      data: data(),
    } as Parameters<typeof scrubSpan>[0]);
    expect(span.data).toEqual({ "http.request.header.user_agent": "ua" });
  });

  it("matches an underscore spelling as sent and as an attribute key", async () => {
    const scrubbers = createSentryScrubbers(["x_edge_clientaddr"]);
    const event = await captureThroughSdk(scrubbers, {
      path: "/en/app",
      headers: { x_edge_clientaddr: IP, "user-agent": "ua" },
    });
    expect(JSON.stringify(event)).not.toContain(IP);
  });

  it("does not widen the shared browser policy", () => {
    createSentryScrubbers([AZURE]);
    const deny = (SENTRY_DATA_COLLECTION.httpHeaders as { request: { deny: string[] } }).request
      .deny;
    expect(deny).not.toContain(AZURE);
  });
});

/**
 * F-23: path segments are redacted by route, not by shape (see
 * RESET_PATH_TOKEN_RE in sentry-shared.ts). That is sound only while no app
 * route takes a secret as a path segment, so every dynamic directory under
 * src/app is listed here, by its path, with what its segment holds. Keyed on
 * the path and not the segment name: 14 directories are already `[id]`, so a
 * name-only list stays green when a new route such as `magic-link/[id]` takes
 * a one-time token. Any new dynamic directory, whatever its name, fails until
 * someone decides whether it needs a redaction rule. Better Auth's own routes
 * under `api/auth/[...all]` are pinned by
 * tests/security/better-auth-endpoint-classification.
 */
const RECORD_ID = "a record id (uuid), not a secret";
const APP_DYNAMIC_ROUTES: Record<string, string> = {
  "[locale]": "a locale code",
  "[locale]/(auth)/sign-in/[org]": "an organization slug",
  "[locale]/(secure)/app/administrator/email/templates/[templateId]": RECORD_ID,
  "[locale]/(secure)/app/administrator/enterprise-apps/[appId]": RECORD_ID,
  "[locale]/(secure)/app/administrator/groups/[groupId]": RECORD_ID,
  "[locale]/(secure)/app/administrator/organizations/[orgId]": RECORD_ID,
  "[locale]/(secure)/app/administrator/roles/[roleId]": RECORD_ID,
  "[locale]/(secure)/app/administrator/users/[userId]": RECORD_ID,
  "[locale]/(secure)/app/docs/[...slug]": "a docs page path",
  "[locale]/(secure)/app/help/[...slug]": "a help page path",
  "api/administrator/api-keys/[id]": "an API key's record id, never the key",
  "api/administrator/email/outbox/[id]": RECORD_ID,
  "api/administrator/email/templates/[id]": RECORD_ID,
  "api/administrator/enterprise-apps/[id]": RECORD_ID,
  "api/administrator/export/[resource]": "an export resource name",
  "api/administrator/groups/[id]": RECORD_ID,
  "api/administrator/mcp-agents/[id]": "the agent's OAuth client uuid, never its secret",
  "api/administrator/organizations/[id]": RECORD_ID,
  "api/administrator/organizations/[id]/invitations/[invitationId]":
    "an invitation's record id, never its token",
  "api/administrator/permissions/[id]": RECORD_ID,
  "api/administrator/roles/[id]": RECORD_ID,
  "api/administrator/users/[id]": RECORD_ID,
  "api/administrator/users/[id]/sessions/[sessionId]": "a session's record id, never its token",
  "api/auth/[...all]": "Better Auth's catch-all (see the endpoint classification test)",
  "api/docs/asset/[...path]": "a docs asset path",
  "api/help/asset/[...path]": "a help asset path",
  "api/v1/admin/api-keys/[id]": "an API key's record id, never the key",
  "api/v1/admin/oauth-clients/[id]": "an OAuth client's uuid, never its secret",
  "api/v1/me/api-keys/[id]": "an API key's record id, never the key",
  "api/v1/users/[id]": RECORD_ID,
};

/** Every directory under `root` whose name is a dynamic segment, as a `/`-joined path from `root`. */
function dynamicRouteDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: readonly string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = [...rel, entry.name];
      if (/^\[+[^\]]+\]+$/.test(entry.name)) found.push(path.join("/"));
      walk(join(dir, entry.name), path);
    }
  };
  walk(root, []);
  return found.sort();
}

describe("secret-free route segments (F-23)", () => {
  it("lists every dynamic route under src/app by its path, not its segment name", () => {
    const appDir = fileURLToPath(new URL("../../src/app", import.meta.url));
    expect(dynamicRouteDirs(appDir)).toEqual(Object.keys(APP_DYNAMIC_ROUTES).sort());
  });
});
