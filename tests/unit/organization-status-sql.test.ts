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
 *   - the cookie path (`active_org` lookup AND the earliest-membership
 *     fallback) and the bearer path (bound org, and an org-less credential)
 *     of `getUserAccessContext` — the one resolver the shell, the admin and v1
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
vi.mock("@/lib/impersonation-reach.server", () => ({
  listImpersonationReachableOrgIds: async () => null,
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
});
afterEach(() => vi.resetModules());

describe("getUserAccessContext — every membership lookup requires an ACTIVE org (F-09)", () => {
  let getUserAccessContext: typeof AuthStatusModule.getUserAccessContext;
  let decideSecureAccess: typeof AuthStatusModule.decideSecureAccess;

  beforeEach(async () => {
    ({ getUserAccessContext, decideSecureAccess } = await import("@/lib/auth-status"));
  });

  it("cookie path: the active_org lookup AND the earliest-membership fallback both carry it", async () => {
    readActiveOrgId.mockResolvedValue("22222222-2222-4222-8222-222222222222");

    const ctx = await getUserAccessContext("ba-member");

    const lookups = membershipLookups();
    expect(lookups).toHaveLength(2);
    // 1st: the org the cookie names.
    expect(lookups[0]!.sql).toContain('"m"."organization_id" = $');
    expect(lookups[0]!.parameters).toContain("22222222-2222-4222-8222-222222222222");
    // 2nd: the fallback, earliest first.
    expect(lookups[1]!.sql).toContain('order by "m"."created_at" asc');
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
