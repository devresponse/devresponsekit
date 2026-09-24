import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { NextRequest } from "next/server";
import { runWithEndpointContext } from "@better-auth/core/context";
import type * as AuthStatusModule from "@/lib/auth-status";

/**
 * DB-BACKED test for F-30: the failure-path audits of user creation and the
 * bulk summary, run against the REAL `app_audit_events` foreign keys.
 *
 * Every route suite mocks `@/lib/audit.server`, so no test ever inserted these
 * rows, and they named ids that are not there: `create_failed` named the nil
 * UUID and the bulk summary named the first id the CALLER sent. `app_user_id`
 * references `app_users(id)`, so each insert failed with 23503 and the route
 * answered 500 with no audit row. For the create routes that replaced a
 * documented 409 or 502; for bulk it came AFTER every row's action had been
 * applied, so a client retry applied the batch twice.
 *
 * Here only the caller is stubbed (a superadmin cookie session). Better Auth,
 * the routes, the audit writer and Postgres are real:
 *
 *   1. An address Better Auth holds with no `app_users` row (a "ghost") and
 *      the loser of two concurrent creates answer 409, and the
 *      `admin.user.create_failed` row exists with a NULL `app_user_id`, on
 *      both the admin and the v1 route.
 *   2. A failed `app_users` insert (a real statement cancelled while it waits
 *      on a lock) answers the admin 500 / v1 502 and records the new Better
 *      Auth id, again naming no user.
 *   3. A bulk request carrying an id that matches no user answers 200 with a
 *      `not_found` row, applies the rest exactly once, and writes its summary.
 *   4. Better Auth's refusal of a held address arrives in two shapes, and
 *      `isAuthEmailTakenError` recognises both.
 *   5. `auditEvent`'s backstop: on the pool a reference to nothing is kept in
 *      metadata; inside a caller's transaction the violation still throws.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_f30_`
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
const { auth } = await import("@/lib/auth");
const { createBetterAuthUser } = await import("@/lib/admin/auth-admin.server");
const { isAuthEmailTakenError } = await import("@/lib/admin/auth-email-taken");
const { auditEvent } = await import("@/lib/audit.server");
const adminUsers = await import("@/app/api/administrator/users/route");
const v1Users = await import("@/app/api/v1/users/route");
const bulkUsers = await import("@/app/api/administrator/users/bulk/route");

const PREFIX = "__dbtest_f30_";
const RUN = randomUUID().slice(0, 8);
/**
 * `actor_better_auth_user_id` is plain text (no FK), so a prefixed literal is a
 * safe actor and the handle cleanup uses to find every audit row this file
 * wrote.
 */
const ACTOR = `${PREFIX}admin`;
const PASSWORD = "ci-only-f30-password-not-for-production";

const SUPERADMIN: AuthStatusModule.UserAccessContext = {
  appUserId: "dbtest-f30-admin",
  primaryEmail: "admin@dbtest.local",
  status: "active",
  organizationId: null,
  membershipStatus: "active",
  preferredLocale: "en",
  permissions: ["admin.users.create", "admin.users.manage", "superuser"],
};

let seq = 0;
function address(tag: string): string {
  seq += 1;
  return `${PREFIX}${tag}_${RUN}_${seq}@dbtest.local`;
}

function post(path: string, body: unknown): NextRequest {
  const url = new URL(`http://test.local${path}`);
  return {
    nextUrl: url,
    url: url.toString(),
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as NextRequest;
}

const createAsAdmin = (email: string) =>
  adminUsers.POST(post("/api/administrator/users", { email, password: PASSWORD }));
const createViaV1 = (email: string) =>
  v1Users.POST(post("/api/v1/users", { email, password: PASSWORD }));

/** A Better Auth identity with NO `app_users` row, as a failed provisioning leaves. */
async function ghost(tag: string): Promise<string> {
  const email = address(tag);
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, 'Ghost', $2, false, now(), now())`,
    [`${PREFIX}ba_${RUN}_${seq}`, email],
  );
  return email;
}

interface AuditRow {
  event_type: string;
  outcome: string;
  app_user_id: string | null;
  organization_id: string | null;
  email: string | null;
  reason: string | null;
  request_id: string | null;
  metadata: unknown;
}

async function auditRows(eventType: string, email?: string): Promise<AuditRow[]> {
  let query = db
    .selectFrom("app_audit_events")
    .select([
      "event_type",
      "outcome",
      "app_user_id",
      "organization_id",
      "email",
      "reason",
      "request_id",
      "metadata",
    ])
    .where("actor_better_auth_user_id", "=", ACTOR)
    .where("event_type", "=", eventType);
  if (email !== undefined) query = query.where("email", "=", email);
  return query.orderBy("created_at").execute();
}

function expectOne(rows: AuditRow[], what: string): AuditRow {
  expect(rows, `expected exactly one ${what} row`).toHaveLength(1);
  return rows[0] as AuditRow;
}

function metadataOf(row: AuditRow): Record<string, unknown> {
  // `metadata` is jsonb; `pg` parses it, but a driver that hands back text
  // must not make the assertions below vacuous.
  return typeof row.metadata === "string"
    ? (JSON.parse(row.metadata) as Record<string, unknown>)
    : (row.metadata as Record<string, unknown>);
}

async function appUserCount(email: string): Promise<number> {
  const row = await db
    .selectFrom("app_users")
    .select(sql<string>`count(*)`.as("n"))
    .where("primary_email", "=", email)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

async function betterAuthIds(email: string): Promise<string[]> {
  const { rows } = await pgPool.query<{ id: string }>(`select id from "user" where email = $1`, [
    email,
  ]);
  return rows.map((r) => r.id);
}

/**
 * Sends a request while another connection holds a SHARE lock on `app_users`
 * (reads pass, INSERTs wait), and cancels the route's INSERT the moment it
 * queues. That is a real statement failure (57014) in exactly the write under
 * test, a stand-in for the lock or statement timeout the review describes,
 * with no mock and no timing guess: a statement waiting on a lock cannot
 * finish, so the cancel always lands on it.
 */
async function withAppUsersInsertCancelled(send: () => Promise<Response>): Promise<Response> {
  const holder = await pgPool.connect();
  try {
    await holder.query("begin");
    await holder.query("lock table app_users in share mode");
    const pending = send();
    let pid: number | undefined;
    for (let i = 0; i < 200 && pid === undefined; i += 1) {
      const { rows } = await pgPool.query<{ pid: number }>(
        `select pid from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like 'insert into "app_users"%'`,
      );
      pid = rows[0]?.pid;
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(pid, "the route's app_users INSERT never queued behind the lock").toBeDefined();
    await pgPool.query("select pg_cancel_backend($1)", [pid]);
    return await pending;
  } finally {
    await holder.query("rollback");
    holder.release();
  }
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
  // `account` and `session` rows cascade with their user.
  await pgPool.query(`delete from "user" where email like $1`, [`${PREFIX}%`]);
}

beforeEach(async () => {
  await cleanup();
  sessionGetter.mockReset();
  accessGetter.mockReset();
  sessionGetter.mockResolvedValue({ user: { id: ACTOR }, session: { id: `${PREFIX}session` } });
  accessGetter.mockResolvedValue(SUPERADMIN);
});

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("POST /api/administrator/users — failure audits against the real FK (F-30)", () => {
  it("answers 409 for an address Better Auth holds with no app_users row, and audits it naming no user", async () => {
    const email = await ghost("admin-ghost");

    const res = await createAsAdmin(email);

    // Before F-30: 500. Better Auth refused the address, the create_failed
    // row named the nil UUID, and that insert failed the foreign key.
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ error: "email_taken" });

    const row = expectOne(await auditRows("admin.user.create_failed", email), "create_failed");
    expect(row).toMatchObject({ outcome: "error", app_user_id: null, reason: "auth_user_exists" });
    // Named null by the route itself, not rescued by the audit backstop.
    expect(metadataOf(row)).not.toHaveProperty("unresolvedAppUserId");
    expect(await appUserCount(email)).toBe(0);
  });

  it("answers 201 and 409 to two concurrent creates of one address, auditing the loser", async () => {
    const email = address("admin-race");

    const statuses = (await Promise.all([createAsAdmin(email), createAsAdmin(email)]))
      .map((r) => r.status)
      .sort();

    // Both pass the courtesy check on `app_users`; Better Auth's unique email
    // refuses the loser, and that refusal is the documented 409.
    expect(statuses).toEqual([201, 409]);
    expect(await betterAuthIds(email)).toHaveLength(1);
    expect(await appUserCount(email)).toBe(1);
    const row = expectOne(await auditRows("admin.user.create_failed", email), "create_failed");
    expect(row).toMatchObject({ app_user_id: null, reason: "auth_user_exists" });
  });

  it("answers 500 when the app_users insert fails, and records the orphaned Better Auth id", async () => {
    const email = address("admin-insert");

    const res = await withAppUsersInsertCancelled(() => createAsAdmin(email));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "internal_error" });
    expect(await appUserCount(email)).toBe(0);
    const [betterAuthUserId] = await betterAuthIds(email);
    expect(betterAuthUserId).toBeDefined();

    const row = expectOne(await auditRows("admin.user.create_failed", email), "create_failed");
    expect(row).toMatchObject({ outcome: "error", app_user_id: null, reason: "db_insert_failed" });
    expect(metadataOf(row)).toEqual({ betterAuthUserId });
  });
});

describe("POST /api/v1/users — failure audits against the real FK (F-30)", () => {
  it("answers 409 conflict for an address Better Auth holds with no app_users row", async () => {
    const email = await ghost("v1-ghost");

    const res = await createViaV1(email);

    // Before F-30: 502, an "identity provider" failure, for a plain conflict.
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: "conflict" });
    const row = expectOne(await auditRows("admin.user.create_failed", email), "create_failed");
    expect(row).toMatchObject({ app_user_id: null, reason: "auth_user_exists" });
    expect(metadataOf(row)).toMatchObject({ via: "api.v1" });
  });

  it("answers its documented 502 when the app_users insert fails, auditing it naming no user", async () => {
    const email = address("v1-insert");

    const res = await withAppUsersInsertCancelled(() => createViaV1(email));

    // Before F-30: 500. The audit named the nil UUID and failed the FK.
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "internal_error" });
    const [betterAuthUserId] = await betterAuthIds(email);
    const row = expectOne(await auditRows("admin.user.create_failed", email), "create_failed");
    expect(row).toMatchObject({ app_user_id: null, reason: "db_insert_failed" });
    expect(metadataOf(row)).toEqual({ betterAuthUserId, via: "api.v1" });
  });
});

describe("POST /api/administrator/users/bulk — an id that matches no user (F-30)", () => {
  it("answers 200 with a not_found row, applies the rest once, and writes the summary", async () => {
    const email = address("bulk-target");
    const target = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}ba_bulk_${RUN}`,
        primary_email: email,
        status: "pending_approval",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const unknown = randomUUID();

    const res = await bulkUsers.POST(
      post("/api/administrator/users/bulk", { action: "approve", ids: [unknown, target.id] }),
    );

    // Before F-30: 500, AFTER the approval below had been applied. The summary
    // named `ids[0]`, which the caller chose and which matched nobody.
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { ok: false, appUserId: unknown, error: "not_found" },
        { ok: true, appUserId: target.id },
      ],
    });
    const status = await db
      .selectFrom("app_users")
      .select("status")
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe("active");
    expect(await auditRows("admin.user.approved")).toHaveLength(1);

    const summary = expectOne(await auditRows("admin.users.bulk_action"), "bulk summary");
    expect(summary.app_user_id).toBeNull();
    expect(summary.outcome).toBe("failure");
    expect(metadataOf(summary)).toEqual({
      action: "approve",
      attempted: 2,
      succeeded: 1,
      failed: 1,
      ids: "2 ids",
    });
  });
});

describe("Better Auth's refusal of a held address (isAuthEmailTakenError)", () => {
  it("is recognised in the plugin's shape and in the raw unique violation a lost race raises", async () => {
    const email = await ghost("shapes");
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => {
          throw new Error("expected Better Auth to refuse the address");
        },
        (err: unknown) => err,
      );

    // The admin plugin looks the address up before inserting.
    const pluginRefusal = await refused(createBetterAuthUser({ email, password: PASSWORD }));
    expect(pluginRefusal).toMatchObject({
      statusCode: 400,
      body: { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" },
    });
    expect(isAuthEmailTakenError(pluginRefusal)).toBe(true);

    // A race loser passed that lookup, so its INSERT meets the unique key:
    // the adapter call the plugin makes next, made directly.
    const ctx = await auth.$context;
    const raceRefusal = await refused(
      runWithEndpointContext({ context: ctx } as never, () =>
        ctx.internalAdapter.createUser({ email, name: "Racer", emailVerified: true }, {
          method: "admin",
        } as never),
      ),
    );
    expect(raceRefusal).toMatchObject({ code: "23505", constraint: "user_email_key" });
    expect(isAuthEmailTakenError(raceRefusal)).toBe(true);
  });
});

describe("auditEvent — a reference to a row that does not exist (F-30 backstop)", () => {
  it("on the pool, writes the row with the dangling columns null and their ids in metadata", async () => {
    const appUserId = randomUUID();
    const organizationId = randomUUID();

    await auditEvent({
      eventType: "dbtest.f30.dangling_reference",
      outcome: "success",
      actorBetterAuthUserId: ACTOR,
      appUserId,
      organizationId,
      metadata: { kept: true },
    });

    const row = expectOne(await auditRows("dbtest.f30.dangling_reference"), "probe");
    expect(row).toMatchObject({ app_user_id: null, organization_id: null });
    expect(metadataOf(row)).toEqual({
      kept: true,
      unresolvedAppUserId: appUserId,
      unresolvedOrganizationId: organizationId,
    });
  });

  it("keeps a reference that resolves while clearing one that does not", async () => {
    const real = await db
      .insertInto("app_users")
      .values({
        better_auth_user_id: `${PREFIX}ba_ref_${RUN}`,
        primary_email: address("reference"),
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const organizationId = randomUUID();

    await auditEvent({
      eventType: "dbtest.f30.dangling_reference",
      outcome: "success",
      actorBetterAuthUserId: ACTOR,
      appUserId: real.id,
      organizationId,
    });

    const row = expectOne(await auditRows("dbtest.f30.dangling_reference"), "probe");
    expect(row).toMatchObject({ app_user_id: real.id, organization_id: null });
    expect(metadataOf(row)).toEqual({ unresolvedOrganizationId: organizationId });
  });

  it("inside a caller's transaction, still throws the violation: a retry there cannot succeed", async () => {
    await expect(
      db.transaction().execute((trx) =>
        auditEvent({
          eventType: "dbtest.f30.dangling_reference",
          outcome: "success",
          actorBetterAuthUserId: ACTOR,
          appUserId: randomUUID(),
          executor: trx,
        }),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "app_audit_events_app_user_id_fkey" });
    expect(await auditRows("dbtest.f30.dangling_reference")).toHaveLength(0);
  });
});
