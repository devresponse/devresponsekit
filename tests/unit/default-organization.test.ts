import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F-40 — the default organization's ONE identity is `is_default`.
 *
 * Unit tests for the resolver in `default-organization.server.ts`, against a
 * query-recording stub of the Kysely builder: it must select the org FLAGGED
 * default (never a slug), break a legacy two-default tie deterministically on
 * the oldest row, and `requireDefaultOrganization` must refuse with the named
 * error rather than return nothing. The lock and the flag-moving helpers run
 * real SQL and are covered by tests/db/default-organization.db.test.ts.
 */

const calls: Array<[string, ...unknown[]]> = [];
let row: unknown;

vi.mock("@/db/database", () => {
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  for (const method of ["select", "where", "orderBy", "limit"]) {
    chain[method] = (...a: unknown[]) => {
      calls.push([method, ...a]);
      return chain;
    };
  }
  chain.executeTakeFirst = async () => row;
  return {
    db: {
      selectFrom: (table: string) => {
        calls.push(["selectFrom", table]);
        return chain;
      },
    },
  };
});

const { getDefaultOrganization, requireDefaultOrganization, NoDefaultOrganizationError } =
  await import("@/lib/default-organization.server");

beforeEach(() => {
  calls.length = 0;
  row = { id: "org-1", slug: "renamed", name: "Acme", status: "active" };
});

describe("getDefaultOrganization (F-40)", () => {
  it("selects the org flagged is_default — no slug in the query at all", async () => {
    await expect(getDefaultOrganization()).resolves.toEqual({
      id: "org-1",
      slug: "renamed",
      name: "Acme",
      status: "active",
    });
    expect(calls).toContainEqual(["selectFrom", "app_organizations"]);
    const wheres = calls.filter(([m]) => m === "where");
    expect(wheres).toEqual([["where", "is_default", "=", true]]);
    expect(JSON.stringify(calls)).not.toContain('"slug","="');
  });

  it("breaks a legacy two-default tie on the OLDEST row (the original default), then the id", async () => {
    await getDefaultOrganization();
    expect(calls.filter(([m]) => m === "orderBy")).toEqual([
      ["orderBy", "created_at", "asc"],
      ["orderBy", "id", "asc"],
    ]);
    expect(calls).toContainEqual(["limit", 1]);
  });

  it("returns null when no org is flagged default", async () => {
    row = undefined;
    await expect(getDefaultOrganization()).resolves.toBeNull();
  });
});

describe("requireDefaultOrganization (F-40)", () => {
  it("returns the flagged org", async () => {
    await expect(requireDefaultOrganization()).resolves.toMatchObject({ id: "org-1" });
  });

  it("refuses with NoDefaultOrganizationError (naming the fix) instead of inventing an org", async () => {
    row = undefined;
    const error = await requireDefaultOrganization().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoDefaultOrganizationError);
    expect((error as Error).message).toMatch(/is_default/);
    expect((error as Error).message).toMatch(/Set as default organization/);
  });
});
