import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuditServerModule from "@/lib/audit.server";
import type * as AttributionModule from "@/lib/impersonation-attribution.server";
import { USER_AGENT_MAX_LENGTH } from "@/lib/user-agent";

/**
 * Unit tests for `audit.server.ts` (§29.6.13).
 *
 * The DB layer is mocked; we verify the helper records the TRUSTED-hop client
 * IP (via `getClientIp`, not the spoofable leftmost `x-forwarded-for`), the
 * user agent, and serializes metadata as JSON without leaking unexpected
 * fields.
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
let noteSessionImpersonation: typeof AttributionModule.noteSessionImpersonation;

beforeEach(async () => {
  insertExecute.mockClear();
  valuesArg.mockReset();
  logServerError.mockReset();
  vi.stubEnv("TRUSTED_PROXY_COUNT", "1"); // one proxy in front → rightmost XFF is real
  ({ auditEvent } = await import("@/lib/audit.server"));
  // Imported after the same reset so it is the registry instance audit.server reads.
  ({ noteSessionImpersonation } = await import("@/lib/impersonation-attribution.server"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("auditEvent", () => {
  it("records the TRUSTED-hop XFF IP, not the spoofable leftmost", async () => {
    const headers = new Headers();
    // A client spoofs a leftmost value; the trusted edge proxy appends the
    // real source IP to the right. With TRUSTED_PROXY_COUNT=1 the rightmost
    // entry is what the proxy actually observed.
    headers.set("x-forwarded-for", "1.2.3.4, 203.0.113.9");
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
      ip_address: "203.0.113.9",
      user_agent: "vitest/1.0",
      reason: "invalid_credentials",
      metadata: JSON.stringify({ attempt: 3 }),
    });
    // The spoofed leftmost value must NOT be what gets recorded.
    expect(row.ip_address).not.toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when there is no forwarded chain", async () => {
    const headers = new Headers();
    headers.set("x-real-ip", "198.51.100.7");
    await auditEvent({ eventType: "system.probe", outcome: "success", request: { headers } });
    expect(valuesArg.mock.calls[0]![0].ip_address).toBe("198.51.100.7");
  });

  it("caps user_agent at USER_AGENT_MAX_LENGTH so no caller can park kilobytes in the append-only table (F-15)", async () => {
    // The finding's payload: an 8 KB User-Agent. The row is permanent, so the
    // cap applies to EVERY row, authenticated or not.
    const hugeUa = `Mozilla/5.0 ${"A".repeat(8 * 1024)}`;
    await auditEvent({
      eventType: "administrator.access.denied",
      outcome: "denied",
      actorBetterAuthUserId: "ba-1",
      reason: "missing_admin_permission",
      request: { headers: new Headers({ "user-agent": hugeUa }) },
    });
    const row = valuesArg.mock.calls[0]![0];
    expect(row.user_agent).toHaveLength(USER_AGENT_MAX_LENGTH);
    expect(row.user_agent).toBe(hugeUa.slice(0, USER_AGENT_MAX_LENGTH));
    expect(USER_AGENT_MAX_LENGTH).toBe(512);
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

  it("writes through input.executor instead of the pool when one is given (DB-3, DB-4)", async () => {
    const trxValues = vi.fn();
    const trxExecute = vi.fn().mockResolvedValue(undefined);
    const trx = {
      insertInto: () => ({
        values: (v: unknown) => {
          trxValues(v);
          return { execute: trxExecute };
        },
      }),
    } as unknown as AuditServerModule.AuditEventInput["executor"];

    await auditEvent({
      eventType: "admin.organization.deleted",
      outcome: "success",
      organizationId: "o-1",
      executor: trx,
    });

    expect(trxExecute).toHaveBeenCalledTimes(1);
    expect(trxValues.mock.calls[0]![0]).toMatchObject({
      event_type: "admin.organization.deleted",
      organization_id: "o-1",
    });
    // DB-4: nothing reached the pool, which is precisely why this row is
    // discarded if the caller's transaction rolls back. That is the intended
    // semantics for an audit naming a row the same transaction deletes, and the
    // reason a `denied`/`error` audit must never be handed a transaction.
    expect(insertExecute).not.toHaveBeenCalled();
  });
});

/**
 * F-07 — an impersonated session's rows name the HUMAN. Every guard hands
 * routes the BORROWED identity as `betterAuthUserId`, and a hundred call sites
 * audit exactly that; `auditEvent` re-attributes from what the request's
 * session read recorded (`noteSessionImpersonation`, called by the caller
 * resolver and `getCurrentSession`), so docs/admin-manager.md §12 — "the actor
 * is the original admin, never the impersonated user" — holds for every row.
 */
describe("auditEvent — impersonation attribution (F-07)", () => {
  function impersonatedRequest(): { headers: Headers } {
    const request = { headers: new Headers() };
    noteSessionImpersonation(request, {
      user: { id: "ba-borrowed" },
      session: { impersonatedBy: "ba-human" },
    });
    return request;
  }

  it("writes the impersonating admin as the actor and the borrowed identity into metadata", async () => {
    await auditEvent({
      eventType: "admin.user.banned",
      outcome: "success",
      actorBetterAuthUserId: "ba-borrowed",
      appUserId: "u-victim",
      request: impersonatedRequest(),
      metadata: { expiresInSeconds: null },
    });
    const row = valuesArg.mock.calls[0]![0];
    expect(row.actor_better_auth_user_id).toBe("ba-human");
    expect(row.app_user_id).toBe("u-victim");
    expect(JSON.parse(row.metadata as string)).toEqual({
      expiresInSeconds: null,
      impersonatedBetterAuthUserId: "ba-borrowed",
    });
  });

  it("mirrors the attributed metadata to the error stream too", async () => {
    await auditEvent({
      eventType: "admin.user.ban_failed",
      outcome: "error",
      actorBetterAuthUserId: "ba-borrowed",
      request: impersonatedRequest(),
      metadata: { message: "boom" },
    });
    expect(logServerError).toHaveBeenCalledWith(
      "audit.admin.user.ban_failed",
      expect.objectContaining({
        metadata: { message: "boom", impersonatedBetterAuthUserId: "ba-borrowed" },
      }),
    );
    expect(valuesArg.mock.calls[0]![0].actor_better_auth_user_id).toBe("ba-human");
  });

  it("leaves a row on an ordinary request exactly as the caller wrote it", async () => {
    await auditEvent({
      eventType: "admin.user.banned",
      outcome: "success",
      actorBetterAuthUserId: "ba-borrowed",
      request: { headers: new Headers() },
      metadata: { expiresInSeconds: null },
    });
    const row = valuesArg.mock.calls[0]![0];
    expect(row.actor_better_auth_user_id).toBe("ba-borrowed");
    expect(row.metadata).toBe(JSON.stringify({ expiresInSeconds: null }));
  });

  it("leaves a row naming a different principal untouched, even on an impersonated request", async () => {
    await auditEvent({
      eventType: "system.job",
      outcome: "success",
      actorBetterAuthUserId: "ba-system",
      request: impersonatedRequest(),
    });
    const row = valuesArg.mock.calls[0]![0];
    expect(row.actor_better_auth_user_id).toBe("ba-system");
    expect(row.metadata).toBe("{}");
  });
});
