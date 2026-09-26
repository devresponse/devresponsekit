import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SessionAccessModule from "@/lib/session-access.server";

/**
 * IMP-1 — `getSessionAccessContext` is the one place that turns a COOKIE
 * SESSION into an access context, and the only place that knows whether that
 * session is an IMPERSONATION. These tests pin the hand-off itself: the
 * impersonator's id must reach `getUserAccessContext` as the third argument
 * (which is what triggers the tenancy confinement there), in BOTH shapes Better
 * Auth's admin plugin has used for the marker, and must be absent for an
 * ordinary session so nothing changes for a user acting as themselves.
 *
 * The confinement's own behaviour is pinned in tests/unit/auth-status-db.test.ts;
 * that a new caller cannot bypass this helper is pinned by the source scan in
 * tests/unit/session-access-context-invariant.test.ts.
 */
const getUserAccessContext = vi.fn();

vi.mock("@/lib/auth-status", () => ({
  getUserAccessContext: (...a: unknown[]) => getUserAccessContext(...a),
}));

const CONTEXT = { appUserId: "u-1", organizationId: "o-a", permissions: [] };

let mod: typeof SessionAccessModule;

beforeEach(async () => {
  getUserAccessContext.mockReset();
  getUserAccessContext.mockResolvedValue(CONTEXT);
  mod = await import("@/lib/session-access.server");
});
afterEach(() => vi.resetModules());

describe("getSessionAccessContext", () => {
  it("passes NO impersonation marker for an ordinary session", async () => {
    await expect(mod.getSessionAccessContext({ user: { id: "ba-1" } })).resolves.toBe(CONTEXT);
    expect(getUserAccessContext).toHaveBeenCalledWith("ba-1", undefined, undefined);
  });

  it("threads the impersonating admin's id so the confinement engages", async () => {
    const session = { user: { id: "ba-target" }, session: { impersonatedBy: "ba-admin" } };
    await mod.getSessionAccessContext(session);
    expect(getUserAccessContext).toHaveBeenCalledWith("ba-target", undefined, {
      betterAuthUserId: "ba-admin",
    });
  });

  it("accepts the snake_case marker too (admin-plugin version drift, P0-1)", async () => {
    const session = { user: { id: "ba-target" }, session: { impersonated_by: "ba-admin" } };
    await mod.getSessionAccessContext(session);
    expect(getUserAccessContext).toHaveBeenCalledWith("ba-target", undefined, {
      betterAuthUserId: "ba-admin",
    });
  });

  it("treats an empty or non-string marker as 'not impersonating'", async () => {
    // A blank string is what a half-written session row would carry; it names
    // no admin, so there is no tenancy to intersect with and the session is
    // resolved as an ordinary one rather than confined to nothing.
    await mod.getSessionAccessContext({ user: { id: "ba-1" }, session: { impersonatedBy: "" } });
    expect(getUserAccessContext).toHaveBeenLastCalledWith("ba-1", undefined, undefined);
  });
});

describe("getImpersonatedAccessContext (F-148)", () => {
  it("resolves a target exactly as the session impersonating it will be resolved", async () => {
    // The impersonate route asks this BEFORE the session exists, to refuse a
    // target the secure shell would send to /blocked or /pending-approval. The
    // answer is only a prediction if it is the very call the session makes.
    await expect(mod.getImpersonatedAccessContext("ba-target", "ba-admin")).resolves.toBe(CONTEXT);
    await mod.getSessionAccessContext({
      user: { id: "ba-target" },
      session: { impersonatedBy: "ba-admin" },
    });

    const [predicted, actual] = getUserAccessContext.mock.calls;
    expect(predicted).toEqual(["ba-target", undefined, { betterAuthUserId: "ba-admin" }]);
    expect(actual).toEqual(predicted);
  });
});
