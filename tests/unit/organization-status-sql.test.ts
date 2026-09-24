import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledQuery, DatabaseConnection } from "kysely";
import type * as AuthStatusModule from "@/lib/auth-status";
import type * as InvitationsModule from "@/lib/invitations.server";

/**
 * F-09 — organization status is a MEMBERSHIP GATE, pinned at the SQL level.
 *
 * `app_organizations.status` (`active` | `pending` | `suspended` | `archived`)
 * used to be a badge: a superadmin could suspend a tenant and its members, org
 * admins, API keys, SSO launches and pending invitations all kept working. The
 * fix puts `o.status = 'active'` into every query that decides whether a
 * membership counts. This suite runs those queries through Kysely's REAL
 * Postgres compiler, on a scripted driver that answers each statement, and
 * reads back the SQL and its bound parameters:
 *
 *   - the cookie path (one ranked lookup since F-33: the `active_org` pick
 *     and the earliest-membership fallback are ranks of the same statement)
 *     and the bearer path (bound org, and an org-less credential) of
 *     `getUserAccessContext` — the one resolver the shell, the admin and v1
 *     guards, the token endpoint and SSO launch all go through;
 *   - the invitation lookup every acceptance path uses, and the guarded flip
 *     that consumes one.
 *
 * A mocked builder can only show that some `where` was called; compiling shows
 * the predicate sits in the statement that runs, with `active` as its value,
 * and that joining a second table with its own `status` column left no bare
 * (ambiguous) `status` reference behind. Live-row behaviour is covered by
 * tests/db/organization-status.db.test.ts.
 */

interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

const script = vi.hoisted(() => ({
  captured: [] as { sql: string; parameters: readonly unknown[] }[],
  /** Rows (and affected-row count) to answer each statement with. */
  respond: (_sql: string): { rows: unknown[]; numAffectedRows?: bigint } => ({ rows: [] }),
}));

vi.mock("@/db/database", async () => {
  const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import("kysely");
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery) {
      script.captured.push({ sql: query.sql, parameters: query.parameters });
      const answer = script.respond(query.sql);
      return { rows: answer.rows as R[], numAffectedRows: answer.numAffectedRows };
    },
    async *streamQuery() {
      throw new Error("streaming is not used by the code under test");
    },
  };
  const db = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, pgPool: { query: async () => ({ rows: [] }), end: async () => {} } };
});

const readActiveOrgId = vi.fn();
vi.mock("@/lib/active-org.server", () => ({
  readActiveOrgId: () => readActiveOrgId(),
}));
// The superuser probe and the impersonation reach have their own SQL pins
// (superuser-grants-lock-sql, active-org-server); here they are inert.
vi.mock("@/lib/admin/access-scope.server", () => ({
  userIsGlobalSuperuser: async () => false,
}));
const reach = vi.hoisted(() => ({ orgIds: null as string[] | null }));
vi.mock("@/lib/impersonation-reach.server", () => ({
  listImpersonationReachableOrgIds: async () => reach.orgIds,
}));
vi.mock("@/lib/audit.server", () => ({ auditEvent: async () => {} }));

const USER_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  primary_email: "member@example.test",
  status: "active",
  preferred_locale: "en",
};

/** The statements that read `app_organization_memberships`. */
function membershipLookups(): Captured[] {
  return script.captured.filter((q) =>
    q.sql.startsWith('select "m"."organization_id" as "organization_id"'),
  );
}

/**
 * Asserts `q` requires its membership's ORGANIZATION to be active: the org is
 * joined, `"o"."status"` is compared to a bound parameter, and that parameter
 * is `active` — read by position, so a predicate bound to the wrong value (or
 * to nothing) fails.
 */
function expectActiveOrgPredicate(q: Captured): void {
  expect(q.sql).toContain(
    'from "app_organization_memberships" as "m" inner join "app_organizations" as "o" on "o"."id" = "m"."organization_id"',
  );
  const match = /"o"\."status" = \$(\d+)/.exec(q.sql);
  expect(match, q.sql).not.toBeNull();
  expect(q.parameters[Number(match![1]) - 1]).toBe("active");
  // Both tables have a `status` column; every reference must be qualified or
  // Postgres rejects the statement as ambiguous.
  expect(q.sql).not.toMatch(/(^|[^.])"status"\s*(=|as)/);
  expect(q.sql).toContain('"m"."status" as "status"');
}

beforeEach(() => {
  script.captured.length = 0;
  script.respond = (sql) =>
    sql.includes('from "app_users"') ? { rows: [USER_ROW] } : { rows: [] };
  readActiveOrgId.mockReset();
  readActiveOrgId.mockResolvedValue(null);
  reach.orgIds = null;
});
afterEach(() => vi.resetModules());

describe("getUserAccessContext — every membership lookup requires an ACTIVE org (F-09)", () => {
  let getUserAccessContext: typeof AuthStatusModule.getUserAccessContext;
  let decideSecureAccess: typeof AuthStatusModule.decideSecureAccess;

  beforeEach(async () => {
    ({ getUserAccessContext, decideSecureAccess } = await import("@/lib/auth-status"));
  });

  it("cookie path: the one ranked lookup — the cookie's pick and the earliest fallback alike — carries it", async () => {
    readActiveOrgId.mockResolvedValue("22222222-2222-4222-8222-222222222222");

    const ctx = await getUserAccessContext("ba-member");

    // F-33: the cookie's org and the earliest-membership fallback are ranks
    // of ONE statement, so the predicate below covers both.
    const lookups = membershipLookups();
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.parameters).toContain("22222222-2222-4222-8222-222222222222");
    expect(lookups[0]!.sql).toContain('order by "m"."status" = $');
    for (const q of lookups) expectActiveOrgPredicate(q);

    // Nothing counted (the scripted DB answered no rows), so: no org, no
    // permissions, and every secure surface refuses.
    expect(ctx.organizationId).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
  });

  it("key/JWT path: the BOUND org's lookup carries it, so a credential minted for a suspended tenant stops resolving", async () => {
    readActiveOrgId.mockResolvedValue("33333333-3333-4333-8333-333333333333");

    const ctx = await getUserAccessContext("ba-member", {
      organizationId: "44444444-4444-4444-8444-444444444444",
    });

    const lookups = membershipLookups();
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.parameters).toContain("44444444-4444-4444-8444-444444444444");
    expectActiveOrgPredicate(lookups[0]!);
    // MACHINE-1 is intact: the cookie was never consulted.
    expect(readActiveOrgId).not.toHaveBeenCalled();
    expect(ctx.orgBound).toBe(true);
    expect(ctx.organizationId).toBeNull();
    expect(decideSecureAccess(ctx.status, ctx.membershipStatus)).not.toBe("allow");
  });

  it("key/JWT path: an ORG-LESS credential's earliest-membership lookup carries it", async () => {
    await getUserAccessContext("ba-member", { organizationId: null });

    const lookups = membershipLookups();
    expect(lookups).toHaveLength(1);
    expect(lookups[0]!.sql).toContain('order by "m"."created_at" asc');
    expectActiveOrgPredicate(lookups[0]!);
  });

  it("a membership that DOES count resolves exactly as before", async () => {
    // The control: the predicate narrows which rows count, not what a counted
    // row yields.
    script.respond = (sql) => {
      if (sql.includes('from "app_users"')) return { rows: [USER_ROW] };
      if (sql.startsWith('select "m"."organization_id"')) {
        return { rows: [{ organization_id: "o-active", status: "active" }] };
      }
      return { rows: [{ key: "admin.users.read" }] };
    };

    const ctx = await getUserAccessContext("ba-member");

    expect(ctx.organizationId).toBe("o-active");
    expect(ctx.membershipStatus).toBe("active");
    expect(ctx.permissions).toEqual(["admin.users.read", "shell.view"]);
  });
});

describe("getUserAccessContext — the session path ranks memberships in ONE statement (F-33)", () => {
  let getUserAccessContext: typeof AuthStatusModule.getUserAccessContext;
  const COOKIE_ORG = "55555555-5555-4555-8555-555555555555";
  const RANKED =
    /order by "m"\."status" = \$(\d+) desc, "m"\."organization_id" = \$(\d+) desc, "m"\."created_at" asc, "m"\."id" asc limit \$(\d+)$/;

  beforeEach(async () => {
    ({ getUserAccessContext } = await import("@/lib/auth-status"));
  });

  /** The statement's WHERE clause alone (between `where` and `order by`). */
  function whereClause(q: Captured): string {
    return q.sql.slice(q.sql.indexOf(" where "), q.sql.indexOf(" order by "));
  }

  it("orders an ACTIVE membership first, the cookie's org second, then the earliest — and reads one row", async () => {
    readActiveOrgId.mockResolvedValue(COOKIE_ORG);

    await getUserAccessContext("ba-member");

    const lookups = membershipLookups();
    expect(lookups).toHaveLength(1);
    const q = lookups[0]!;
    const match = RANKED.exec(q.sql);
    expect(match, q.sql).not.toBeNull();
    // Read by position: each rank compares against the value it must.
    expect(q.parameters[Number(match![1]) - 1]).toBe("active");
    expect(q.parameters[Number(match![2]) - 1]).toBe(COOKIE_ORG);
    expect(q.parameters[Number(match![3]) - 1]).toBe(1);
    // A RANKING, not a filter: neither the membership status nor the cookie's
    // org narrows the WHERE, so a user whose only memberships are non-active
    // still resolves one and reaches /pending-approval or /blocked.
    expect(whereClause(q)).not.toContain('"m"."status"');
    expect(whereClause(q)).not.toContain('"m"."organization_id" =');
  });

  it("with no cookie the cookie rank is simply absent", async () => {
    await getUserAccessContext("ba-member");

    const [q] = membershipLookups();
    expect(q!.sql).toMatch(
      /order by "m"\."status" = \$\d+ desc, "m"\."created_at" asc, "m"\."id" asc limit \$\d+$/,
    );
  });

  it("an impersonated session's confinement sits in the WHERE of that one statement", async () => {
    reach.orgIds = ["66666666-6666-4666-8666-666666666666"];
    readActiveOrgId.mockResolvedValue(COOKIE_ORG);

    await getUserAccessContext("ba-member", undefined, { betterAuthUserId: "ba-admin" });

    const lookups = membershipLookups();
    expect(lookups).toHaveLength(1);
    const q = lookups[0]!;
    expect(whereClause(q)).toMatch(/"m"\."organization_id" in \(\$(\d+)\)/);
    const inParam = /"m"\."organization_id" in \(\$(\d+)\)/.exec(q.sql)!;
    expect(q.parameters[Number(inParam[1]) - 1]).toBe("66666666-6666-4666-8666-666666666666");
    expect(q.sql).toMatch(RANKED);
  });

  it("the bound-org and org-less credential lookups are NOT ranked by membership status", async () => {
    await getUserAccessContext("ba-member", { organizationId: COOKIE_ORG });
    await getUserAccessContext("ba-member", { organizationId: null });

    const [bound, orgLess] = membershipLookups();
    // A bound credential reads its own org's row, whatever its status, and
    // fails closed on a non-active one (MACHINE-1).
    expect(bound!.sql).not.toContain("order by");
    // An org-less credential takes the earliest row whatever its status, so a
    // suspended MEMBERSHIP there stops it rather than moving it to another
    // tenant. The earliest is decided exactly as on the session path, id
    // breaking a created_at tie, so it cannot differ from one request to the
    // next.
    expect(orgLess!.sql).toMatch(/order by "m"\."created_at" asc, "m"\."id" asc$/);
  });
});

describe("invitations — a suspended org's invitation is dead (F-09)", () => {
  let invitations: typeof InvitationsModule;

  beforeEach(async () => {
    invitations = await import("@/lib/invitations.server");
  });

  it("findValidInvitationByToken requires the inviting org to be ACTIVE", async () => {
    await expect(invitations.findValidInvitationByToken("tok")).resolves.toBeNull();

    expect(script.captured).toHaveLength(1);
    const q = script.captured[0]!;
    expect(q.sql).toContain(
      'from "app_organization_invitations" as "i" inner join "app_organizations" as "o" on "o"."id" = "i"."organization_id"',
    );
    const match = /"o"\."status" = \$(\d+)/.exec(q.sql);
    expect(match, q.sql).not.toBeNull();
    expect(q.parameters[Number(match![1]) - 1]).toBe("active");
  });

  it("consumeInvitation's guarded flip re-asserts it, so a suspension racing the accept wins", async () => {
    // The org was suspended between lookup and consume: the flip matches no
    // row, and the invitation is reported as no longer consumable.
    script.respond = () => ({ rows: [], numAffectedRows: 0n });

    const result = await invitations.consumeInvitation({
      invitation: {
        id: "inv-1",
        organizationId: "o-suspended",
        organizationName: "Suspended Co",
        email: "member@example.test",
        roleId: null,
        invitedByAppUserId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      },
      appUser: { id: USER_ROW.id, primaryEmail: USER_ROW.primary_email, status: "active" },
      actorBetterAuthUserId: "ba-member",
    });

    expect(result).toEqual({ consumed: false, reason: "already_consumed" });
    // Nothing after the flip ran: no membership, no activation, no role.
    expect(script.captured).toHaveLength(1);
    const flip = script.captured[0]!;
    expect(flip.sql).toMatch(/^update "app_organization_invitations"/);
    const match =
      /"organization_id" in \(select "id" from "app_organizations" where "status" = \$(\d+)\)/.exec(
        flip.sql,
      );
    expect(match, flip.sql).not.toBeNull();
    expect(flip.parameters[Number(match![1]) - 1]).toBe("active");
  });
});
