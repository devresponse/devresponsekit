import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as TelemetryModule from "@/lib/email/delivery-telemetry.server";
import type * as MetricsModule from "@/lib/observability/metrics.server";
import type * as ProvidersModule from "@/lib/email/providers.server";

/**
 * `recordOutboxDelivery`, the one place an email delivery outcome is logged
 * and counted (F-27). Before it, an inline failure was recorded on the outbox
 * row and returned as a status, so a sender the provider refused failed every
 * auth email with no log line and no metric. The inline and worker call sites
 * are pinned in email-send.test.ts and outbox-worker.test.ts.
 */
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: log.error,
  logger: { warn: log.warn, error: vi.fn(), info: vi.fn() },
}));

let telemetry: typeof TelemetryModule;
let metrics: typeof MetricsModule;
let providers: typeof ProvidersModule;

beforeEach(async () => {
  log.error.mockReset();
  log.warn.mockReset();
  telemetry = await import("@/lib/email/delivery-telemetry.server");
  metrics = await import("@/lib/observability/metrics.server");
  providers = await import("@/lib/email/providers.server");
  metrics.__resetMetricsForTests();
});
afterEach(() => vi.resetModules());

const base = {
  path: "inline",
  outboxId: "outbox-7",
  templateKey: "password_reset",
  provider: "resend",
} as const;

async function counterValue(outcome: string, template: string): Promise<number> {
  const metric = await metrics.outboxDeliveryTotal.get();
  const sample = metric.values.find(
    (v) => v.labels.outcome === outcome && v.labels.template === template,
  );
  return sample?.value ?? 0;
}

describe("recordOutboxDelivery (F-27)", () => {
  it("logs a terminal provider rejection at error level with the code-controlled fields", async () => {
    telemetry.recordOutboxDelivery({
      ...base,
      outcome: "failed",
      attempts: 1,
      error: new providers.EmailDeliveryError(
        "resend",
        403,
        "The localhost domain is not verified",
      ),
    });

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const [message, fields] = log.error.mock.calls[0]!;
    expect(message).toBe("email will not be delivered");
    expect(fields).toEqual({
      kind: "email_delivery",
      outcome: "failed",
      reason: "provider_rejected",
      path: "inline",
      outboxId: "outbox-7",
      template: "password_reset",
      provider: "resend",
      attempts: 1,
      providerStatus: 403,
      errorName: "EmailDeliveryError",
      errorCode: undefined,
    });
    expect(await counterValue("failed", "password_reset")).toBe(1);
  });

  it("never logs the provider's response text, the error object or anything it echoes", () => {
    // A vendor body can echo request fields; the recipient and the link must
    // not reach the log stream through it.
    const body =
      "Invalid `to`: victim@example.org for https://app.test/en/reset-password/LiveTok123?callbackURL=%2F";
    telemetry.recordOutboxDelivery({
      ...base,
      outcome: "failed",
      attempts: 1,
      error: new providers.EmailDeliveryError("resend", 422, body),
    });
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain("victim@example.org");
    expect(logged).not.toContain("LiveTok123");
    expect(logged).not.toContain("Invalid");
    const fields = log.error.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty("err");
    expect(fields).not.toHaveProperty("error");
    expect(fields).not.toHaveProperty("message");
  });

  it("logs a transient failure at warn level, not error", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    telemetry.recordOutboxDelivery({ ...base, outcome: "retry", attempts: 1, error: timeout });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = log.warn.mock.calls[0]!;
    expect(message).toBe("email delivery failed, will retry");
    expect(fields).toMatchObject({
      kind: "email_delivery",
      outcome: "retry",
      reason: "transient",
      providerStatus: undefined,
      errorName: "TimeoutError",
    });
    expect(await counterValue("retry", "password_reset")).toBe(1);
  });

  it("reports a network error's system code from its cause, and only an identifier-shaped one", () => {
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.resend.com"), {
        code: "ENOTFOUND",
      }),
    });
    telemetry.recordOutboxDelivery({ ...base, outcome: "retry", attempts: 2, error: refused });
    expect(log.warn.mock.calls[0]![0]).toMatchObject({
      errorName: "TypeError",
      errorCode: "ENOTFOUND",
    });

    const odd = Object.assign(new Error("x"), { code: "not a code: victim@example.org" });
    odd.name = "Name with spaces victim@example.org";
    telemetry.recordOutboxDelivery({ ...base, outcome: "retry", attempts: 2, error: odd });
    const fields = log.warn.mock.calls[1]![0] as Record<string, unknown>;
    expect(fields.errorCode).toBeUndefined();
    expect(fields.errorName).toBe("Error");
    expect(JSON.stringify(fields)).not.toContain("victim");
  });

  it("tells an exhausted retry budget apart from a provider rejection", () => {
    telemetry.recordOutboxDelivery({
      ...base,
      path: "worker",
      outcome: "failed",
      attempts: 5,
      error: new providers.EmailDeliveryError("resend", 503, "unavailable"),
    });
    expect(log.error.mock.calls[0]![1]).toMatchObject({
      reason: "attempts_exhausted",
      path: "worker",
      attempts: 5,
      providerStatus: 503,
    });
  });

  it("logs an expired row as terminal with its own reason and no error fields", async () => {
    telemetry.recordOutboxDelivery({ ...base, path: "worker", outcome: "expired", attempts: 1 });
    const fields = log.error.mock.calls[0]![1] as Record<string, unknown>;
    expect(fields).toMatchObject({ outcome: "expired", reason: "token_expired", attempts: 1 });
    expect(fields).not.toHaveProperty("providerStatus");
    expect(await counterValue("expired", "password_reset")).toBe(1);
  });

  it("counts `sent` and `logged` without logging", async () => {
    telemetry.recordOutboxDelivery({ ...base, outcome: "sent", attempts: 1 });
    telemetry.recordOutboxDelivery({ ...base, outcome: "sent", attempts: 1 });
    telemetry.recordOutboxDelivery({ ...base, provider: null, outcome: "logged", attempts: 0 });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(await counterValue("sent", "password_reset")).toBe(2);
    expect(await counterValue("logged", "password_reset")).toBe(1);
  });

  it("keeps the template label to the built-in keys, so a stray key cannot mint a series", async () => {
    for (const key of [
      "password_reset",
      "email_verification",
      "organization_invitation",
      "test_email",
    ]) {
      expect(telemetry.outboxTemplateLabel(key)).toBe(key);
    }
    for (const key of [null, undefined, "", "some_future_template", "x".repeat(500), "__proto__"]) {
      expect(telemetry.outboxTemplateLabel(key)).toBe("other");
    }
    telemetry.recordOutboxDelivery({
      ...base,
      templateKey: "attacker-chosen",
      outcome: "sent",
      attempts: 1,
    });
    const metric = await metrics.outboxDeliveryTotal.get();
    expect(metric.values.map((v) => v.labels.template)).toEqual(["other"]);
  });

  it("is exposed by the scrape registry under its documented name", async () => {
    telemetry.recordOutboxDelivery({
      ...base,
      outcome: "failed",
      attempts: 1,
      error: new Error("x"),
    });
    const body = await metrics.registry.metrics();
    expect(body).toContain("# TYPE devresponsekit_outbox_delivery_total counter");
    expect(body).toContain(
      'devresponsekit_outbox_delivery_total{outcome="failed",template="password_reset"} 1',
    );
  });
});
