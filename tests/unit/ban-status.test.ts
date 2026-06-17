import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BanStatusModule from "@/lib/api-auth/ban-status.server";

/**
 * Unit tests for isBetterAuthUserBanned (AUTH-1). The function reads the
 * Better Auth `banned` / `banExpires` fields via the internal adapter; we
 * mock `@/lib/auth` so no real auth instance / DB pool is constructed. The
 * module lazy-imports `@/lib/auth`, so the mock must be in place before the
 * dynamic import resolves (vi.mock is hoisted, so it is).
 */
const findUserById = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      internalAdapter: { findUserById: (...a: unknown[]) => findUserById(...a) },
    }),
  },
}));

let mod: typeof BanStatusModule;

beforeEach(async () => {
  findUserById.mockReset();
  mod = await import("@/lib/api-auth/ban-status.server");
});
afterEach(() => vi.resetModules());

describe("isBetterAuthUserBanned", () => {
  it("returns false for an unknown user", async () => {
    findUserById.mockResolvedValue(null);
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(false);
    expect(findUserById).toHaveBeenCalledWith("ba1");
  });

  it("returns false when the banned flag is falsy or absent", async () => {
    findUserById.mockResolvedValue({ id: "ba1", banned: false });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(false);
    findUserById.mockResolvedValue({ id: "ba1" });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(false);
  });

  it("returns true for an indefinite ban (no expiry)", async () => {
    findUserById.mockResolvedValue({ id: "ba1", banned: true, banExpires: null });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(true);
  });

  it("returns true when banExpires is in the future", async () => {
    findUserById.mockResolvedValue({
      id: "ba1",
      banned: true,
      banExpires: new Date(Date.now() + 60_000),
    });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(true);
  });

  it("returns false once a temporary ban has elapsed", async () => {
    findUserById.mockResolvedValue({
      id: "ba1",
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
    });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(false);
  });

  it("accepts a string banExpires (e.g. a serialized timestamp)", async () => {
    findUserById.mockResolvedValue({
      id: "ba1",
      banned: true,
      banExpires: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(false);
  });

  it("treats a malformed expiry as an indefinite ban (fail closed)", async () => {
    findUserById.mockResolvedValue({ id: "ba1", banned: true, banExpires: "not-a-date" });
    expect(await mod.isBetterAuthUserBanned("ba1")).toBe(true);
  });
});
