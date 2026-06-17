import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuditServerModule from "@/lib/audit.server";

/**
 * Unit tests for `audit.server.ts` (§29.6.13).
 *
 * The DB layer is mocked; we verify the helper extracts the first
 * `x-forwarded-for` IP, the user agent, and serializes metadata as JSON
 * without leaking unexpected fields.
 */

const insertExecute = vi.fn().mockResolvedValue(undefined);
const valuesArg = vi.fn();
const logServerError = vi.fn();

vi.mock("@/db/database", () => ({
  db: {
    insertInto: () => ({
      values: (v: unknown) => {
        valuesArg(v);
        return { execute: insertExecute };
      },
    }),
  },
}));
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logServerError(...a),
}));

let auditEvent: typeof AuditServerModule.auditEvent;

beforeEach(async () => {
  insertExecute.mockClear();
  valuesArg.mockReset();
  logServerError.mockReset();
  ({ auditEvent } = await import("@/lib/audit.server"));
});
afterEach(() => vi.resetModules());

describe("auditEvent", () => {
  it("writes the documented columns and trims the first XFF hop", async () => {
    const headers = new Headers();
    headers.set("x-forwarded-for", "10.0.0.5, 10.0.0.6");
    headers.set("user-agent", "vitest/1.0");

    await auditEvent({
      eventType: "auth.signin.failure",
      outcome: "failure",
      actorBetterAuthUserId: "ba-1",
      reason: "invalid_credentials",
      request: { headers },
      metadata: { attempt: 3 },
    });

    expect(insertExecute).toHaveBeenCalledTimes(1);
    const row = valuesArg.mock.calls[0]![0];
    expect(row).toMatchObject({
      event_type: "auth.signin.failure",
      outcome: "failure",
      actor_better_auth_user_id: "ba-1",
      ip_address: "10.0.0.5",
      user_agent: "vitest/1.0",
      reason: "invalid_credentials",
      metadata: JSON.stringify({ attempt: 3 }),
    });
  });

  it("nulls IP and UA when no request is supplied", async () => {
    await auditEvent({
      eventType: "system.heartbeat",
      outcome: "success",
    });
    const row = valuesArg.mock.calls[0]![0];
    expect(row.ip_address).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.metadata).toBe("{}");
  });

  it("mirrors error/failure outcomes to the structured logger (OBSERVABILITY-2)", async () => {
    await auditEvent({
      eventType: "admin.user.ban_failed",
      outcome: "error",
      requestId: "req-123",
      organizationId: "o-1",
      reason: "auth_ban_failed",
      metadata: { message: "boom" },
    });
    expect(logServerError).toHaveBeenCalledTimes(1);
    expect(logServerError).toHaveBeenCalledWith(
      "audit.admin.user.ban_failed",
      expect.objectContaining({
        requestId: "req-123",
        eventType: "admin.user.ban_failed",
        outcome: "error",
        reason: "auth_ban_failed",
      }),
    );
  });

  it("does NOT log success or denied outcomes (keeps the error stream signal-rich)", async () => {
    await auditEvent({ eventType: "admin.user.approved", outcome: "success" });
    await auditEvent({ eventType: "administrator.access.denied", outcome: "denied" });
    expect(logServerError).not.toHaveBeenCalled();
    // Both are still written to the audit table.
    expect(insertExecute).toHaveBeenCalledTimes(2);
  });

  it("propagates DB errors so callers can surface them (no silent swallow)", async () => {
    insertExecute.mockRejectedValueOnce(new Error("db down"));
    await expect(auditEvent({ eventType: "x", outcome: "success" })).rejects.toThrow(/db down/);
  });
});
