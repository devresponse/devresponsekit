import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for F-62 and F-114: how `POST /api/administrator/users/bulk`
 * expands `ids: "*"` ("select all matching") against the real `app_users`.
 *
 * Before F-62 the expansion ran `LIMIT 500` with no ORDER BY and no regard for
 * who sent it. With more matches than that it acted on whichever 500 the
 * planner returned while the grid said every match was selected, and "block
 * all active" blocked the admin who sent it. Before F-114 a `status` value
 * outside the allow-list was dropped, which widened the batch to every
 * status. Only the caller is stubbed (a superadmin cookie session); the route,
 * the status core, the audit writer and Postgres are real:
 *
 *   1. The matches are processed newest first, `id` breaking a tie, and the
 *      caller's own account is never one of them.
 *   2. More matches than MAX_BULK_IDS refuse the batch with 400
 *      `too_many_matches`, naming the count, and nothing is applied.
 *   3. An unrecognised or empty status filter is a 400, and nothing is
 *      applied.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_s11_`
 * and clean up after themselves.
 */
const sessionGetter = vi.fn();
const accessGetter = vi.fn();

vi.mock("@/lib/auth-guard", () => ({ getCurrentSession: () => sessionGetter() }));
vi.mock("@/lib/auth-status", async () => {
  const actual = await vi.importActual<typeof AuthStatusModule>("@/lib/auth-status");
  return { ...actual, getUserAccessContext: (id: string) => accessGetter(id) };
});

const { db, pgPool } = await import("@/db/database");
const { MAX_BULK_IDS } = await import("@/lib/admin/bulk-limits");
const { __resetRateLimitForTests } = await import("@/lib/admin/rate-limit.server");
const bulkUsers = await import("@/app/api/administrator/users/bulk/route");

const PREFIX = "__dbtest_s11_";
const RUN = randomUUID().slice(0, 8);
/** The caller's Better Auth id: plain text on audit rows, and on its own `app_users` row. */
const ACTOR = `${PREFIX}admin`;
/** Every fixture's address contains it, so the `q` filter confines a batch to this run. */
const TAG = `${PREFIX}${RUN}`;

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-s11-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.users.manage", "superuser"],
};

function post(body: unknown): NextRequest {
  const url = new URL("http://test.local/api/administrator/users/bulk");
  return {
    nextUrl: url,
    url: url.toString(),
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const approveAllMatching = (filters: Record<string, unknown>) =>
  bulkUsers.POST(post({ action: "approve", ids: "*", filters }));

async function insertUser(fixture: {
  id?: string;
  tag: string;
  status: string;
  createdAt: string;
  betterAuthUserId?: string;
}): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      ...(fixture.id ? { id: fixture.id } : {}),
      better_auth_user_id: fixture.betterAuthUserId ?? `${TAG}_ba_${fixture.tag}`,
      primary_email: `${TAG}_${fixture.tag}@dbtest.local`,
      status: fixture.status,
      created_at: sql`${fixture.createdAt}::timestamptz`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function statusOf(id: string): Promise<string> {
  const row = await db
    .selectFrom("app_users")
    .select("status")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.status;
}

async function countByStatus(status: string): Promise<number> {
  const row = await db
    .selectFrom("app_users")
    .select(sql<string>`count(*)`.as("n"))
    .where("primary_email", "like", `${PREFIX}%`)
    .where("status", "=", status)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function approvedAuditRows(): Promise<number> {
  const row = await db
    .selectFrom("app_audit_events")
    .select(sql<string>`count(*)`.as("n"))
    .where("actor_better_auth_user_id", "=", ACTOR)
    .where("event_type", "=", "admin.user.approved")
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function cleanup(): Promise<void> {
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them (matches the D3 retention job). They go first: a
  // success row names an app_users row deleted below.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where("actor_better_auth_user_id", "=", ACTOR)
      .execute();
  });
  await db.deleteFrom("app_users").where("primary_email", "like", `${PREFIX}%`).execute();
}

beforeEach(async () => {
  await cleanup();
  __resetRateLimitForTests();
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR }, session: { id: `${PREFIX}session` } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe('POST /api/administrator/users/bulk — ids "*" (F-62)', () => {
  it("processes every match newest first, id breaking a tie, and never the caller's own account", async () => {
    // Inserted oldest first, and the two sharing a `created_at` in ascending
    // `id` order, so both orders the query must produce are the reverse of the
    // stored one. Postgres keeps rows that tie on the sort key in the order it
    // reads them, so without the `id desc` tie-breaker the pair would come
    // back lower first.
    const [lower, higher] = [randomUUID(), randomUUID()].sort();
    const oldest = await insertUser({
      tag: "oldest",
      status: "pending_approval",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await insertUser({
      id: lower,
      tag: "tie_low",
      status: "pending_approval",
      createdAt: "2026-01-02T00:00:00Z",
    });
    await insertUser({
      id: higher,
      tag: "tie_high",
      status: "pending_approval",
      createdAt: "2026-01-02T00:00:00Z",
    });
    const newest = await insertUser({
      tag: "newest",
      status: "pending_approval",
      createdAt: "2026-01-03T00:00:00Z",
    });
    // The caller's own account matches the filter too, and is the newest.
    const own = await insertUser({
      tag: "own",
      status: "pending_approval",
      createdAt: "2026-01-04T00:00:00Z",
      betterAuthUserId: ACTOR,
    });

    const res = await approveAllMatching({ status: "pending_approval", q: TAG });

    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      attempted: number;
      succeeded: number;
      results: Array<{ ok: boolean; appUserId: string }>;
    };
    expect(body.results.map((r) => r.appUserId)).toEqual([newest, higher!, lower!, oldest]);
    expect(body).toMatchObject({ attempted: 4, succeeded: 4 });
    // Before F-62 the caller's row was in the batch, first by this order.
    expect(await statusOf(own)).toBe("pending_approval");
    expect(await statusOf(newest)).toBe("active");
  });

  it("refuses the whole batch, naming the count, when more users match than one batch may act on", async () => {
    await pgPool.query(
      `insert into app_users (better_auth_user_id, primary_email, status)
       select $1 || '_ba_' || n, $1 || '_many_' || n || '@dbtest.local', 'pending_approval'
         from generate_series(1, $2::int) as n`,
      [TAG, MAX_BULK_IDS + 1],
    );

    const res = await approveAllMatching({ status: "pending_approval", q: TAG });

    // Before F-62: 200, with an arbitrary 500 of the 501 approved.
    expect(res.status, await res.clone().text()).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "too_many_matches",
      matched: MAX_BULK_IDS + 1,
      max: MAX_BULK_IDS,
    });
    expect(await countByStatus("pending_approval")).toBe(MAX_BULK_IDS + 1);
    expect(await approvedAuditRows()).toBe(0);
  });
});

describe('POST /api/administrator/users/bulk — ids "*" status filter (F-114)', () => {
  it.each([
    ["an unrecognised status", "pending"],
    ["an unrecognised status in a list", ["pending_approval", "pending"]],
    ["an empty status list", []],
  ])("refuses %s rather than dropping it and widening the batch", async (_label, status) => {
    const pending = await insertUser({
      tag: "pending",
      status: "pending_approval",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const blocked = await insertUser({
      tag: "blocked",
      status: "blocked",
      createdAt: "2026-01-02T00:00:00Z",
    });

    const res = await approveAllMatching({ status, q: TAG });

    // Before F-114: 200. The unknown value was dropped and the approve went
    // ahead: on the rest of the list, or, with nothing left, on every status,
    // the blocked user included.
    expect(res.status, await res.clone().text()).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
    expect(await statusOf(pending)).toBe("pending_approval");
    expect(await statusOf(blocked)).toBe("blocked");
    expect(await approvedAuditRows()).toBe(0);
  });
});
