import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  endBorrowedSessionsAfterOwnSweep,
  isOwnSessionSweep,
  OWN_SESSION_SWEEP_PATHS,
} from "@/lib/auth-session-sweep";

/**
 * F-10 — which Better Auth calls count as "sign out my other sessions", and
 * what the after-hook does with one. The behavioural proof against the real
 * instance (the vendor's sweep plus this hook, with controls) is in
 * tests/security/impersonation-containment.test.ts; this pins the
 * classification and the hook's refusals in isolation.
 */
const revokeSessionsImpersonatedBy = vi.fn();
vi.mock("@/lib/impersonation-sessions.server", () => ({
  revokeSessionsImpersonatedBy: (...a: unknown[]) => revokeSessionsImpersonatedBy(...a),
}));
const logServerError = vi.fn();
vi.mock("@/lib/observability/logger.server", () => ({
  logServerError: (...a: unknown[]) => logServerError(...a),
}));

beforeEach(() => {
  revokeSessionsImpersonatedBy.mockReset().mockResolvedValue(1);
  logServerError.mockReset();
});

describe("isOwnSessionSweep", () => {
  it("names exactly the two always-sweeping endpoints", () => {
    expect([...OWN_SESSION_SWEEP_PATHS]).toEqual(["/revoke-other-sessions", "/revoke-sessions"]);
    expect(isOwnSessionSweep("/revoke-other-sessions", undefined)).toBe(true);
    expect(isOwnSessionSweep("/revoke-sessions", {})).toBe(true);
  });

  it("counts /change-password only with revokeOtherSessions: true", () => {
    expect(isOwnSessionSweep("/change-password", { revokeOtherSessions: true })).toBe(true);
    expect(isOwnSessionSweep("/change-password", { revokeOtherSessions: false })).toBe(false);
    expect(isOwnSessionSweep("/change-password", { revokeOtherSessions: "true" })).toBe(false);
    expect(isOwnSessionSweep("/change-password", {})).toBe(false);
    expect(isOwnSessionSweep("/change-password", null)).toBe(false);
    expect(isOwnSessionSweep("/change-password", undefined)).toBe(false);
  });

  it("ignores every other endpoint, including the single-session revoke and sign-out", () => {
    for (const path of ["/revoke-session", "/sign-out", "/reset-password", "/get-session"]) {
      expect(isOwnSessionSweep(path, { revokeOtherSessions: true })).toBe(false);
    }
    expect(isOwnSessionSweep(undefined, { revokeOtherSessions: true })).toBe(false);
  });
});

describe("endBorrowedSessionsAfterOwnSweep", () => {
  const ownSession = { session: { id: "s1" }, user: { id: "ba-admin" } };

  function run(overrides: { path?: string; returned?: unknown; session?: unknown }) {
    const context = {
      returned: "returned" in overrides ? overrides.returned : { status: true },
      session: "session" in overrides ? overrides.session : ownSession,
    };
    // Better Auth hands the hook the endpoint's context; `adapter` rides on it.
    return endBorrowedSessionsAfterOwnSweep({
      path: overrides.path ?? "/revoke-other-sessions",
      context,
    } as never).then(() => context);
  }

  it("ends the caller's borrowed sessions through the endpoint's own context", async () => {
    const context = await run({});

    expect(revokeSessionsImpersonatedBy).toHaveBeenCalledWith("ba-admin", context);
  });

  it("does nothing for an endpoint that is not a sweep", async () => {
    await run({ path: "/revoke-session" });

    expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
  });

  it("does nothing when the sweep itself was refused", async () => {
    await run({ returned: new APIError("BAD_REQUEST", { message: "Invalid password" }) });

    expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
  });

  it("does nothing without a session", async () => {
    await run({ session: null });

    expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
  });

  it("does nothing for an impersonated session: its user is the borrowed identity", async () => {
    await run({
      session: { session: { id: "s2", impersonatedBy: "ba-admin" }, user: { id: "ba-target" } },
    });

    expect(revokeSessionsImpersonatedBy).not.toHaveBeenCalled();
  });

  it("logs a failure instead of failing the request", async () => {
    revokeSessionsImpersonatedBy.mockRejectedValue(new Error("db down"));

    await expect(run({})).resolves.toBeDefined();
    expect(logServerError).toHaveBeenCalledWith(
      "could not end impersonation sessions after a session sweep",
      expect.objectContaining({ betterAuthUserId: "ba-admin", path: "/revoke-other-sessions" }),
    );
  });
});
