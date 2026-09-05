import { describe, it, expect } from "vitest";
import type { ErrorEvent, Breadcrumb } from "@sentry/nextjs";
// `@sentry/core` is the (hoisted, see .npmrc) engine behind `@sentry/nextjs`;
// the SDK-parity suite below drives its REAL span-attribute writer so the
// key shapes under test are the ones production emits, not hand-written ones.
import { ServerRuntimeClient, createTransport, httpHeadersToSpanAttributes } from "@sentry/core";
import {
  type SpanJSON,
  type TransactionEvent,
  SENTRY_DATA_COLLECTION,
  redactText,
  scrubEvent,
  scrubBreadcrumb,
  scrubSpan,
  scrubSpanData,
  scrubTransaction,
  parseSampleRate,
} from "@/lib/observability/sentry-shared";

type Hint = Parameters<typeof scrubEvent>[1];
const HINT = {} as Hint;
const asEvent = (e: unknown) => e as ErrorEvent;
const asTx = (e: unknown) => e as TransactionEvent;
const asSpan = (s: unknown) => s as SpanJSON;
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
 * Review #22: sampled TRANSACTIONS (and their spans) used to bypass the
 * scrubber entirely and ship raw query strings, cookies, and headers. The
 * transaction hook must strip every channel an error event strips PLUS the
 * span-attribute channels (`contexts.trace.data`, `spans[].data`).
 */
describe("scrubTransaction", () => {
  const JWT = "eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe";

  function fixture(): TransactionEvent {
    return asTx({
      type: "transaction",
      transaction: `GET /en/invite?token=${JWT}`,
      request: {
        url: `https://app/en/invite?token=${JWT}&returnTo=/admin`,
        query_string: `token=${JWT}&returnTo=/admin`,
        cookies: { "better-auth.session_token": "sess" },
        headers: {
          cookie: "better-auth.session_token=sess",
          authorization: `Bearer ${JWT}`,
          referer: "https://app/sign-in?returnTo=/admin&email=eve@x.com",
          accept: "text/html",
        },
      },
      user: { id: "u1", email: "eve@x.com", ip_address: "9.9.9.9" },
      contexts: {
        trace: {
          trace_id: "t",
          span_id: "s0",
          data: {
            "url.full": `https://app/en/invite?token=${JWT}`,
            "url.query": `token=${JWT}`,
            "http.query": `?token=${JWT}`,
            "http.target": `/en/invite?token=${JWT}`,
            "http.request.method": "GET",
            // The SDK writes header names with `_` for `-` (normalizeAttributeKey).
            "http.request.header.cookie.better_auth.session_token": "sess",
            "http.request.header.authorization": `Bearer ${JWT}`,
            "http.request.header.proxy_authorization": `Basic ${JWT}`,
            "http.request.header.referer": "https://app/sign-in?returnTo=/admin",
            "http.request.header.x_forwarded_for": "203.0.113.9, 10.0.0.1",
            "http.request.header.x_real_ip": "203.0.113.9",
            "http.request.header.user_agent": "ua",
            "http.response.header.set_cookie": "better-auth.session_token=sess",
            "http.response.status_code": 200,
            "http.client_ip": "203.0.113.9",
            "user.ip_address": "203.0.113.9",
          },
        },
      },
      spans: [
        {
          span_id: "s1",
          trace_id: "t",
          start_timestamp: 1,
          op: "http.client",
          description: `GET https://api/x?api_key=drk_live_AbC123&email=bob@x.com`,
          data: {
            "url.full": "https://api/x?api_key=drk_live_AbC123",
            "url.query": "api_key=drk_live_AbC123",
            "http.request.header.x_api_key": "drk_live_AbC123",
            "http.request.header.x-api-key": "drk_live_AbC123",
            "http.request.body.data": '{"password":"hunter2"}',
            "net.peer.ip": "203.0.113.9",
            "sso.token": "opaque-secret",
            "db.query.text": "select 1",
            "http.response.status_code": 200,
          },
        },
        {
          span_id: "s2",
          trace_id: "t",
          start_timestamp: 2,
          op: "http.server",
          description: `POST /reset-password/${RESET_TOKEN}`,
          data: { "url.full": `https://app/reset-password/${RESET_TOKEN}?callbackURL=/` },
        },
      ],
      breadcrumbs: [{ data: { url: `https://app/api/sso/consume?token=${JWT}` } }],
    });
  }

  it("strips request query/cookies/auth+referer headers, user PII, and breadcrumbs", () => {
    const out = scrubTransaction(fixture(), HINT);
    const req = out.request as Record<string, unknown>;
    const headers = req.headers as Record<string, unknown>;
    expect(req.url).toBe("https://app/en/invite");
    expect(req.query_string).toBeUndefined();
    expect(req.cookies).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers.accept).toBe("text/html");
    const user = out.user as Record<string, unknown>;
    expect(user).toEqual({ id: "u1" });
    expect((out.breadcrumbs?.[0]?.data as Record<string, unknown>).url).toBe(
      "https://app/api/sso/consume",
    );
  });

  it("scrubs the root span attributes in contexts.trace.data", () => {
    const out = scrubTransaction(fixture(), HINT);
    const data = out.contexts?.trace?.data as Record<string, unknown>;
    expect(data["url.full"]).toBe("https://app/en/invite");
    expect(data["http.target"]).toBe("/en/invite");
    expect(data["url.query"]).toBeUndefined();
    expect(data["http.query"]).toBeUndefined();
    expect(data["http.request.header.cookie.better_auth.session_token"]).toBeUndefined();
    expect(data["http.request.header.authorization"]).toBeUndefined();
    expect(data["http.request.header.proxy_authorization"]).toBeUndefined();
    expect(data["http.request.header.referer"]).toBeUndefined();
    expect(data["http.request.header.x_forwarded_for"]).toBeUndefined();
    expect(data["http.request.header.x_real_ip"]).toBeUndefined();
    expect(data["http.response.header.set_cookie"]).toBeUndefined();
    expect(data["http.client_ip"]).toBeUndefined();
    expect(data["user.ip_address"]).toBeUndefined();
    // Benign attributes survive so the transaction stays useful.
    expect(data["http.request.method"]).toBe("GET");
    expect(data["http.request.header.user_agent"]).toBe("ua");
    expect(data["http.response.status_code"]).toBe(200);
  });

  it("scrubs every child span's data and description", () => {
    const out = scrubTransaction(fixture(), HINT);
    const [s1, s2] = out.spans as [SpanJSON, SpanJSON];
    const d1 = s1.data as Record<string, unknown>;
    expect(d1["url.full"]).toBe("https://api/x");
    expect(d1["url.query"]).toBeUndefined();
    // Both the SDK's `_` spelling and the hyphenated one are DROPPED (not
    // merely replaced by the secret-key redactor).
    expect(d1["http.request.header.x_api_key"]).toBeUndefined();
    expect(d1["http.request.header.x-api-key"]).toBeUndefined();
    expect(d1["http.request.body.data"]).toBeUndefined();
    expect(d1["net.peer.ip"]).toBeUndefined();
    expect(d1["sso.token"]).toBe("[redacted]");
    expect(d1["db.query.text"]).toBe("select 1");
    expect(d1["http.response.status_code"]).toBe(200);
    expect(s1.description).toBe("GET https://api/x");
    expect(s2.description).toBe("POST /reset-password/[redacted-token]");
    expect((s2.data as Record<string, unknown>)["url.full"]).toBe(
      "https://app/reset-password/[redacted-token]",
    );
  });

  it("redacts the transaction name and leaves nothing token-like anywhere in the event", () => {
    const out = scrubTransaction(fixture(), HINT);
    expect(out.transaction).toBe("GET /en/invite");
    const json = JSON.stringify(out);
    expect(json).not.toContain(JWT);
    expect(json).not.toContain(RESET_TOKEN);
    expect(json).not.toContain("drk_live_");
    expect(json).not.toContain("sess");
    expect(json).not.toContain("@x.com");
    expect(json).not.toContain("returnTo");
    expect(json).not.toContain("203.0.113.9");
    expect(json).not.toContain("hunter2");
    expect(out.type).toBe("transaction");
  });

  it("returns a bare transaction untouched (no request/spans/contexts)", () => {
    const out = scrubTransaction(asTx({ type: "transaction", transaction: "GET /health" }), HINT);
    expect(out).toEqual({ type: "transaction", transaction: "GET /health" });
  });
});

describe("scrubSpan", () => {
  it("scrubs a standalone span's data and description and always returns it", () => {
    const span = asSpan({
      span_id: "s",
      trace_id: "t",
      start_timestamp: 0,
      description: "GET /sign-in?returnTo=/a&email=z@z.com",
      data: {
        "url.full": "https://app/sign-in?returnTo=/a",
        "url.query": "returnTo=/a",
        "http.request.header.cookie": "a=b",
        "http.request.header.accept": "*/*",
        note: "contact bob@x.com with drk_live_ZZ",
      },
    });
    const out = scrubSpan(span);
    expect(out).toBe(span);
    expect(out.description).toBe("GET /sign-in");
    const d = out.data as Record<string, unknown>;
    expect(d["url.full"]).toBe("https://app/sign-in");
    expect(d["url.query"]).toBeUndefined();
    expect(d["http.request.header.cookie"]).toBeUndefined();
    expect(d["http.request.header.accept"]).toBe("*/*");
    expect(d.note).toBe("contact [redacted-email] with [redacted-token]");
  });
});

describe("scrubSpanData", () => {
  it("tolerates a missing bag and keeps non-string values", () => {
    expect(() => scrubSpanData(undefined)).not.toThrow();
    const d: Record<string, unknown> = { n: 1, ok: true, list: ["x"], "http.password": "p" };
    scrubSpanData(d);
    expect(d).toEqual({ n: 1, ok: true, list: ["x"], "http.password": "[redacted]" });
  });

  it("strips the query from the browser fetch/xhr `url` attribute and drops fragments", () => {
    const d: Record<string, unknown> = {
      url: "https://app/api/sso/consume?token=opaque123&returnTo=/admin#access_token=abc",
      "http.url": "https://app/api/sso/consume?token=opaque123",
      "http.query": "?token=opaque123",
      "http.fragment": "#access_token=abc",
      "url.fragment": "#access_token=abc",
      type: "fetch",
      "http.method": "GET",
    };
    scrubSpanData(d);
    expect(d).toEqual({
      url: "https://app/api/sso/consume",
      "http.url": "https://app/api/sso/consume",
      type: "fetch",
      "http.method": "GET",
    });
  });

  it("drops every client-IP attribute spelling the SDK / OTel write", () => {
    const d: Record<string, unknown> = {
      "http.client_ip": "203.0.113.9",
      "user.ip_address": "203.0.113.9",
      "client.address": "203.0.113.9",
      "net.peer.ip": "203.0.113.9",
      "net.sock.peer.addr": "203.0.113.9",
      "network.peer.address": "203.0.113.9",
      "server.address": "app.example",
      "http.host": "app.example",
    };
    scrubSpanData(d);
    expect(d).toEqual({ "server.address": "app.example", "http.host": "app.example" });
  });

  it("drops IP-bearing / proxy headers in the SDK's `_` spelling and keeps benign ones", () => {
    const d: Record<string, unknown> = {
      "http.request.header.x_forwarded_for": "203.0.113.9",
      "http.request.header.x_real_ip": "203.0.113.9",
      "http.request.header.cf_connecting_ip": "203.0.113.9",
      "http.request.header.true_client_ip": "203.0.113.9",
      "http.request.header.x_vercel_forwarded_for": "203.0.113.9",
      "http.request.header.forwarded": "for=203.0.113.9",
      "http.request.header.via": "1.1 vercel",
      "http.request.header.x_forwarded_user": "eve",
      "http.request.header.remote_addr": "203.0.113.9",
      "http.request.header.x_forwarded_host": "app.example",
      "http.request.header.user_agent": "ua",
      "http.request.header.accept_language": "en-CA",
      "http.request.header.host": "app.example",
      "http.response.header.x_powered_by": "next",
      "http.response.header.content_type": "text/html",
    };
    scrubSpanData(d);
    expect(d).toEqual({
      "http.request.header.user_agent": "ua",
      "http.request.header.accept_language": "en-CA",
      "http.request.header.host": "app.example",
      "http.response.header.x_powered_by": "next",
      "http.response.header.content_type": "text/html",
    });
  });
});

/**
 * Review #22 (follow-up): drive the SDK's REAL header→span-attribute writer
 * (`httpHeadersToSpanAttributes`, what the Node `http.server` root span and
 * the `RequestData` integration call) with our policy resolved by a real
 * `Client`, so the attribute keys under test are the ones production emits.
 * Two properties are pinned: (1) the policy denies at least everything the
 * deprecated `sendDefaultPii: false` bridge denied (no regression from the
 * switch to `dataCollection`), and (2) whatever the SDK still records is
 * scrubbed by the backstop with no IP / credential surviving.
 */
describe("SDK parity: real @sentry/core writer + SENTRY_DATA_COLLECTION", () => {
  const IP = "203.0.113.9";
  const JWT = "eyJhbGciOi.eyJzdWIiOi.sIgnAtuRe";
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
  function resolvedPolicy() {
    const client = new ServerRuntimeClient({
      dataCollection: SENTRY_DATA_COLLECTION,
      integrations: [],
      stackParser: () => [],
      transport: (opts) => createTransport(opts, () => Promise.resolve({})),
    });
    return client.getDataCollectionOptions();
  }

  it("resolves with every channel closed and the bridge's frameContextLines", () => {
    expect(resolvedPolicy()).toMatchObject({
      userInfo: false,
      cookies: false,
      queryParams: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      frameContextLines: 7,
    });
  });

  it("denies at least every header the old sendDefaultPii:false bridge denied", () => {
    const ours = httpHeadersToSpanAttributes(REQUEST_HEADERS, resolvedPolicy(), "request");
    const bridge = httpHeadersToSpanAttributes(REQUEST_HEADERS, false, "request");
    for (const [key, value] of Object.entries(bridge)) {
      if (value === "[Filtered]") {
        // Filtered by the bridge → filtered or not recorded at all by us.
        expect([undefined, "[Filtered]"], key).toContain(ours[key]);
      }
    }
    // Real key shapes: `-` → `_`, cookies exploded per name (we record none).
    expect(ours["http.request.header.x_forwarded_for"]).toBe("[Filtered]");
    expect(ours["http.request.header.x_real_ip"]).toBe("[Filtered]");
    expect(ours["http.request.header.via"]).toBe("[Filtered]");
    expect(ours["http.request.header.x_forwarded_user"]).toBe("[Filtered]");
    expect(ours["http.request.header.x_vercel_forwarded_for"]).toBe("[Filtered]");
    expect(ours["http.request.header.referer"]).toBe("[Filtered]");
    expect(ours["http.request.header.x_api_key"]).toBe("[Filtered]");
    expect(ours["http.request.header.cookie.better_auth.session_token"]).toBeUndefined();
    expect(ours["http.request.header.cookie.theme"]).toBeUndefined();
    expect(ours["http.request.header.user_agent"]).toBe("ua");
    expect(ours["http.request.header.accept_language"]).toBe("en-CA");
    expect(JSON.stringify(ours)).not.toContain(IP);
  });

  it("scrubs a Node http.server root span exactly as the integration builds it", () => {
    // Mirrors @sentry/node-core httpServerSpansIntegration: fixed attributes
    // (including the unconditional `http.client_ip`) spread with the
    // policy-filtered header attributes.
    const data: Record<string, unknown> = {
      "sentry.op": "http.server",
      "http.url": `https://app.example/en/invite?token=${JWT}`,
      "http.method": "GET",
      "http.target": `/en/invite?token=${JWT}`,
      "http.host": "app.example",
      "net.host.name": "app.example",
      "http.client_ip": IP,
      "http.user_agent": "ua",
      "http.scheme": "https",
      "http.flavor": "1.1",
      "net.transport": "ip_tcp",
      ...httpHeadersToSpanAttributes(REQUEST_HEADERS, resolvedPolicy(), "request"),
      ...httpHeadersToSpanAttributes(RESPONSE_HEADERS, resolvedPolicy(), "response"),
      "http.response.status_code": 200,
    };
    scrubSpanData(data);
    const json = JSON.stringify(data);
    expect(json).not.toContain(IP);
    expect(json).not.toContain(JWT);
    expect(json).not.toContain("sess");
    expect(json).not.toContain("drk_live_");
    expect(json).not.toContain("eve");
    expect(json).not.toContain("[Filtered]"); // filtered placeholders are dropped, not shipped
    expect(data["http.client_ip"]).toBeUndefined();
    expect(data["http.request.header.x_forwarded_for"]).toBeUndefined();
    expect(data["http.request.header.x_forwarded_host"]).toBeUndefined();
    expect(data["http.response.header.set_cookie"]).toBeUndefined();
    // The span stays useful.
    expect(data["http.url"]).toBe("https://app.example/en/invite");
    expect(data["http.target"]).toBe("/en/invite");
    expect(data["http.user_agent"]).toBe("ua");
    expect(data["http.request.header.user_agent"]).toBe("ua");
    expect(data["http.request.header.host"]).toBe("app.example");
    expect(data["http.response.header.x_powered_by"]).toBe("next");
    expect(data["http.response.status_code"]).toBe(200);
  });
});

describe("SENTRY_DATA_COLLECTION", () => {
  it("closes every write-time channel (cookies, query, bodies, user info)", () => {
    expect(SENTRY_DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      queryParams: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
      frameContextLines: 7,
    });
    const req = SENTRY_DATA_COLLECTION.httpHeaders?.request as { deny: string[] };
    const res = SENTRY_DATA_COLLECTION.httpHeaders?.response as { deny: string[] };
    const expected = [
      "authorization",
      "cookie",
      "x-api-key",
      "referer",
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
      // the bridge's PII_HEADER_SNIPPETS
      "forwarded",
      "-ip",
      "remote-",
      "via",
      "-user",
    ];
    expect(req.deny).toEqual(expect.arrayContaining(expected));
    expect(res.deny).toEqual(expect.arrayContaining(expected));
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
