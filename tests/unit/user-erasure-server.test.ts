import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-151: `pseudonymiseUser` is a thin handle on `app_users_pseudonymise(uuid)`
 * (migration 0008); tests/db/user-data-export-erasure.db.test.ts proves what
 * the function does. This pins the call shape and the error mapping the erase
 * route relies on, against a stubbed query executor.
 */
const executeQuery = vi.fn();
vi.mock("@/db/database", () => ({ db: { executeQuery: (q: unknown) => executeQuery(q) } }));

const { isNotDeactivatedError, pseudonymiseUser } = await import("@/lib/admin/user-erasure.server");

beforeEach(() => executeQuery.mockReset());

describe("pseudonymiseUser (F-151)", () => {
  it("calls the SECURITY DEFINER function with the id as a bound uuid and returns its result", async () => {
    const result = { pseudonym: "erased+u@erased.invalid", alreadyErased: false, sessions: 2 };
    executeQuery.mockResolvedValue({ rows: [{ result }] });
    await expect(pseudonymiseUser("u-1")).resolves.toEqual(result);
    const query = executeQuery.mock.calls[0]![0] as { sql: string; parameters: unknown[] };
    expect(query.sql).toBe("select app_users_pseudonymise($1::uuid) as result");
    expect(query.parameters).toEqual(["u-1"]);
  });

  it("throws when the function returns nothing", async () => {
    executeQuery.mockResolvedValue({ rows: [] });
    await expect(pseudonymiseUser("u-1")).rejects.toThrow(/returned no result/);
  });

  it("recognises the function's not-soft-deleted refusal (SQLSTATE 55000) and nothing else", () => {
    expect(isNotDeactivatedError({ code: "55000" })).toBe(true);
    expect(isNotDeactivatedError({ code: "P0002" })).toBe(false);
    expect(isNotDeactivatedError(new Error("boom"))).toBe(false);
    expect(isNotDeactivatedError(null)).toBe(false);
  });
});
