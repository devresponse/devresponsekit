import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

/**
 * DB-BACKED test for F-147: block and suspend end the account's Better Auth
 * sessions.
 *
 * They used to write only `app_users` and the memberships. The app guard
 * turned the account away, but Better Auth still honoured every session it
 * held: `/get-session` kept refreshing them, its self-service endpoints stayed
 * open to them, and reactivating the account brought each one back, a stolen
 * cookie included. Now a change that moves the ACCOUNT-GLOBAL status away from
 * `active` deletes the account's sessions and the ones it opened as someone
 * else (`impersonatedBy`, F-08), through the revoke-all wrapper. A change
 * confined to one org of a shared user (an org admin's, or any API key's or
 * JWT's, whose scope is the same `{ kind: "org" }`) deletes none: a session is
 * not tied to an org, and the user is still active in the others.
 *
 * This runs the real status core, the real bulk helper, Better Auth's real
 * internal adapter and the real audit writer against Postgres. The session
 * rows are real rows in Better Auth's `session` table, inserted directly so no
 * sign-in hook runs, and "is it still valid" is asked of Better Auth itself
 * (`internalAdapter.findSession`, the lookup behind every cookie).
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use
 * `__dbtest_f147_` and clean up after themselves.
 */
const { db, pgPool } = await import("@/db/database");
const { auth } = await import("@/lib/auth");
const { SUPERADMIN_PERMISSION } = await import("@/lib/admin/access-scope.server");
const { performAdminStatusChange } = await import("@/lib/admin-status.server");
const { executeBulkUserAction } = await import("@/lib/admin/user-actions.server");

const PREFIX = "__dbtest_f147_";
const RUN = randomUUID().slice(0, 8);
const ACTOR = `${PREFIX}actor`;
const ALL = { kind: "all" } as const;

interface Person {
  id: string;
  ba: string;
  email: string;
}

const w = {
  orgA: "",
  orgB: "",
  /** A member of ORG A only. */
  target: { id: "", ba: "", email: "" } as Person,
  /** Someone the target is impersonating. */
  victim: { id: "", ba: "", email: "" } as Person,
  /** A member of ORG A and ORG B. */
  shared: { id: "", ba: "", email: "" } as Person,
};

/** The session tokens seeded before each test. */
const tok = {
  targetLaptop: "",
  targetPhone: "",
  /** The victim's identity, driven by the target (`impersonatedBy`). */
  borrowed: "",
  /** The victim's own session: nothing here may touch it. */
  victimOwn: "",
  sharedOwn: "",
};

async function cleanup(): Promise<void> {
  const users = await db
    .selectFrom("app_users")
    .select("id")
    .where("better_auth_user_id", "like", `${PREFIX}%`)
    .execute();
  const userIds = users.map((u) => u.id);
  // Audit rows are append-only; the sanctioned retention GUC is the only path
  // that may delete them, and they must go before the users they reference.
  await db.transaction().execute(async (trx) => {
    await sql`set local app.audit_retention = 'on'`.execute(trx);
    await trx
      .deleteFrom("app_audit_events")
      .where((eb) =>
        eb.or([
          eb("actor_better_auth_user_id", "like", `${PREFIX}%`),
          ...(userIds.length > 0 ? [eb("app_user_id", "in", userIds)] : []),
        ]),
      )
      .execute();
  });
  if (userIds.length > 0) {
    await db
      .deleteFrom("app_organization_memberships")
      .where("app_user_id", "in", userIds)
      .execute();
    await db.deleteFrom("app_users").where("id", "in", userIds).execute();
  }
  await pgPool.query(`delete from "session" where "userId" like $1 or "impersonatedBy" like $1`, [
    `${PREFIX}%`,
  ]);
  await pgPool.query(`delete from "user" where id like $1`, [`${PREFIX}%`]);
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function person(key: string, orgIds: string[]): Promise<Person> {
  const ba = `${PREFIX}ba_${key}_${RUN}`;
  const email = `${PREFIX}${key}_${RUN}@dbtest.local`;
  await pgPool.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, true, now(), now())`,
    [ba, `F147 ${key}`, email],
  );
  const row = await db
    .insertInto("app_users")
    .values({ better_auth_user_id: ba, primary_email: email, status: "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const organization_id of orgIds) {
    await db
      .insertInto("app_organization_memberships")
      .values({ organization_id, app_user_id: row.id, status: "active" })
      .execute();
  }
  return { id: row.id, ba, email };
}

/** A live session row, as Better Auth writes one; returns its token. */
async function session(userId: string, impersonatedBy: string | null = null): Promise<string> {
  const token = `${PREFIX}tok_${randomUUID()}`;
  await pgPool.query(
    `insert into "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "impersonatedBy")
     values ($1, now() + interval '8 hours', $2, now(), now(), $3, $4)`,
    [`${PREFIX}s_${randomUUID()}`, token, userId, impersonatedBy],
  );
  return token;
}

/** Whether Better Auth would still accept this session token. */
async function valid(token: string): Promise<boolean> {
  const ctx = await auth.$context;
  return (await ctx.internalAdapter.findSession(token)) !== null;
}

const statusChange = (
  who: Person,
  newStatus: "active" | "blocked" | "suspended",
  eventType: string,
  scope: { kind: "all" } | { kind: "org"; organizationId: string } = ALL,
) =>
  performAdminStatusChange({
    actorBetterAuthUserId: ACTOR,
    scope,
    targetAppUserId: who.id,
    newStatus,
    newMembershipStatus: newStatus,
    eventType,
  });

beforeAll(async () => {
  await cleanup();
  for (const key of ["orgA", "orgB"] as const) {
    const org = await db
      .insertInto("app_organizations")
      .values({ slug: `${PREFIX}${key}_${RUN}`, name: `F147 ${key}`, status: "active" })
      .returning("id")
      .executeTakeFirstOrThrow();
    w[key] = org.id;
  }
  w.target = await person("target", [w.orgA]);
  w.victim = await person("victim", [w.orgA]);
  w.shared = await person("shared", [w.orgA, w.orgB]);
});

beforeEach(async () => {
  // Every account active again, and a fresh set of sessions.
  const ids = [w.target.id, w.victim.id, w.shared.id];
  await db.updateTable("app_users").set({ status: "active" }).where("id", "in", ids).execute();
  await db
    .updateTable("app_organization_memberships")
    .set({ status: "active" })
    .where("app_user_id", "in", ids)
    .execute();
  await pgPool.query(`delete from "session" where "userId" like $1 or "impersonatedBy" like $1`, [
    `${PREFIX}%`,
  ]);
  tok.targetLaptop = await session(w.target.ba);
  tok.targetPhone = await session(w.target.ba);
  tok.borrowed = await session(w.victim.ba, w.target.ba);
  tok.victimOwn = await session(w.victim.ba);
  tok.sharedOwn = await session(w.shared.ba);
  for (const token of Object.values(tok)) expect(await valid(token)).toBe(true);
});

afterAll(async () => {
  await cleanup();
});

describe("block and suspend end the account's Better Auth sessions (F-147)", () => {
  it("a block ends the account's sessions and the one it drives as someone else; reactivating revives none", async () => {
    await expect(statusChange(w.target, "blocked", "admin.user.blocked")).resolves.toEqual({
      ok: true,
      status: "blocked",
    });

    expect(await valid(tok.targetLaptop)).toBe(false);
    expect(await valid(tok.targetPhone)).toBe(false);
    // The victim's identity, which the target was driving (F-08).
    expect(await valid(tok.borrowed)).toBe(false);
    // Nobody else's: the victim's own session and an unrelated user's.
    expect(await valid(tok.victimOwn)).toBe(true);
    expect(await valid(tok.sharedOwn)).toBe(true);

    // The block's own audit row records that the sessions ended.
    const audit = await db
      .selectFrom("app_audit_events")
      .select(["metadata"])
      .where("app_user_id", "=", w.target.id)
      .where("event_type", "=", "admin.user.blocked")
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toMatchObject({ sessionsRevoked: true });

    // Reactivating brings the account back, not the sessions: a stolen cookie
    // replayed now is still refused.
    await expect(statusChange(w.target, "active", "admin.user.reactivated")).resolves.toEqual({
      ok: true,
      status: "active",
    });
    expect(await valid(tok.targetLaptop)).toBe(false);
    expect(await valid(tok.targetPhone)).toBe(false);
    expect(await valid(tok.borrowed)).toBe(false);
    const { rows } = await pgPool.query(
      `select count(*)::int as n from "session" where "userId" = $1 or "impersonatedBy" = $1`,
      [w.target.ba],
    );
    expect(rows[0].n).toBe(0);
  });

  it("a suspend through the bulk action ends them too", async () => {
    const outcome = await executeBulkUserAction(
      "suspend",
      {
        appUserId: w.target.id,
        betterAuthUserId: w.target.ba,
        primaryEmail: w.target.email,
        status: "active",
      },
      {
        betterAuthUserId: ACTOR,
        request: { headers: new Headers() },
        scope: ALL,
        access: { permissions: [SUPERADMIN_PERMISSION], organizationId: null },
        requestId: `${PREFIX}req`,
      },
    );
    expect(outcome).toEqual({ ok: true, appUserId: w.target.id });
    expect(await valid(tok.targetLaptop)).toBe(false);
    expect(await valid(tok.borrowed)).toBe(false);
    expect(await valid(tok.victimOwn)).toBe(true);
  });

  it("an org admin's block of a single-org member is account-wide, so it ends theirs", async () => {
    await expect(
      statusChange(w.target, "blocked", "admin.user.blocked", {
        kind: "org",
        organizationId: w.orgA,
      }),
    ).resolves.toEqual({ ok: true, status: "blocked" });
    expect(await valid(tok.targetLaptop)).toBe(false);
    expect(await valid(tok.borrowed)).toBe(false);
  });

  it("an org admin's block confined to one org of a shared member ends none", async () => {
    await expect(
      statusChange(w.shared, "blocked", "admin.user.blocked", {
        kind: "org",
        organizationId: w.orgA,
      }),
    ).resolves.toEqual({ ok: true, status: "blocked" });
    // Still active in ORG B, so still signed in.
    const account = await db
      .selectFrom("app_users")
      .select("status")
      .where("id", "=", w.shared.id)
      .executeTakeFirstOrThrow();
    expect(account.status).toBe("active");
    expect(await valid(tok.sharedOwn)).toBe(true);
  });

  it("approving or reactivating an active account signs nobody out", async () => {
    await expect(statusChange(w.target, "active", "admin.user.approved")).resolves.toEqual({
      ok: true,
      status: "active",
    });
    expect(await valid(tok.targetLaptop)).toBe(true);
    expect(await valid(tok.borrowed)).toBe(true);
  });
});
