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
  it("filters on the user, the org AND status = 'active' — never on user + org alone", async () => {
    executeTakeFirst.mockResolvedValue({ id: "m-1" });
    await expect(mod.userHasActiveMembership("u-1", "o-1")).resolves.toBe(true);

    expect(recorded).toHaveLength(1);
    const q = recorded[0]!;
    expect(q.table).toBe("app_organization_memberships");
    expect(q.wheres).toEqual(
      expect.arrayContaining([
        ["app_user_id", "=", "u-1"],
        ["organization_id", "=", "o-1"],
        ["status", "=", "active"],
      ]),
    );
    expect(q.wheres).toHaveLength(3);
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
        ["app_user_id", "=", hostile],
        ["organization_id", "=", hostile],
      ]),
    );
  });
});

describe("listUserActiveOrganizations", () => {
  it("joins memberships to organizations, keeps only ACTIVE rows for the user, ordered by name", async () => {
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
    ]);
    expect(q.orderBy).toEqual([["o.name", "asc"]]);
  });
});

describe("readActiveOrgId", () => {
  it("returns the trimmed cookie value", async () => {
    cookieStore.mockResolvedValue({ get: () => ({ value: "  o-1  " }) });
    await expect(mod.readActiveOrgId()).resolves.toBe("o-1");
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
