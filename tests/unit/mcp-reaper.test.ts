import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledQuery, DatabaseConnection } from "kysely";

/**
 * Unit contract for the stale-registration reaper (review #13, #51, F-75,
 * F-79). The statements run through Kysely's REAL Postgres compiler on a
 * scripted driver, so these pin the SQL that would be sent and its bound
 * parameters: the TTL-0 kill switch; one statement per batch, which picks its
 * batch once (MATERIALIZED, SKIP LOCKED) and whose cascades read the flipped
 * set in SQL instead of binding its ids (F-75); the loop that runs until a
 * batch expires nothing or the caller's deadline passes; and one
 * `mcp.client.expired` audit row per expired agent, naming its membership's
 * organization, written after its batch (F-79). The live behaviour (the rows
 * each statement touches, the batch bound, a locked row, the Approve and
 * admin-revoke races) is verified in `tests/db/mcp-registration-reaper.db.test.ts`.
 */
interface ScriptedRow {
  id: string;
  appUserId: string;
  clientRowId: string | null;
  clientId: string | null;
  organizationId: string | null;
}

const script = vi.hoisted(() => ({
  statements: [] as { sql: string; parameters: readonly unknown[] }[],
  /** What each batch statement flips, in order; an exhausted queue flips nothing. */
  batches: [] as ScriptedRow[][],
  /** Statements and audit writes, interleaved in the order they happened. */
  events: [] as string[],
}));

vi.mock("@/db/database", async () => {
  const { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import("kysely");
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery) {
      script.statements.push({ sql: query.sql, parameters: query.parameters });
      script.events.push("statement");
      // Only the user flip returns anything: the batch statement (and the
      // first statement of the pre-F-75 sequence) is the one updating app_users.
      const flips = query.sql.includes('update "app_users"');
      return { rows: (flips ? (script.batches.shift() ?? []) : []) as R[] };
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

const auditEvent = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => {
    script.events.push("audit");
  }),
);
vi.mock("@/lib/audit.server", () => ({ auditEvent }));

import {
  expireStalePendingMcpRegistrations,
  MCP_EXPIRED_REGISTRATION_REASON,
  MCP_REAP_BATCH_SIZE,
} from "@/lib/mcp/reaper.server";

function agents(count: number, from = 0): ScriptedRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    return {
      id: `user-${n}`,
      appUserId: `user-${n}`,
      clientRowId: `client-row-${n}`,
      clientId: `mcp_client_${n}`,
      organizationId: "org-1",
    };
  });
}

beforeEach(() => {
  script.statements = [];
  script.batches = [];
  script.events = [];
  auditEvent.mockClear();
});

describe("expireStalePendingMcpRegistrations", () => {
  it("a TTL of 0 (or less) disables the sweep without sending a statement", async () => {
    expect(await expireStalePendingMcpRegistrations(0)).toEqual({
      expired: 0,
      ttlDays: 0,
      drained: true,
    });
    expect(await expireStalePendingMcpRegistrations(-3)).toEqual({
      expired: 0,
      ttlDays: -3,
      drained: true,
    });
    expect(script.statements).toEqual([]);
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("sends one statement and audits nothing when nothing is stale", async () => {
    expect(await expireStalePendingMcpRegistrations(7)).toEqual({
      expired: 0,
      ttlDays: 7,
      drained: true,
    });
    expect(script.statements).toHaveLength(1);
    expect(auditEvent).not.toHaveBeenCalled();
  });

  it("flips users and cascades to memberships and clients in ONE statement, keyed on the flipped set", async () => {
    script.batches = [agents(2)];
    expect(await expireStalePendingMcpRegistrations(7)).toEqual({
      expired: 2,
      ttlDays: 7,
      drained: true,
    });

    const batch = script.statements[0]!.sql;
    // The batch is chosen once (MATERIALIZED: as an IN subquery it was re-run
    // per row and its LIMIT bounded nothing), bounded by the LIMIT, and skips
    // rows a concurrent pass holds instead of queueing behind them.
    expect(batch).toMatch(
      /^with "batch" as materialized \(select "u"\."id" from "app_users" as "u" /,
    );
    expect(batch).toMatch(/limit \$\d+ for update of "u" skip locked\), "flipped" as \(/);
    // The user flip comes next (it races Approve), guarded by the pending
    // predicate on the row itself.
    expect(batch).toMatch(
      /"flipped" as \(update "app_users" set .* where "status" = \$\d+ and "id" in \(select "batch"\."id" from "batch"\) returning "id"\)/,
    );
    // Both cascades read the flipped set in SQL, never a list of ids.
    expect(batch).toContain('"blocked" as (update "app_organization_memberships" set');
    expect(batch).toContain('"revoked" as (update "app_oauth_clients" set');
    expect(batch.match(/"app_user_id" in \(select "flipped"\."id" from "flipped"\)/g)).toHaveLength(
      2,
    );
    // The organization comes from the agent's mcp membership, so an agent
    // whose client an admin revoked mid-pass is still audited under its org.
    expect(batch).toMatch(
      /left join "app_organization_memberships" as "m" on "m"\."app_user_id" = "flipped"\."id" and "m"\."source_provider" = \$\d+/,
    );
    expect(batch).toContain('"m"."organization_id" as "organizationId"');
    expect(script.statements[0]!.parameters).toContain("pending_approval");
    expect(script.statements[0]!.parameters).toContain(MCP_REAP_BATCH_SIZE);
  });

  it("F-75: binds the same few parameters however many users a batch flips", async () => {
    // Past node-postgres's 16-bit parameter count: the pre-F-75 cascade bound
    // one parameter per flipped id and could not be sent at all.
    const flood = agents(70_000);
    script.batches = [flood];
    expect(await expireStalePendingMcpRegistrations(7, { batchSize: 70_000 })).toEqual({
      expired: 70_000,
      ttlDays: 7,
      drained: true,
    });

    const ids = new Set(flood.map((agent) => agent.id));
    expect(script.statements.length).toBeGreaterThan(0);
    for (const statement of script.statements) {
      expect(statement.parameters.length).toBeLessThan(20);
      expect(statement.parameters.some((p) => typeof p === "string" && ids.has(p))).toBe(false);
    }
  });

  it("F-75: loops until a batch expires NOTHING, not until a short one", async () => {
    // A short middle batch is what a row lost to a concurrent Approve looks
    // like; the pass must not stop there.
    script.batches = [agents(3), agents(1, 3), agents(2, 4)];
    expect(await expireStalePendingMcpRegistrations(7, { batchSize: 3 })).toEqual({
      expired: 6,
      ttlDays: 7,
      drained: true,
    });
    expect(script.statements).toHaveLength(4);
    for (const statement of script.statements) expect(statement.parameters).toContain(3);
  });

  it("F-75: starts no batch after its deadline, but finishes and audits the one in hand", async () => {
    script.batches = [agents(2), agents(2, 2)];
    expect(
      await expireStalePendingMcpRegistrations(7, { batchSize: 2, deadline: Date.now() - 1 }),
    ).toEqual({ expired: 2, ttlDays: 7, drained: false });
    expect(script.statements).toHaveLength(1);
    expect(auditEvent).toHaveBeenCalledTimes(2);
    // A deadline still ahead does not cut the pass short.
    expect(
      await expireStalePendingMcpRegistrations(7, { batchSize: 2, deadline: Date.now() + 60_000 }),
    ).toEqual({ expired: 2, ttlDays: 7, drained: true });
  });

  it("F-79: audits each expired agent as mcp.client.expired, after its batch commits", async () => {
    script.batches = [agents(2), agents(1, 2)];
    await expireStalePendingMcpRegistrations(7, { batchSize: 2 });

    expect(auditEvent).toHaveBeenCalledTimes(3);
    expect(auditEvent.mock.calls[0]![0]).toEqual({
      eventType: "mcp.client.expired",
      outcome: "success",
      appUserId: "user-0",
      organizationId: "org-1",
      reason: MCP_EXPIRED_REGISTRATION_REASON,
      metadata: { clientId: "mcp_client_0", clientRowId: "client-row-0", ttlDays: 7 },
    });
    // No actor (nobody acted) and no executor: the rows go on the pool, after
    // the statement that expired them (DB-4).
    for (const [input] of auditEvent.mock.calls) {
      expect(input).not.toHaveProperty("actorBetterAuthUserId");
      expect(input).not.toHaveProperty("executor");
    }
    expect(auditEvent.mock.calls.map(([input]) => input.appUserId)).toEqual([
      "user-0",
      "user-1",
      "user-2",
    ]);
    expect(script.events).toEqual([
      "statement",
      "audit",
      "audit",
      "statement",
      "audit",
      "statement",
    ]);
  });

  it("F-79: audits an agent whose client an admin revoked first, with no client", async () => {
    // The org still arrives: it is read from the membership (pinned above).
    script.batches = [[{ ...agents(1)[0]!, clientRowId: null, clientId: null }]];
    expect((await expireStalePendingMcpRegistrations(7)).expired).toBe(1);
    expect(auditEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        appUserId: "user-0",
        organizationId: "org-1",
        metadata: { clientId: null, clientRowId: null, ttlDays: 7 },
      }),
    );
  });

  it("fails the pass when an audit row cannot be written, instead of expiring silently", async () => {
    script.batches = [agents(1)];
    auditEvent.mockRejectedValueOnce(new Error("audit insert failed"));
    await expect(expireStalePendingMcpRegistrations(7)).rejects.toThrow("audit insert failed");
  });

  it("exports the machine-readable reason stamped on expired accounts", () => {
    expect(MCP_EXPIRED_REGISTRATION_REASON).toBe("mcp_registration_expired");
  });
});
