import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as LoginAuditModule from "@/lib/auth-login-audit.server";

/**
 * Unit tests for login auditing (backs the daily-logins metrics). `auditEvent`
 * is mocked; the contract is: record one success event with LOGIN_EVENT_TYPE
 * and the actor, and NEVER throw into the sign-in path.
 */
const auditEvent = vi.fn();
vi.mock("@/lib/audit.server", () => ({ auditEvent: (...a: unknown[]) => auditEvent(...a) }));

let mod: typeof LoginAuditModule;
beforeEach(async () => {
  auditEvent.mockReset();
  mod = await import("@/lib/auth-login-audit.server");
});
afterEach(() => vi.resetModules());

describe("recordSessionLogin", () => {
  it("audits a login with the login event type, success outcome, and actor + request", async () => {
    auditEvent.mockResolvedValue(undefined);
    const request = { headers: new Headers({ "user-agent": "vitest" }) };
    await mod.recordSessionLogin("ba-1", request);
    expect(auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: mod.LOGIN_EVENT_TYPE,
        outcome: "success",
        actorBetterAuthUserId: "ba-1",
        request,
      }),
    );
  });

  it("swallows audit failures so a login is never blocked", async () => {
    auditEvent.mockRejectedValue(new Error("db down"));
    await expect(mod.recordSessionLogin("ba-1")).resolves.toBeUndefined();
  });
});
