import { describe, it, expect } from "vitest";
import type { ErrorEvent, Breadcrumb } from "@sentry/nextjs";
import {
  redactText,
  scrubEvent,
  scrubBreadcrumb,
  parseSampleRate,
} from "@/lib/observability/sentry-shared";

type Hint = Parameters<typeof scrubEvent>[1];
const HINT = {} as Hint;
const asEvent = (e: unknown) => e as ErrorEvent;
const asCrumb = (c: unknown) => c as Breadcrumb;

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
