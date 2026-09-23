import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LoggerModule from "@/lib/observability/logger.server";
import type * as MetricsModule from "@/lib/observability/metrics.server";
import type * as RefusalModule from "@/lib/observability/pre-auth-refusal.server";
import { USER_AGENT_MAX_LENGTH, boundedUserAgent } from "@/lib/user-agent";

/**
 * F-15 — the stdout + metric record of a request refused BEFORE its caller was
 * authenticated. These refusals no longer write `app_audit_events` rows, so
 * this line and counter ARE the security signal: they must carry what the row
 * carried, and nothing a client can inflate without bound.
 */

let logPreAuthRefusal: typeof RefusalModule.logPreAuthRefusal;
let logger: typeof LoggerModule.logger;
let metrics: typeof MetricsModule;
const warn = vi.fn();
const error = vi.fn();

beforeEach(async () => {
  warn.mockReset();
  error.mockReset();
  vi.stubEnv("TRUSTED_PROXY_COUNT", "1");
  ({ logPreAuthRefusal } = await import("@/lib/observability/pre-auth-refusal.server"));
  ({ logger } = await import("@/lib/observability/logger.server"));
  metrics = await import("@/lib/observability/metrics.server");
  vi.spyOn(logger, "warn").mockImplementation(((...a: unknown[]) => warn(...a)) as never);
  vi.spyOn(logger, "error").mockImplementation(((...a: unknown[]) => error(...a)) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function counterValue(eventType: string): Promise<number> {
  const { values } = await metrics.preAuthRefusalsTotal.get();
  return values.find((v) => v.labels.event_type === eventType)?.value ?? 0;
}

describe("logPreAuthRefusal", () => {
  it("logs a `denied` refusal at warn with the fields the audit row carried, and counts it", async () => {
    const headers = new Headers({
      "x-forwarded-for": "6.6.6.6, 203.0.113.9",
      "user-agent": "curl/8.0",
    });
    logPreAuthRefusal({
      eventType: "administrator.access.denied",
      outcome: "denied",
      reason: "untrusted_origin",
      request: {
        headers,
        method: "POST",
        nextUrl: new URL("https://app.example/api/administrator/users"),
      },
      requestId: "req-1",
      metadata: { required: ["admin.users.manage"] },
    });

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe("pre-auth refusal administrator.access.denied");
    expect(fields).toEqual({
      kind: "pre_auth_refusal",
      requestId: "req-1",
      eventType: "administrator.access.denied",
      outcome: "denied",
      reason: "untrusted_origin",
      method: "POST",
      path: "/api/administrator/users",
      userAgent: "curl/8.0",
      metadata: { required: ["admin.users.manage"] },
    });
    // The stdout stream never carries a client IP (user data; the edge's access
    // log has it) — neither the trusted hop nor the spoofed entry.
    expect(JSON.stringify(fields)).not.toMatch(/203\.0\.113\.9|6\.6\.6\.6/);
    expect(await counterValue("administrator.access.denied")).toBe(1);
  });

  it("logs a `failure` refusal at error — the level its OBSERVABILITY-2 mirror had", async () => {
    logPreAuthRefusal({
      eventType: "sso.consume.failure",
      outcome: "failure",
      reason: "missing_token",
      request: { headers: new Headers() },
      requestId: "req-2",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pre_auth_refusal", reason: "missing_token" }),
      "pre-auth refusal sso.consume.failure",
    );
    expect(await counterValue("sso.consume.failure")).toBe(1);
  });

  it("bounds what the client chose: the User-Agent is capped and a forged path is dropped", () => {
    const hugeUa = "A".repeat(8 * 1024);
    logPreAuthRefusal({
      eventType: "administrator.access.denied",
      outcome: "denied",
      reason: "missing_origin",
      request: {
        headers: new Headers({ "user-agent": hugeUa }),
        nextUrl: { pathname: `/api/administrator/users/${"x".repeat(600)}` },
      },
      requestId: "req-3",
    });
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields.userAgent).toBe(hugeUa.slice(0, USER_AGENT_MAX_LENGTH));
    // Over `normalizeRequestPath`'s cap → omitted, never logged raw.
    expect(fields.path).toBeUndefined();
  });

  it("derives the request id from the request when the caller has none, like the error envelope", async () => {
    const { getOrCreateRequestId } = await import("@/lib/admin/request-id.server");
    const request = { headers: new Headers() };
    logPreAuthRefusal({
      eventType: "sso.launch.failure",
      outcome: "failure",
      reason: "unauthenticated",
      request,
    });
    const [fields] = error.mock.calls[0] as [Record<string, unknown>];
    expect(fields.requestId).toBe(getOrCreateRequestId(request));
  });
});

describe("boundedUserAgent", () => {
  it("keeps a real agent whole and cuts an oversized one at the cap", () => {
    const real = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    expect(boundedUserAgent(new Headers({ "user-agent": real }))).toBe(real);
    const atCap = "b".repeat(USER_AGENT_MAX_LENGTH);
    expect(boundedUserAgent(new Headers({ "user-agent": atCap }))).toBe(atCap);
    const over = boundedUserAgent(new Headers({ "user-agent": `${atCap}overflow` }));
    expect(over).toBe(atCap);
  });

  it("returns null without a header or request, and keeps an empty header as sent", () => {
    expect(boundedUserAgent(new Headers())).toBeNull();
    expect(boundedUserAgent(undefined)).toBeNull();
    expect(boundedUserAgent(new Headers({ "user-agent": "" }))).toBe("");
  });
});
