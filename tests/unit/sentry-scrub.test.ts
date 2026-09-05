import { describe, it, expect } from "vitest";
import type { ErrorEvent, Breadcrumb } from "@sentry/nextjs";
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
            "http.request.header.cookie.better-auth.session_token": "sess",
            "http.request.header.authorization": `Bearer ${JWT}`,
            "http.request.header.referer": "https://app/sign-in?returnTo=/admin",
            "http.request.header.user-agent": "ua",
            "http.response.header.set-cookie": "better-auth.session_token=sess",
            "http.response.status_code": 200,
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
            "http.request.header.x-api-key": "drk_live_AbC123",
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
    expect(data["http.request.header.cookie.better-auth.session_token"]).toBeUndefined();
    expect(data["http.request.header.authorization"]).toBeUndefined();
    expect(data["http.request.header.referer"]).toBeUndefined();
    expect(data["http.response.header.set-cookie"]).toBeUndefined();
    // Benign attributes survive so the transaction stays useful.
    expect(data["http.request.method"]).toBe("GET");
    expect(data["http.request.header.user-agent"]).toBe("ua");
    expect(data["http.response.status_code"]).toBe(200);
  });

  it("scrubs every child span's data and description", () => {
    const out = scrubTransaction(fixture(), HINT);
    const [s1, s2] = out.spans as [SpanJSON, SpanJSON];
    const d1 = s1.data as Record<string, unknown>;
    expect(d1["url.full"]).toBe("https://api/x");
    expect(d1["url.query"]).toBeUndefined();
    expect(d1["http.request.header.x-api-key"]).toBeUndefined();
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
});

describe("SENTRY_DATA_COLLECTION", () => {
  it("closes every write-time channel (cookies, query, bodies, user info)", () => {
    expect(SENTRY_DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      queryParams: false,
      httpBodies: [],
      genAI: { inputs: false, outputs: false },
    });
    const req = SENTRY_DATA_COLLECTION.httpHeaders?.request as { deny: string[] };
    expect(req.deny).toEqual(
      expect.arrayContaining(["authorization", "cookie", "x-api-key", "referer"]),
    );
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
