import { afterEach, describe, it, expect } from "vitest";
import type { ErrorEvent, Breadcrumb } from "@sentry/nextjs";
// `@sentry/core` is the (hoisted, see .npmrc) engine behind `@sentry/nextjs`;
// the SDK-parity suites below drive its REAL span-attribute writer and its
// REAL span-streaming pipeline, so the shapes under test are the ones
// production emits, not hand-written ones. Sentry 11 moved the server client
// to `@sentry/core/server`.
import {
  type ResolvedDataCollection,
  type SerializedStreamedSpan,
  type SerializedStreamedSpanContainer,
  captureException,
  createStackParser,
  createTransport,
  getCurrentScope,
  httpHeadersToSpanAttributes,
  parseEnvelope,
  requestDataIntegration,
  setCurrentClient,
  startSpan,
  withIsolationScope,
} from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import {
  type StreamedSpanJSON,
  SENTRY_DATA_COLLECTION,
  redactText,
  scrubEvent,
  scrubBreadcrumb,
  scrubSpan,
  scrubSpanData,
  scrubDynamicSamplingContextIntegration,
  parseSampleRate,
} from "@/lib/observability/sentry-shared";

type Hint = Parameters<typeof scrubEvent>[1];
const HINT = {} as Hint;
const asEvent = (e: unknown) => e as ErrorEvent;
const asCrumb = (c: unknown) => c as Breadcrumb;
const RESET_TOKEN = "Qx9ResetTokenValue123";

/**
 * P0-3: the Sentry PII scrubber must catch every channel an email/token
 * can ride out on — request, user, message, exception values, and
 * breadcrumbs — not just request/user.
 */
describe("redactText", () => {
  it("redacts email addresses", () => {
    expect(redactText("login failed for alice@example.com")).toBe(
      "login failed for [redacted-email]",
    );
  });
  it("redacts API keys, client secrets, and JWTs", () => {
    expect(redactText("key=drk_live_AbCd1234EfGh")).toContain("[redacted-token]");
    expect(redactText("secret=drkcsec_XYZ789abc")).toContain("[redacted-token]");
    expect(redactText("client=drkc_AbC123")).toContain("[redacted-token]");
    expect(redactText("auth eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe")).toContain("[redacted-token]");
  });
  it("leaves clean text untouched", () => {
    expect(redactText("nothing sensitive here")).toBe("nothing sensitive here");
  });
});

describe("scrubEvent", () => {
  it("drops cookies, auth/cookie headers, query string, and user PII", () => {
    const out = scrubEvent(
      asEvent({
        request: {
          cookies: { session: "x" },
          query_string: "email=z@z.com",
          url: "https://app/sign-in?returnTo=/a&email=z@z.com",
          headers: { Authorization: "Bearer t", Cookie: "c=1", Accept: "application/json" },
        },
        user: { id: "u1", email: "z@z.com", ip_address: "1.2.3.4", username: "zed" },
      }),
      HINT,
    );
    const req = out.request as Record<string, unknown>;
    const headers = req.headers as Record<string, unknown>;
    expect(req.cookies).toBeUndefined();
    expect(req.query_string).toBeUndefined();
    expect(req.url).toBe("https://app/sign-in");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Cookie).toBeUndefined();
    expect(headers.Accept).toBe("application/json");
    const user = out.user as Record<string, unknown>;
    expect(user.email).toBeUndefined();
    expect(user.ip_address).toBeUndefined();
    expect(user.username).toBeUndefined();
    expect(user.id).toBe("u1");
  });

  it("drops every IP-bearing proxy header but keeps benign ones (review #22)", () => {
    const out = scrubEvent(
      asEvent({
        request: {
          headers: {
            "X-Forwarded-For": "203.0.113.9, 10.0.0.1",
            "x-real-ip": "203.0.113.9",
            "CF-Connecting-IP": "203.0.113.9",
            "True-Client-Ip": "203.0.113.9",
            "X-Vercel-Forwarded-For": "203.0.113.9",
            Forwarded: "for=203.0.113.9;proto=https",
            Via: "1.1 vercel",
            "X-Forwarded-User": "eve",
            "Remote-Addr": "203.0.113.9",
            "X-Forwarded-Host": "app.example",
            "User-Agent": "ua",
            Host: "app.example",
            "Content-Type": "application/json",
          },
        },
      }),
      HINT,
    );
    const headers = (out.request as Record<string, unknown>).headers as Record<string, unknown>;
    expect(Object.keys(headers).sort()).toEqual(["Content-Type", "Host", "User-Agent"]);
    expect(JSON.stringify(out)).not.toContain("203.0.113.9");
  });

  it("drops the referer header, the request body, and a reset-token path segment (review #22)", () => {
    const out = scrubEvent(
      asEvent({
        request: {
          url: `https://app/reset-password/${RESET_TOKEN}?callbackURL=/x`,
          data: { password: "hunter2" },
          headers: {
            Referer: "https://app/en/invite?token=abc",
            referrer: "https://app/sign-in?email=a@b.com",
            "User-Agent": "ua",
          },
        },
      }),
      HINT,
    );
    const req = out.request as Record<string, unknown>;
    const headers = req.headers as Record<string, unknown>;
    expect(req.url).toBe("https://app/reset-password/[redacted-token]");
    expect(req.data).toBeUndefined();
    expect(headers.Referer).toBeUndefined();
    expect(headers.referrer).toBeUndefined();
    expect(headers["User-Agent"]).toBe("ua");
  });

  it("redacts the message and every exception value", () => {
    const out = scrubEvent(
      asEvent({
        message: "delivery failed for bob@x.com",
        exception: { values: [{ value: "resend 400: to=carol@x.com key=drk_live_Zz99" }] },
      }),
      HINT,
    );
    expect(out.message).not.toContain("bob@x.com");
    const ex = out.exception?.values?.[0]?.value ?? "";
    expect(ex).not.toContain("carol@x.com");
    expect(ex).not.toContain("drk_live_Zz99");
  });

  it("scrubs breadcrumb URLs (query stripped) and messages", () => {
    const out = scrubEvent(
      asEvent({
        breadcrumbs: [
          {
            message: "GET /sign-in?email=dan@x.com",
            data: { url: "https://app/api?token=eyJa.eyJb.sig" },
          },
        ],
      }),
      HINT,
    );
    const crumb = out.breadcrumbs?.[0] as Breadcrumb;
    expect((crumb.data as Record<string, unknown>).url).toBe("https://app/api");
    expect(crumb.message).not.toContain("dan@x.com");
  });
});

/**
 * Review #22, ported to Sentry 11 (R11). Sentry 11 streams spans by default:
 * there are no transaction events, every span (the root span included) goes
 * through `beforeSendSpan` on its own, and it arrives as a `StreamedSpanJSON`
 * — `name` / `attributes`, where Sentry 10 had `description` / `data`. What a
 * transaction carried in `request` and `contexts.trace.data` now rides on the
 * ROOT span's attributes, and header values are string arrays. A scrubber
 * still reading `data` / `description` passed every one of these unscrubbed.
 *
 * The fixture is typed against the installed SDK's own span type, so a shape
 * change fails the typecheck; the real-pipeline suite further down produces
 * the same spans through the SDK itself.
 */
describe("scrubSpan: Sentry 11 streamed spans (R11)", () => {
  const JWT = "eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe";
  const IP = "203.0.113.9";

  function rootSpan(): StreamedSpanJSON {
    return {
      trace_id: "t",
      span_id: "s0",
      name: `GET /en/invite?token=${JWT}`,
      start_timestamp: 0,
      status: "ok",
      is_segment: true,
      attributes: {
        "sentry.op": "http.server",
        "sentry.segment.name": `GET /en/invite?token=${JWT}`,
        "url.full": `https://app/en/invite?token=${JWT}&returnTo=/admin`,
        "url.path": "/en/invite",
        "url.query": `token=${JWT}&returnTo=/admin`,
        "url.fragment": "#access_token=abc",
        "http.request.method": "GET",
        // Sentry 11 header attributes: dashes kept, values are arrays, every
        // cookie in ONE attribute.
        "http.request.header.cookie": ["better-auth.session_token=sess", "theme=dark"],
        "http.request.header.authorization": [`Bearer ${JWT}`],
        "http.request.header.proxy-authorization": [`Basic ${JWT}`],
        "http.request.header.referer": ["https://app/sign-in?returnTo=/admin&email=eve@x.com"],
        // F-70: the proxy-stamped request target carries the page's query.
        "http.request.header.x-drk-request-target": ["/en/app/administrator/users?q=eve@x.com"],
        "http.request.header.x-forwarded-for": [`${IP}, 10.0.0.1`],
        "http.request.header.x-real-ip": [IP],
        "http.request.header.user-agent": ["ua"],
        "http.request.header.x-note": ["contact bob@x.com", `key drk_live_AbC123`],
        "http.response.header.set-cookie": ["better-auth.session_token=sess; Path=/; HttpOnly"],
        "http.response.status_code": 200,
        "http.request.body.data": '{"password":"hunter2"}',
        "client.address": IP,
        "network.peer.address": IP,
        // Copied from the scope's user onto every span (captureSpan.js).
        "user.id": "u1",
        "user.email": "eve@x.com",
        "user.ip_address": IP,
        "user.name": "eve",
        "sentry.sdk.integrations": ["RequestData", "SpanStreaming"],
      },
    };
  }

  function childSpans(): StreamedSpanJSON[] {
    const common = { trace_id: "t", start_timestamp: 1, status: "ok", is_segment: false } as const;
    return [
      {
        ...common,
        span_id: "s1",
        parent_span_id: "s0",
        name: "GET https://api/x?api_key=drk_live_AbC123&email=bob@x.com",
        attributes: {
          "sentry.op": "http.client",
          "sentry.segment.name": `GET /en/invite?token=${JWT}`,
          "url.full": "https://api/x?api_key=drk_live_AbC123",
          "url.query": "api_key=drk_live_AbC123",
          "http.request.header.x-api-key": ["drk_live_AbC123"],
          "sso.token": "opaque-secret",
          "db.query.text": "select 1",
          "http.response.status_code": 200,
        },
      },
      {
        ...common,
        span_id: "s2",
        parent_span_id: "s0",
        name: `POST /reset-password/${RESET_TOKEN}`,
        attributes: { "url.full": `https://app/reset-password/${RESET_TOKEN}?callbackURL=/` },
      },
    ];
  }

  const scrubAll = () => [rootSpan(), ...childSpans()].map(scrubSpan);

  it("scrubs the root span's request attributes: URL, query, headers, cookies, body, IP, user", () => {
    const span = rootSpan();
    expect(scrubSpan(span)).toBe(span);
    expect(span.attributes).toEqual({
      "sentry.op": "http.server",
      "sentry.segment.name": "GET /en/invite",
      "url.full": "https://app/en/invite",
      "url.path": "/en/invite",
      "http.request.method": "GET",
      "http.request.header.user-agent": ["ua"],
      "http.request.header.x-note": ["contact [redacted-email]", "key [redacted-token]"],
      "http.response.status_code": 200,
      "user.id": "u1",
      "sentry.sdk.integrations": ["RequestData", "SpanStreaming"],
    });
  });

  it("scrubs every span's name, the root span's too, and the sentry.segment.name copy", () => {
    const [root, s1, s2] = scrubAll() as [StreamedSpanJSON, StreamedSpanJSON, StreamedSpanJSON];
    expect(root.name).toBe("GET /en/invite");
    expect(s1.name).toBe("GET https://api/x");
    expect(s1.attributes["sentry.segment.name"]).toBe("GET /en/invite");
    expect(s2.name).toBe("POST /reset-password/[redacted-token]");
    expect(s2.attributes["url.full"]).toBe("https://app/reset-password/[redacted-token]");
  });

  it("drops or redacts each child span's secrets and keeps the rest", () => {
    const s1 = scrubSpan(childSpans()[0]!);
    expect(s1.attributes).toEqual({
      "sentry.op": "http.client",
      "sentry.segment.name": "GET /en/invite",
      "url.full": "https://api/x",
      "sso.token": "[redacted]",
      "db.query.text": "select 1",
      "http.response.status_code": 200,
    });
  });

  it("leaves nothing token-like anywhere in any span", () => {
    const json = JSON.stringify(scrubAll());
    expect(json).not.toContain(JWT);
    expect(json).not.toContain(RESET_TOKEN);
    expect(json).not.toContain("drk_live_");
    expect(json).not.toContain("sess");
    expect(json).not.toContain("@x.com");
    expect(json).not.toContain("returnTo");
    expect(json).not.toContain(IP);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("eve");
  });

  // Sentry 11 sends a span UNMODIFIED when `beforeSendSpan` throws
  // (applyBeforeSendSpanCallback), so the scrubber must not.
  it("fails closed: a span it cannot finish loses its attributes and its name", () => {
    const span = rootSpan();
    Object.defineProperty(span.attributes, "exploding", {
      enumerable: true,
      get: () => {
        throw new Error("attribute getter threw");
      },
    });
    expect(() => scrubSpan(span)).not.toThrow();
    expect(span.attributes).toEqual({});
    expect(span.name).toBe("[redacted]");
  });
});

describe("scrubSpanData", () => {
  it("tolerates a missing bag and keeps non-string values", () => {
    expect(() => scrubSpanData(undefined)).not.toThrow();
    const d: Record<string, unknown> = {
      n: 1,
      ok: true,
      list: ["x", 2, null],
      "http.password": "p",
    };
    scrubSpanData(d);
    expect(d).toEqual({ n: 1, ok: true, list: ["x", 2, null], "http.password": "[redacted]" });
  });

  it("redacts every string of an array value and query-strips an array of URLs (R11)", () => {
    const d: Record<string, unknown> = {
      "http.request.header.x-note": ["mail bob@x.com", "fine", 3],
      "url.full": [`https://app/en/invite?token=abc`, `https://app/reset-password/${RESET_TOKEN}`],
    };
    scrubSpanData(d);
    expect(d).toEqual({
      "http.request.header.x-note": ["mail [redacted-email]", "fine", 3],
      "url.full": ["https://app/en/invite", "https://app/reset-password/[redacted-token]"],
    });
  });

  it("strips the query from every URL attribute and drops fragments", () => {
    const d: Record<string, unknown> = {
      // Sentry 10's browser fetch / XHR key, and the Sentry 11 one.
      url: "https://app/api/sso/consume?token=opaque123&returnTo=/admin#access_token=abc",
      "url.full": "https://app/api/sso/consume?token=opaque123",
      "http.url": "https://app/api/sso/consume?token=opaque123",
      "url.query": "token=opaque123",
      "http.query": "?token=opaque123",
      "http.fragment": "#access_token=abc",
      "url.fragment": "#access_token=abc",
      type: "fetch",
      "http.request.method": "GET",
    };
    scrubSpanData(d);
    expect(d).toEqual({
      url: "https://app/api/sso/consume",
      "url.full": "https://app/api/sso/consume",
      "http.url": "https://app/api/sso/consume",
      type: "fetch",
      "http.request.method": "GET",
    });
  });

  // review #77 exported `stripQuery` for the CSP sink and made it cut the
  // FRAGMENT as well — a hash can carry an implicit-flow token or a returnTo,
  // and a `document-uri` really does arrive with one.
  it("cuts a fragment that is attached directly to a URL attribute", () => {
    const d: Record<string, unknown> = {
      "url.full": "https://app/en/callback#access_token=abc.def.ghi&state=x",
      "http.route": "/en/callback#frag",
    };
    scrubSpanData(d);
    expect(d["url.full"]).toBe("https://app/en/callback");
    expect(d["http.route"]).toBe("/en/callback");
  });

  it("drops every client-IP and user attribute spelling the SDK / OTel write", () => {
    const d: Record<string, unknown> = {
      "client.address": "203.0.113.9",
      "network.peer.address": "203.0.113.9",
      "http.client_ip": "203.0.113.9",
      "net.peer.ip": "203.0.113.9",
      "net.sock.peer.addr": "203.0.113.9",
      "user.ip_address": "203.0.113.9",
      "user.email": "eve@x.com",
      "user.name": "eve",
      "user.id": "u1",
      "server.address": "app.example",
      "network.local.address": "10.0.0.2",
    };
    scrubSpanData(d);
    expect(d).toEqual({
      "user.id": "u1",
      "server.address": "app.example",
      "network.local.address": "10.0.0.2",
    });
  });

  it("drops IP-bearing / proxy headers in Sentry 11's spelling and keeps benign ones", () => {
    const d: Record<string, unknown> = {
      "http.request.header.x-forwarded-for": ["203.0.113.9"],
      "http.request.header.x-real-ip": ["203.0.113.9"],
      "http.request.header.cf-connecting-ip": ["203.0.113.9"],
      "http.request.header.true-client-ip": ["203.0.113.9"],
      "http.request.header.x-vercel-forwarded-for": ["203.0.113.9"],
      "http.request.header.forwarded": ["for=203.0.113.9"],
      "http.request.header.via": ["1.1 vercel"],
      "http.request.header.x-forwarded-user": ["eve"],
      "http.request.header.remote-addr": ["203.0.113.9"],
      "http.request.header.x-forwarded-host": ["app.example"],
      // Sentry 10's `_` spelling still matches.
      "http.request.header.x_forwarded_for": "203.0.113.9",
      "http.request.header.user-agent": ["ua"],
      "http.request.header.accept-language": ["en-CA"],
      "http.request.header.host": ["app.example"],
      "http.response.header.x-powered-by": ["next"],
      "http.response.header.content-type": ["text/html"],
    };
    scrubSpanData(d);
    expect(d).toEqual({
      "http.request.header.user-agent": ["ua"],
      "http.request.header.accept-language": ["en-CA"],
      "http.request.header.host": ["app.example"],
      "http.response.header.x-powered-by": ["next"],
      "http.response.header.content-type": ["text/html"],
    });
  });
});

/**
 * Review #22 (follow-up): drive the SDK's REAL header→span-attribute writer
 * (`httpHeadersToSpanAttributes`, what the Node `http.server` root span and
 * the `RequestData` integration call) with our policy resolved by a real
 * `Client`, so the attribute keys under test are the ones production emits.
 * Two properties are pinned: (1) the policy denies at least everything the
 * old `sendDefaultPii: false` bridge denied (no regression from the switch to
 * `dataCollection`), and (2) whatever the SDK still records is scrubbed by
 * the backstop with no IP / credential surviving.
 */
describe("SDK parity: real @sentry/core writer + SENTRY_DATA_COLLECTION", () => {
  const IP = "203.0.113.9";
  const JWT = "eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe";
  const FILTERED = ["[Filtered]"];
  const REQUEST_HEADERS: Record<string, string> = {
    "x-forwarded-for": `${IP}, 10.0.0.1`,
    "x-real-ip": IP,
    "cf-connecting-ip": IP,
    "true-client-ip": IP,
    "x-vercel-forwarded-for": IP,
    "x-client-ip": IP,
    forwarded: `for=${IP};proto=https`,
    via: "1.1 vercel",
    "x-forwarded-user": "eve",
    "x-forwarded-host": "app.example",
    "x-forwarded-proto": "https",
    cookie: "better-auth.session_token=sess; theme=dark",
    authorization: `Bearer ${JWT}`,
    "proxy-authorization": `Basic ${JWT}`,
    "x-api-key": "drk_live_AbC123",
    referer: "https://app/sign-in?returnTo=/admin&email=eve@x.com",
    "x-drk-request-target": "/en/app/administrator/users?q=eve@x.com",
    "user-agent": "ua",
    accept: "text/html",
    "accept-language": "en-CA",
    host: "app.example",
    "content-type": "application/json",
  };
  const RESPONSE_HEADERS: Record<string, string> = {
    "set-cookie": "better-auth.session_token=sess; Path=/; HttpOnly",
    "x-powered-by": "next",
    "content-type": "text/html",
  };

  /** The policy as the SDK resolves it inside a real `Client`. */
  function resolvedPolicy(): ResolvedDataCollection {
    const client = new ServerRuntimeClient({
      dataCollection: SENTRY_DATA_COLLECTION,
      integrations: [],
      stackParser: () => [],
      transport: (opts) => createTransport(opts, () => Promise.resolve({})),
    });
    return client.getDataCollectionOptions();
  }

  /** The SDK's per-direction header policy (a `CollectBehavior` per direction). */
  type HeaderBehavior = ResolvedDataCollection["httpHeaders"]["request"];

  /**
   * Narrows a resolved `CollectBehavior` (`boolean | { allow } | { deny }`) to
   * its deny-list form. A type guard, not a cast: if the SDK ever resolves a
   * direction to `true` (collect everything, empty deny list) or to an
   * allow-list, this throws and the test fails instead of silently asserting
   * nothing. That is the whole point of the tripwire — the union member we get
   * back is itself part of the policy under test.
   */
  function denyList(behavior: HeaderBehavior): string[] {
    if (typeof behavior !== "object" || !("deny" in behavior)) {
      throw new Error(
        `expected a { deny: [...] } header policy, got ${JSON.stringify(behavior)} — ` +
          "the SDK resolved our policy to something that collects headers",
      );
    }
    return behavior.deny;
  }

  it("resolves with every channel closed and the bridge's frameContextLines, exactly", () => {
    // EXACT, not `toMatchObject` (R11): a category the SDK adds resolves to its
    // own default, and Sentry 11's `queues` arrived defaulting to `true` while a
    // subset match stayed green. `graphQL` / `databaseQueryData` / `queues` /
    // `stackFrameVariables` all default to `true` as well. `httpHeaders` is
    // pinned by the next test.
    const { httpHeaders, ...rest } = resolvedPolicy();
    expect(httpHeaders).toBeDefined();
    expect(rest).toEqual({
      userInfo: false,
      cookies: false,
      urlQueryParams: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 7,
    });
  });

  it("spells out every category the SDK resolves rather than relying on a default", () => {
    expect(Object.keys(SENTRY_DATA_COLLECTION).sort()).toEqual(
      Object.keys(resolvedPolicy()).sort(),
    );
  });

  it("resolves both header directions to our deny list and no others", () => {
    const httpHeaders = resolvedPolicy().httpHeaders;
    // Assert what the SDK actually resolved: a deny list on each direction. An
    // SDK that added a third direction would default it to `true` (collect
    // everything) while these two assertions still passed — hence the exact key
    // set. "The parity test failing is the feature."
    expect(Object.keys(httpHeaders).sort()).toEqual(["request", "response"]);
    const expected = [
      "authorization",
      "cookie",
      "x-api-key",
      "referer",
      // F-70: the proxy-stamped request target carries the page's query.
      "x-drk-request-target",
      // the SDK's own `ipHeaderNames` (vendor/getIpAddress)
      "x-client-ip",
      "x-forwarded-for",
      "fly-client-ip",
      "cf-connecting-ip",
      "fastly-client-ip",
      "true-client-ip",
      "x-real-ip",
      "x-cluster-client-ip",
      "x-forwarded",
      "forwarded-for",
      "forwarded",
      "x-vercel-forwarded-for",
      // Sentry 10's PII_HEADER_SNIPPETS
      "forwarded",
      "-ip",
      "remote-",
      "via",
      "-user",
    ];
    expect(denyList(httpHeaders.request)).toEqual(expect.arrayContaining(expected));
    expect(denyList(httpHeaders.response)).toEqual(expect.arrayContaining(expected));
  });

  /**
   * Sentry 11 removed the `sendDefaultPii: false` bridge. At 10.75 it resolved
   * to `{ deny: PII_HEADER_SNIPPETS }` for headers and cookies, applied ON TOP
   * of the SDK's always-on sensitive-key snippets (`auth`, `token`, `cookie`,
   * `key`, …), which Sentry 11 still applies, unchanged. Handing Sentry 11's
   * writer that deny list therefore reproduces the bridge exactly; the first
   * assertion below checks the always-on half is still there.
   */
  const V10_PII_HEADER_SNIPPETS = ["forwarded", "-ip", "remote-", "via", "-user"];
  const v10Bridge = (): ResolvedDataCollection => ({
    ...resolvedPolicy(),
    cookies: { deny: V10_PII_HEADER_SNIPPETS },
    httpHeaders: {
      request: { deny: V10_PII_HEADER_SNIPPETS },
      response: { deny: V10_PII_HEADER_SNIPPETS },
    },
  });

  it("denies at least every header the old sendDefaultPii:false bridge denied", () => {
    const collectAll = {
      ...resolvedPolicy(),
      httpHeaders: { request: true, response: true },
    } satisfies ResolvedDataCollection;
    expect(
      httpHeadersToSpanAttributes({ authorization: "x" }, collectAll, "request")[
        "http.request.header.authorization"
      ],
      "the SDK no longer filters sensitive header names on its own",
    ).toEqual(FILTERED);

    const ours = httpHeadersToSpanAttributes(REQUEST_HEADERS, resolvedPolicy(), "request");
    const bridge = httpHeadersToSpanAttributes(REQUEST_HEADERS, v10Bridge(), "request");
    const bridgeFiltered = Object.entries(bridge).filter(
      ([, value]) => JSON.stringify(value) === JSON.stringify(FILTERED),
    );
    expect(bridgeFiltered.length).toBeGreaterThan(10);
    for (const [key] of bridgeFiltered) {
      // Filtered by the bridge → filtered or not recorded at all by us.
      expect([undefined, FILTERED], key).toContainEqual(ours[key]);
    }
    // Real Sentry 11 key shapes: dashes kept, values in arrays, cookies in one
    // attribute (we record none).
    expect(ours["http.request.header.x-forwarded-for"]).toEqual(FILTERED);
    expect(ours["http.request.header.x-real-ip"]).toEqual(FILTERED);
    expect(ours["http.request.header.via"]).toEqual(FILTERED);
    expect(ours["http.request.header.x-forwarded-user"]).toEqual(FILTERED);
    expect(ours["http.request.header.x-vercel-forwarded-for"]).toEqual(FILTERED);
    expect(ours["http.request.header.referer"]).toEqual(FILTERED);
    expect(ours["http.request.header.x-drk-request-target"]).toEqual(FILTERED);
    expect(ours["http.request.header.x-api-key"]).toEqual(FILTERED);
    expect(bridge["http.request.header.cookie"]).toBeDefined();
    expect(ours).not.toHaveProperty("http.request.header.cookie");
    expect(ours["http.request.header.user-agent"]).toEqual(["ua"]);
    expect(ours["http.request.header.accept-language"]).toEqual(["en-CA"]);
    expect(JSON.stringify(ours)).not.toContain(IP);
  });

  it("scrubs a Node http.server root span exactly as the integration builds it", () => {
    // Mirrors @sentry/node httpServerSpansIntegration at 11.1 (the attributes
    // it starts the span with, then the ones it adds on the response), as if
    // `userInfo` were on: the client address it then records must go too.
    const data: Record<string, unknown> = {
      "sentry.kind": "server",
      "sentry.op": "http.server",
      "sentry.segment.name.source": "url",
      "url.full": `https://app.example/en/invite?token=${JWT}`,
      "url.path": "/en/invite",
      "url.query": `token=${JWT}`,
      "url.fragment": `#${JWT}`,
      "http.request.method": "GET",
      "user_agent.original": "ua",
      "url.scheme": "https",
      "server.address": "app.example",
      "network.protocol.name": "http",
      "network.protocol.version": "1.1",
      "network.transport": "tcp",
      ...httpHeadersToSpanAttributes(REQUEST_HEADERS, resolvedPolicy(), "request"),
      ...httpHeadersToSpanAttributes(RESPONSE_HEADERS, resolvedPolicy(), "response"),
      "http.response.status_code": 200,
      "client.address": IP,
      "network.peer.address": IP,
      "client.port": 51234,
    };
    scrubSpanData(data);
    const json = JSON.stringify(data);
    expect(json).not.toContain(IP);
    expect(json).not.toContain(JWT);
    expect(json).not.toContain("sess");
    expect(json).not.toContain("drk_live_");
    expect(json).not.toContain("eve");
    expect(json).not.toContain("[Filtered]"); // filtered placeholders are dropped, not shipped
    expect(data["client.address"]).toBeUndefined();
    expect(data["http.request.header.x-forwarded-for"]).toBeUndefined();
    expect(data["http.request.header.x-forwarded-host"]).toBeUndefined();
    expect(data["http.response.header.set-cookie"]).toBeUndefined();
    // The span stays useful.
    expect(data["url.full"]).toBe("https://app.example/en/invite");
    expect(data["url.path"]).toBe("/en/invite");
    expect(data["user_agent.original"]).toBe("ua");
    expect(data["http.request.header.user-agent"]).toEqual(["ua"]);
    expect(data["http.request.header.host"]).toEqual(["app.example"]);
    expect(data["http.response.header.x-powered-by"]).toEqual(["next"]);
    expect(data["http.response.status_code"]).toBe(200);
  });
});

/**
 * R11, end to end: spans produced and sent by the REAL Sentry 11 pipeline — a
 * real client in its default `traceLifecycle` (stream), the `RequestData`
 * integration that copies the request onto the root span, `captureSpan` that
 * copies the scope's user and the root span's name onto every span — captured
 * at the transport. The request and the user are what `withIsolationScope`
 * gives one server request. The root span also carries header and URL
 * attributes the way an OpenTelemetry instrumentation writes them (semantic
 * conventions: dashes kept, values in arrays, no Sentry policy applied). An
 * error inside it sends an envelope of its own: every envelope's header names
 * the root span in its trace context, which no `before*` hook sees.
 */
describe("Sentry 11 span streaming through a real client (R11)", () => {
  const JWT = "eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe";
  const IP = "203.0.113.9";
  const SECRETS = [JWT, IP, "sess", "eve@x.com", "hunter2", "#frag"];

  afterEach(() => {
    getCurrentScope().setClient(undefined);
  });

  /**
   * Streams one request's root span and one child span, and captures an error
   * inside them; returns the span items sent and each envelope's trace header.
   * With a `beforeSendSpan`, the client also gets the integration every config
   * installs to scrub that header.
   */
  async function streamThroughSdk(beforeSendSpan?: typeof scrubSpan) {
    const bodies: (string | Uint8Array)[] = [];
    let calls = 0;
    const client = new ServerRuntimeClient({
      dsn: "https://public@o1.ingest.sentry.io/1",
      tracesSampleRate: 1,
      integrations: [
        requestDataIntegration(),
        ...(beforeSendSpan ? [scrubDynamicSamplingContextIntegration()] : []),
      ],
      stackParser: createStackParser(),
      dataCollection: SENTRY_DATA_COLLECTION,
      ...(beforeSendSpan && {
        beforeSendSpan: (span: StreamedSpanJSON) => {
          calls++;
          return beforeSendSpan(span);
        },
      }),
      transport: (options) =>
        createTransport(options, (request) => {
          bodies.push(request.body);
          return Promise.resolve({ statusCode: 200 });
        }),
    });
    setCurrentClient(client);
    client.init();
    const otelHeaders = httpHeadersToSpanAttributes(
      { cookie: "last_email=eve@x.com", "x-forwarded-for": IP, "user-agent": "ua" },
      {
        ...client.getDataCollectionOptions(),
        cookies: true,
        httpHeaders: { request: true, response: true },
      },
      "request",
    );
    withIsolationScope((scope) => {
      scope.setSDKProcessingMetadata({
        normalizedRequest: {
          url: `https://app.example/en/invite?token=${JWT}`,
          method: "POST",
          query_string: `token=${JWT}`,
          headers: { "user-agent": "ua", "x-forwarded-for": IP, cookie: "a=sess" },
          data: '{"password":"hunter2"}',
        },
      });
      scope.setUser({ id: "u1", email: "eve@x.com", ip_address: IP, username: "eve" });
      startSpan(
        {
          name: `POST /en/invite?token=${JWT}`,
          op: "http.server",
          attributes: { ...otelHeaders, "url.fragment": "#frag" },
        },
        () => {
          startSpan({ name: `GET https://api.example/v1?token=${JWT}`, op: "http.client" }, () => {
            /* the outgoing call */
          });
          captureException(new Error("boom"));
        },
      );
    });
    await client.flush(2000);
    const envelopes = bodies.map((body) => parseEnvelope(body));
    const traces = envelopes.map(([header]) => header.trace as { transaction?: string });
    const spans = envelopes
      .flatMap(([, items]) => items as [{ type: string }, unknown][])
      .filter(([header]) => header.type === "span")
      .flatMap(([, payload]) => (payload as SerializedStreamedSpanContainer).items);
    const values = (span: SerializedStreamedSpan) =>
      Object.fromEntries(Object.entries(span.attributes).map(([key, attr]) => [key, attr?.value]));
    const root = spans.find((span) => span.is_segment);
    const child = spans.find((span) => !span.is_segment);
    expect(root, "the SDK streamed no root span").toBeDefined();
    expect(child, "the SDK streamed no child span").toBeDefined();
    expect(traces, "one span envelope and one error envelope").toHaveLength(2);
    return { spans, traces, calls, root: root!, child: child!, values };
  }

  it("is needed: the closed write-time policy still streams the user, the name's query, the body", async () => {
    const { spans, traces, root, child, values } = await streamThroughSdk();
    expect(root.name).toBe(`POST /en/invite?token=${JWT}`);
    for (const trace of traces) expect(trace.transaction).toBe(`POST /en/invite?token=${JWT}`);
    expect(values(child)["sentry.segment.name"]).toBe(`POST /en/invite?token=${JWT}`);
    expect(values(child)["user.email"]).toBe("eve@x.com");
    expect(values(root)["http.request.body.data"]).toBe('{"password":"hunter2"}');
    expect(values(root)["url.fragment"]).toBe("#frag");
    expect(values(root)["http.request.header.cookie"]).toEqual(["last_email=eve@x.com"]);
    expect(values(root)["http.request.header.x-forwarded-for"]).toEqual([IP]);
    expect(JSON.stringify(spans)).toContain(JWT);
  });

  it("calls scrubSpan for every span and ships no secret in any of them or any envelope header", async () => {
    const { spans, traces, calls, root, child, values } = await streamThroughSdk(scrubSpan);
    expect(calls).toBe(spans.length);
    const json = JSON.stringify(spans);
    for (const secret of SECRETS) expect(json, `a span carries ${secret}`).not.toContain(secret);
    const headers = JSON.stringify(traces);
    for (const secret of SECRETS) {
      expect(headers, `an envelope header carries ${secret}`).not.toContain(secret);
    }
    for (const trace of traces) expect(trace.transaction).toBe("POST /en/invite");
    expect(root.name).toBe("POST /en/invite");
    expect(child.name).toBe("GET https://api.example/v1");
    expect(values(child)["sentry.segment.name"]).toBe("POST /en/invite");
    // What an incident needs survives.
    expect(values(root)).toMatchObject({
      "url.full": "https://app.example/en/invite",
      "http.request.method": "POST",
      "http.request.header.user-agent": ["ua"],
      "user.id": "u1",
    });
    expect(values(child)["user.id"]).toBe("u1");
    // Dropped, not merely redacted.
    for (const key of [
      "http.request.header.cookie",
      "http.request.header.x-forwarded-for",
      "http.request.body.data",
      "url.fragment",
      "user.email",
      "user.ip_address",
      "user.name",
    ]) {
      expect(values(root), key).not.toHaveProperty([key]);
    }
  });
});

describe("scrubBreadcrumb", () => {
  it("strips query strings and redacts on the way in", () => {
    const out = scrubBreadcrumb(
      asCrumb({ data: { url: "https://app/p?returnTo=/secret&email=e@x.com" } }),
    );
    expect((out.data as Record<string, unknown>).url).toBe("https://app/p");
  });
});

describe("parseSampleRate", () => {
  it("falls back and clamps to [0,1]", () => {
    expect(parseSampleRate(undefined, 0.1)).toBe(0.1);
    expect(parseSampleRate("", 0.1)).toBe(0.1);
    expect(parseSampleRate("0.5", 0.1)).toBe(0.5);
    expect(parseSampleRate("9", 0.1)).toBe(1);
    expect(parseSampleRate("-3", 0.1)).toBe(0);
    expect(parseSampleRate("abc", 0.25)).toBe(0.25);
  });
});
