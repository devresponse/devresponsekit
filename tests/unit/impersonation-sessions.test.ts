import { describe, expect, it, vi } from "vitest";
import { revokeSessionsImpersonatedBy } from "@/lib/impersonation-sessions.server";

/**
 * F-08 — the one definition of "every session this user opened as someone
 * else". The behavioural proof against the real plugin (and the controls that
 * nobody else's session goes) is tests/security/impersonation-containment;
 * this pins the query shape and the empty-id guard.
 */
function contextWith(deleteMany: (args: unknown) => Promise<number>) {
  return { adapter: { deleteMany } } as unknown as Parameters<
    typeof revokeSessionsImpersonatedBy
  >[1];
}

describe("revokeSessionsImpersonatedBy", () => {
  it("deletes the session rows whose impersonatedBy names the user, and reports how many", async () => {
    const deleteMany = vi.fn(async () => 2);

    await expect(revokeSessionsImpersonatedBy("ba-admin", contextWith(deleteMany))).resolves.toBe(
      2,
    );
    expect(deleteMany).toHaveBeenCalledWith({
      model: "session",
      where: [{ field: "impersonatedBy", value: "ba-admin" }],
    });
  });

  it("never issues a delete for an empty id", async () => {
    const deleteMany = vi.fn(async () => 0);

    await expect(revokeSessionsImpersonatedBy("", contextWith(deleteMany))).resolves.toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("propagates a storage failure (callers decide whether it fails their action)", async () => {
    const deleteMany = vi.fn(async () => {
      throw new Error("db down");
    });

    await expect(revokeSessionsImpersonatedBy("ba-admin", contextWith(deleteMany))).rejects.toThrow(
      "db down",
    );
  });
});
