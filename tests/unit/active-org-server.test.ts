import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ActiveOrgModule from "@/lib/active-org.server";

/**
 * Unit tests for `src/lib/active-org.server.ts` (review #27 / #122).
 *
 * `userHasActiveMembership` is the tenant-switch AUTHORITY: it decides
 * whether the `active_org` cookie may name an org at all. Every consumer
 * suite mocks it, so until now nothing in the mocked-DB run executed the
 * module. This suite drives the real query builders against a recording
 * Kysely stub and pins the predicates that make the check sound — the
 * `status = 'active'` filter above all — plus the row → boolean mapping and
 * the cookie reader's resilience outside a request scope. The SQL itself is
 * verified against live Postgres in tests/db/active-org.db.test.ts.
 */

interface RecordedQuery {
  table: string;
  joins: unknown[][];
  selects: unknown[];
  wheres: unknown[][];
  orderBy: unknown[][];
}

const recorded: RecordedQuery[] = [];
const executeTakeFirst = vi.fn();
const execute = vi.fn();

function chain(table: string) {
  const q: RecordedQuery = { table, joins: [], selects: [], wheres: [], orderBy: [] };
  recorded.push(q);
  const builder = {
    innerJoin: (...a: unknown[]) => {
      q.joins.push(a);
      return builder;
    },
    select: (a: unknown) => {
      q.selects.push(a);
      return builder;
    },
    where: (...a: unknown[]) => {
      q.wheres.push(a);
      return builder;
    },
    orderBy: (...a: unknown[]) => {
      q.orderBy.push(a);
      return builder;
    },
    executeTakeFirst: () => executeTakeFirst(),
    execute: () => execute(),
  };
  return builder;
}

vi.mock("@/db/database", () => ({ db: { selectFrom: (table: string) => chain(table) } }));

const cookieStore = vi.fn();
vi.mock("next/headers", () => ({ cookies: () => cookieStore() }));

let mod: typeof ActiveOrgModule;

beforeEach(async () => {
  recorded.length = 0;
  executeTakeFirst.mockReset();
  execute.mockReset();
  cookieStore.mockReset();
  mod = await import("@/lib/active-org.server");
});
afterEach(() => vi.resetModules());

describe("userHasActiveMembership", () => {
  it("filters on the user, the org, status = 'active' AND the ORG's status = 'active' — never on user + org alone", async () => {
    executeTakeFirst.mockResolvedValue({ id: "m-1" });
    await expect(mod.userHasActiveMembership("u-1", "o-1")).resolves.toBe(true);

    expect(recorded).toHaveLength(1);
    const q = recorded[0]!;
    expect(q.table).toBe("app_organization_memberships as m");
    // F-09: the switch gate is also the gate into a SUSPENDED tenant — an
    // active membership there must not let the cookie name it.
    expect(q.joins).toEqual([["app_organizations as o", "o.id", "m.organization_id"]]);
    expect(q.wheres).toEqual(
      expect.arrayContaining([
        ["m.app_user_id", "=", "u-1"],
        ["m.organization_id", "=", "o-1"],
        ["m.status", "=", "active"],
        ["o.status", "=", "active"],
      ]),
    );
    expect(q.wheres).toHaveLength(4);
  });

  it("is false when no ACTIVE row matches (pending / blocked / foreign org all hit this path)", async () => {
    executeTakeFirst.mockResolvedValue(undefined);
    await expect(mod.userHasActiveMembership("u-1", "o-1")).resolves.toBe(false);
  });

  it("does not pass the caller's ids anywhere but the predicates (no interpolation)", async () => {
    executeTakeFirst.mockResolvedValue(undefined);
    const hostile = "' OR 1=1 --";
    await mod.userHasActiveMembership(hostile, hostile);
    // The builder receives the raw value as a bound parameter, verbatim.
    expect(recorded[0]!.wheres).toEqual(
      expect.arrayContaining([
        ["m.app_user_id", "=", hostile],
        ["m.organization_id", "=", hostile],
      ]),
    );
  });
});

describe("listUserActiveOrganizations", () => {
  it("joins memberships to organizations, keeps only ACTIVE rows in ACTIVE orgs for the user, ordered by name", async () => {
    const rows = [
      { id: "o-a", slug: "a", name: "A" },
      { id: "o-b", slug: "b", name: "B" },
    ];
    execute.mockResolvedValue(rows);
    await expect(mod.listUserActiveOrganizations("u-1")).resolves.toEqual(rows);

    const q = recorded[0]!;
    expect(q.table).toBe("app_organization_memberships as m");
    expect(q.joins).toEqual([["app_organizations as o", "o.id", "m.organization_id"]]);
    expect(q.selects).toEqual([["o.id as id", "o.slug as slug", "o.name as name"]]);
    expect(q.wheres).toEqual([
      ["m.app_user_id", "=", "u-1"],
      ["m.status", "=", "active"],
      // F-09: a suspended org is not a switch target.
      ["o.status", "=", "active"],
    ]);
    expect(q.orderBy).toEqual([["o.name", "asc"]]);
  });
});

describe("listActiveOrganizationIdsForBetterAuthUser (IMP-1 confinement source)", () => {
  it("keys on the BETTER AUTH id via the app_users join and keeps only ACTIVE memberships", async () => {
    execute.mockResolvedValue([{ organization_id: "o-a" }, { organization_id: "o-b" }]);
    await expect(mod.listActiveOrganizationIdsForBetterAuthUser("ba-admin")).resolves.toEqual([
      "o-a",
      "o-b",
    ]);

    const q = recorded[0]!;
    expect(q.table).toBe("app_organization_memberships as m");
    expect(q.joins).toEqual([
      ["app_users as u", "u.id", "m.app_user_id"],
      ["app_organizations as o", "o.id", "m.organization_id"],
    ]);
    // THREE different statuses, all load-bearing, and none substitutes for
    // the other. `m.status` is the MEMBERSHIP: a suspended membership does not
    // let the ADMIN act in that tenant, so it must not widen what a session
    // they borrow can reach either. `u.status` is the ACCOUNT (IMP-2):
    // suspending or blocking a user writes `app_users.status` and leaves the
    // membership rows alone, so without it a just-suspended admin kept the full
    // intersection and the session they had borrowed kept its full reach —
    // the exact opposite of what the confinement's fail-closed branch claims.
    // `o.status` is the ORGANIZATION (F-09): an admin cannot act as themselves
    // in a suspended tenant, so a session they borrow cannot reach it either.
    expect(q.wheres).toEqual([
      ["u.better_auth_user_id", "=", "ba-admin"],
      ["u.status", "=", "active"],
      ["m.status", "=", "active"],
      ["o.status", "=", "active"],
    ]);
  });

  it("deduplicates and returns [] for an impersonator with no active membership (fail closed)", async () => {
    execute.mockResolvedValue([{ organization_id: "o-a" }, { organization_id: "o-a" }]);
    await expect(mod.listActiveOrganizationIdsForBetterAuthUser("ba-admin")).resolves.toEqual([
      "o-a",
    ]);

    execute.mockResolvedValue([]);
    await expect(mod.listActiveOrganizationIdsForBetterAuthUser("ba-nobody")).resolves.toEqual([]);
  });
});

describe("readActiveOrgId", () => {
  it("returns the trimmed cookie value", async () => {
    cookieStore.mockResolvedValue({
      get: () => ({ value: "  2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2b  " }),
    });
    await expect(mod.readActiveOrgId()).resolves.toBe("2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2b");
  });

  it("F-33: treats a value that is not a UUID as no active org", async () => {
    // The resolver compares the value with a `uuid` column, and Postgres
    // rejects a malformed operand (22P02) rather than matching nothing: before
    // this, `active_org=x` 500'd every secure page of that browser.
    for (const value of [
      "o-1",
      "not-a-uuid",
      "2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2",
      "2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2b0",
      "2b1c7a3e9d4f4e218a6b0c5d7e9f1a2b",
      "{2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2b}",
      "2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2g",
      "2b1c7a3e-9d4f-4e21-8a6b-0c5d7e9f1a2b'; drop table x;--",
    ]) {
      cookieStore.mockResolvedValue({ get: () => ({ value }) });
      await expect(mod.readActiveOrgId(), value).resolves.toBeNull();
    }
    // Case does not matter to Postgres, so it does not matter here either.
    cookieStore.mockResolvedValue({
      get: () => ({ value: "2B1C7A3E-9D4F-4E21-8A6B-0C5D7E9F1A2B" }),
    });
    await expect(mod.readActiveOrgId()).resolves.toBe("2B1C7A3E-9D4F-4E21-8A6B-0C5D7E9F1A2B");
  });

  it("returns null when the cookie is missing or blank", async () => {
    cookieStore.mockResolvedValue({ get: () => undefined });
    await expect(mod.readActiveOrgId()).resolves.toBeNull();
    cookieStore.mockResolvedValue({ get: () => ({ value: "   " }) });
    await expect(mod.readActiveOrgId()).resolves.toBeNull();
  });

  it("treats 'called outside a request scope' (cookies() throws) as no active org", async () => {
    cookieStore.mockRejectedValue(new Error("cookies() called outside a request scope"));
    await expect(mod.readActiveOrgId()).resolves.toBeNull();
  });
});
