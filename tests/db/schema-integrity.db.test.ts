import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { DB_SCHEMA } from "@/db/schema-config";
import { isSsoAudienceUniqueViolation } from "@/lib/admin/enterprise-apps-audience.server";
import { pruneAuditEvents } from "@/lib/retention.server";

/**
 * DB-BACKED proof of the invariants migration 0005-integrity-constraints.sql
 * moves into the schema (source review 2026-09-04: #15, #63, #83, #89, #217,
 * #218). Every case here is a real statement against the migrated database —
 * the unit suites mock the DB, so nothing else verifies that the constraints,
 * trigger and role grants actually behave.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts). Fixtures use `__dbtest_si_`
 * and self-clean. Audit rows are dated a CENTURY back so the prune assertions
 * can use a 100-year window and never touch anyone else's rows in a shared
 * dev database.
 */
const PREFIX = "__dbtest_si_";
const RUNTIME_ROLE = `${DB_SCHEMA}_runtime`;

type PgError = { code?: string; constraint?: string; message: string };

async function expectPgError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (err) {
    return err as PgError;
  }
  throw new Error("expected the statement to be rejected");
}

async function cleanup(): Promise<void> {
  await db
    .deleteFrom("app_user_roles")
    .where("role_id", "in", (eb) =>
      eb.selectFrom("app_roles").select("id").where("key", "like", `${PREFIX}%`),
    )
    .execute();
  await db.deleteFrom("app_groups").where("key", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_roles").where("key", "like", `${PREFIX}%`).execute();
  await db
    .deleteFrom("app_organization_invitations")
    .where("email", "like", `${PREFIX}%`)
    .execute();
  await db.deleteFrom("app_enterprise_applications").where("id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_users").where("better_auth_user_id", "like", `${PREFIX}%`).execute();
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
  // Audit rows are append-only. The suite's probe rows (any age) are removed
  // through the OWNER path the "owner with the marker" case below documents —
  // the test connection is the owner, so marker + DELETE in one transaction
  // is exactly the residual gap that case proves. Real rows are untouched.
  await db.transaction().execute(async (trx) => {
    await sql`select set_config('app.audit_retention', 'on', true)`.execute(trx);
    await trx.deleteFrom("app_audit_events").where("event_type", "=", `${PREFIX}probe`).execute();
  });
}

async function newOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest SI ${slug}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newRole(orgId: string | null, key: string): Promise<string> {
  const row = await db
    .insertInto("app_roles")
    .values({ organization_id: orgId, key: `${PREFIX}${key}`, name: `DBTest ${key}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newUser(handle: string): Promise<string> {
  const row = await db
    .insertInto("app_users")
    .values({
      better_auth_user_id: `${PREFIX}${handle}`,
      primary_email: `${PREFIX}${handle}@example.test`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function newApp(id: string, audience: string, status = "available"): Promise<void> {
  await db
    .insertInto("app_enterprise_applications")
    .values({
      id: `${PREFIX}${id}`,
      label: id,
      origin: `https://${id}.example.test`,
      subdomain: id,
      sso_audience: audience,
      status,
    })
    .execute();
}

/** Inserts an audit probe row `years` back (101 = "aged", 99 = "younger"). */
async function oldAuditRow(years: 99 | 101): Promise<string> {
  const row = await db
    .insertInto("app_audit_events")
    .values({
      event_type: `${PREFIX}probe`,
      outcome: "success",
      created_at: sql`now() - make_interval(years => ${years})`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("#89 — every FK column has a leading-column index (or a reasoned allowlist entry)", () => {
  /**
   * FK columns deliberately left unindexed: RI-checked only on parent deletes
   * of tiny or continuously-pruned tables, where an index costs more on every
   * write than it saves. Adding an index for one of these means removing it
   * here; a NEW unindexed FK column fails this test.
   */
  const ALLOWLIST: ReadonlyArray<[table: string, column: string, reason: string]> = [
    ["app_api_keys", "created_by", "tiny table; actor attribution only, never joined by"],
    ["app_api_keys", "revoked_by", "tiny table; actor attribution only, never joined by"],
    ["app_oauth_clients", "created_by", "tiny table; actor attribution only, never joined by"],
    ["app_oauth_clients", "revoked_by", "tiny table; actor attribution only, never joined by"],
    ["app_organization_invitations", "invited_by", "small table; SET NULL on a rare user delete"],
    [
      "app_organization_invitations",
      "accepted_app_user_id",
      "small table; SET NULL on a rare user delete",
    ],
    ["app_sso_handoff_nonces", "app_user_id", "pruned on every launch; stays a few rows"],
    ["app_sso_handoff_nonces", "target_application_id", "pruned on every launch; stays a few rows"],
  ];

  it("lists exactly the allowlisted columns", async () => {
    const { rows } = await sql<{ tbl: string; col: string }>`
      select con.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
      join pg_namespace n on n.oid = con.connamespace
      where con.contype = 'f'
        and n.nspname = current_schema()
        and not exists (
          select 1 from pg_index i
          where i.indrelid = con.conrelid
            and i.indkey[0] = con.conkey[1]
            and i.indpred is null
        )
      order by 1, 2
    `.execute(db);
    const unindexed = rows.map((r) => `${r.tbl}.${r.col}`).sort();
    const allowed = ALLOWLIST.map(([t, c]) => `${t}.${c}`).sort();
    expect(unindexed).toEqual(allowed);
  });

  it("has the indexes 0005 adds for the org-scoped client paths and the listed FK columns", async () => {
    const { rows } = await sql<{ indexname: string }>`
      select indexname from pg_indexes where schemaname = current_schema()
    `.execute(db);
    const names = new Set(rows.map((r) => r.indexname));
    for (const name of [
      "idx_app_oauth_clients_org_status",
      "idx_app_oauth_clients_app_user_id",
      "idx_app_org_invitations_role_id",
      "idx_app_provider_organizations_organization_id",
      "idx_app_enterprise_applications_organization_id",
      "idx_app_user_roles_organization_id",
      "idx_app_audit_events_app_user_id",
    ]) {
      expect(names.has(name), `missing index ${name}`).toBe(true);
    }
  });
});

describe("#15 — sso_audience is UNIQUE at the database", () => {
  it("rejects a second app with the same audience with a 23505 the routes map to audience_taken", async () => {
    await newApp("one", `${PREFIX}aud`);
    const err = await expectPgError(newApp("two", `${PREFIX}aud`));
    expect(err.code).toBe("23505");
    expect(err.constraint).toBe("idx_app_enterprise_applications_sso_audience");
    expect(isSsoAudienceUniqueViolation(err)).toBe(true);
  });

  it("a primary-key collision is a DIFFERENT 23505 (id_taken, not audience_taken)", async () => {
    await newApp("same", `${PREFIX}aud-a`);
    const err = await expectPgError(newApp("same", `${PREFIX}aud-b`));
    expect(err.code).toBe("23505");
    expect(isSsoAudienceUniqueViolation(err)).toBe(false);
  });
});

describe("#63 / #217 — status CHECK constraints", () => {
  it("rejects `degraded` for an enterprise app (one state model)", async () => {
    const err = await expectPgError(newApp("deg", `${PREFIX}aud-deg`, "degraded"));
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe("app_enterprise_applications_status_check");
  });

  it("rejects an unknown organization status", async () => {
    const err = await expectPgError(
      db
        .insertInto("app_organizations")
        .values({ slug: `${PREFIX}bad`, name: "bad", status: "bogus" })
        .execute(),
    );
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe("app_organizations_status_check");
  });

  it("rejects an unknown user status and an unknown membership pre_deactivation_status", async () => {
    const userErr = await expectPgError(
      db
        .insertInto("app_users")
        .values({
          better_auth_user_id: `${PREFIX}bad`,
          primary_email: `${PREFIX}bad@example.test`,
          status: "bogus",
        })
        .execute(),
    );
    expect(userErr.constraint).toBe("app_users_status_check");

    const orgId = await newOrg("m");
    const userId = await newUser("m");
    const memErr = await expectPgError(
      db
        .insertInto("app_organization_memberships")
        .values({
          organization_id: orgId,
          app_user_id: userId,
          status: "active",
          pre_deactivation_status: "bogus",
        })
        .execute(),
    );
    expect(memErr.constraint).toBe("app_organization_memberships_pre_deactivation_status_check");
  });

  it("rejects a non-lowercase invitation email", async () => {
    const orgId = await newOrg("inv");
    const err = await expectPgError(
      db
        .insertInto("app_organization_invitations")
        .values({
          organization_id: orgId,
          email: `${PREFIX}Mixed@Example.test`,
          token_hash: `${PREFIX}${Date.now()}`,
          expires_at: sql`now() + interval '1 day'`,
        })
        .execute(),
    );
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe("app_organization_invitations_email_lower_check");
  });
});

describe("#218 — same-organization invariant for group roles and user roles", () => {
  it("app_group_roles: a role from another org is unrepresentable (composite FK)", async () => {
    const orgA = await newOrg("a");
    const orgB = await newOrg("b");
    const roleB = await newRole(orgB, "b-role");
    const group = await db
      .insertInto("app_groups")
      .values({ organization_id: orgA, key: `${PREFIX}grp`, name: "g" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const err = await expectPgError(
      db
        .insertInto("app_group_roles")
        .values({ group_id: group.id, role_id: roleB, organization_id: orgA })
        .execute(),
    );
    expect(err.code).toBe("23503");
    expect(err.constraint).toBe("app_group_roles_role_org_fkey");
    // …and lying about the org to match the role fails on the GROUP side.
    const lie = await expectPgError(
      db
        .insertInto("app_group_roles")
        .values({ group_id: group.id, role_id: roleB, organization_id: orgB })
        .execute(),
    );
    expect(lie.constraint).toBe("app_group_roles_group_org_fkey");
    // A same-org role binds.
    const roleA = await newRole(orgA, "a-role");
    await db
      .insertInto("app_group_roles")
      .values({ group_id: group.id, role_id: roleA, organization_id: orgA })
      .execute();
  });

  it("app_group_roles: an insert WITHOUT organization_id (the pre-0005 build's shape) succeeds and lands in the group's org", async () => {
    // Deployment §2 promises migrate-first + rollback safety: the build that
    // is live while 0005 runs inserts `{group_id, role_id}` only. NOT NULL
    // without the bind trigger turned that into a 23502 and a 500 on
    // POST /api/administrator/groups/[id]/roles for the whole window.
    const orgA = await newOrg("a");
    const roleA = await newRole(orgA, "a-role");
    const group = await db
      .insertInto("app_groups")
      .values({ organization_id: orgA, key: `${PREFIX}grp`, name: "g" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await sql`insert into app_group_roles (group_id, role_id) values (${group.id}, ${roleA})`.execute(
      db,
    );
    const row = await db
      .selectFrom("app_group_roles")
      .select("organization_id")
      .where("group_id", "=", group.id)
      .where("role_id", "=", roleA)
      .executeTakeFirstOrThrow();
    expect(row.organization_id).toBe(orgA);
    // The trigger fills a gap; it never launders a cross-org role — the
    // derived org still has to satisfy the role-side composite FK.
    const orgB = await newOrg("b");
    const roleB = await newRole(orgB, "b-role");
    const err = await expectPgError(
      sql`insert into app_group_roles (group_id, role_id) values (${group.id}, ${roleB})`.execute(
        db,
      ),
    );
    expect(err.code).toBe("23503");
    expect(err.constraint).toBe("app_group_roles_role_org_fkey");
    // An unknown group is reported as the group FK (the trigger raises it —
    // NOT NULL runs before FK checks and would otherwise mask it as a 23502).
    const ghost = await expectPgError(
      sql`insert into app_group_roles (group_id, role_id) values (gen_random_uuid(), ${roleA})`.execute(
        db,
      ),
    );
    expect(ghost.code).toBe("23503");
    expect(ghost.constraint).toBe("app_group_roles_group_id_fkey");
  });

  it("app_group_roles: a GLOBAL role cannot be bundled (ADR-0002)", async () => {
    const orgA = await newOrg("a");
    const globalRole = await newRole(null, "global");
    const group = await db
      .insertInto("app_groups")
      .values({ organization_id: orgA, key: `${PREFIX}grp`, name: "g" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const err = await expectPgError(
      db
        .insertInto("app_group_roles")
        .values({ group_id: group.id, role_id: globalRole, organization_id: orgA })
        .execute(),
    );
    expect(err.constraint).toBe("app_group_roles_role_org_fkey");
  });

  it("app_user_roles: an org-B role cannot be assigned inside org A (trigger), org-A can, global can", async () => {
    const orgA = await newOrg("a");
    const orgB = await newOrg("b");
    const userId = await newUser("u");
    const roleB = await newRole(orgB, "b-role");
    const err = await expectPgError(
      db
        .insertInto("app_user_roles")
        .values({ app_user_id: userId, organization_id: orgA, role_id: roleB })
        .execute(),
    );
    expect(err.code).toBe("23514");
    expect(err.constraint).toBe("app_user_roles_role_organization_id_check");
    expect(err.message).toMatch(/cannot be assigned inside organization/);

    const roleA = await newRole(orgA, "a-role");
    const globalRole = await newRole(null, "global");
    await db
      .insertInto("app_user_roles")
      .values([
        { app_user_id: userId, organization_id: orgA, role_id: roleA },
        { app_user_id: userId, organization_id: orgA, role_id: globalRole },
      ])
      .execute();
    const rows = await db
      .selectFrom("app_user_roles")
      .select(["role_id", "role_organization_id"])
      .where("app_user_id", "=", userId)
      .execute();
    expect(new Map(rows.map((r) => [r.role_id, r.role_organization_id]))).toEqual(
      new Map([
        [roleA, orgA],
        [globalRole, null],
      ]),
    );
  });

  it("app_user_roles: a forged role_organization_id is re-derived by the trigger", async () => {
    const orgA = await newOrg("a");
    const userId = await newUser("u");
    const globalRole = await newRole(null, "global");
    await db
      .insertInto("app_user_roles")
      .values({ app_user_id: userId, organization_id: orgA, role_id: globalRole })
      .execute();
    await db
      .updateTable("app_user_roles")
      .set({ role_organization_id: orgA })
      .where("app_user_id", "=", userId)
      .execute();
    const row = await db
      .selectFrom("app_user_roles")
      .select("role_organization_id")
      .where("app_user_id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row.role_organization_id).toBeNull();
  });
});

describe("#83 — audit table: append-only trigger, SECURITY DEFINER prune, runtime role", () => {
  it("rejects an ad-hoc DELETE even from the owning role, naming the session and effective roles", async () => {
    const id = await oldAuditRow(101);
    const err = await expectPgError(
      db.deleteFrom("app_audit_events").where("id", "=", id).execute(),
    );
    expect(err.code).toBe("23514");
    expect(err.message).toMatch(
      /append-only: DELETE is not permitted \(session_user=\w+, current_user=\w+\)/,
    );
  });

  it("the OWNER role with the marker on can still delete — the residual gap the runtime-role switch closes", async () => {
    // The honest negative (review #83): the trigger's owner half is what a
    // runtime-role session can never satisfy, but the test suite — like the
    // application until Deployment §8 is followed — connects as the owner.
    // Documented in admin-manager §12.1; do not "fix" this by weakening the
    // owner path, the fix is the role switch.
    const id = await oldAuditRow(101);
    const client = await pgPool.connect();
    try {
      await client.query("begin");
      const who = await client.query<{ owner: string; me: string }>(
        `select pg_get_userbyid(c.relowner) as owner, current_user as me
           from pg_class c
          where c.oid = 'app_audit_events'::regclass`,
      );
      expect(who.rows[0]!.me).toBe(who.rows[0]!.owner);
      await client.query(`set local app.audit_retention = 'on'`);
      const del = await client.query(`delete from app_audit_events where id = $1`, [id]);
      expect(del.rowCount).toBe(1);
    } finally {
      await client.query("rollback");
      client.release();
    }
    // Rolled back: the row is still there, and without the marker it stays.
    const err = await expectPgError(
      db.deleteFrom("app_audit_events").where("id", "=", id).execute(),
    );
    expect(err.code).toBe("23514");
  });

  it("a NON-owner role that holds DELETE and sets the marker is still rejected (23514) — the owner half of the trigger", async () => {
    // Review #83 must-fix: every other case here runs as the owner, so the
    // `current_user = owner` condition never failed and could be deleted
    // from the trigger unnoticed. This one runs as a throwaway role that has
    // MORE than the runtime role (DELETE on the table) and still sets the
    // marker — only condition (1) stands between it and the row. CREATE ROLE
    // is transactional, so the rollback removes the role again. Needs a
    // superuser test connection for SET ROLE (the local devresponse role and
    // CI's service user both are).
    const id = await oldAuditRow(101);
    const client = await pgPool.connect();
    const role = "__dbtest_si_audit_deleter";
    try {
      const su = await client.query<{ rolsuper: boolean }>(
        `select rolsuper from pg_roles where rolname = current_user`,
      );
      expect(su.rows[0]!.rolsuper, "this case needs a superuser test connection (SET ROLE)").toBe(
        true,
      );
      await client.query("begin");
      await client.query(`create role "${role}" nologin`);
      await client.query(`grant usage on schema "${DB_SCHEMA}" to "${role}"`);
      await client.query(`grant select, delete on app_audit_events to "${role}"`);
      await client.query(`set local role "${role}"`);
      await client.query(`set local app.audit_retention = 'on'`);
      let err: PgError | undefined;
      try {
        await client.query(`delete from app_audit_events where id = $1`, [id]);
      } catch (e) {
        err = e as PgError;
      }
      expect(err?.code).toBe("23514");
      expect(err?.message).toMatch(new RegExp(`current_user=${role}\\)`));
    } finally {
      await client.query("rollback");
      client.release();
    }
    // Still there (and the role is gone with the rollback).
    const left = await db
      .selectFrom("app_audit_events")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    expect(left?.id).toBe(id);
    const gone = await sql<{
      n: string;
    }>`select count(*) as n from pg_roles where rolname = ${role}`.execute(db);
    expect(Number(gone.rows[0]!.n)).toBe(0);
  });

  it(`app_audit_events_prune(1, n) called AS ${RUNTIME_ROLE} cannot reach a 2-day-old row — the window is clamped to the owner's 30-day floor`, async () => {
    // Review #83 must-fix: the SECURITY DEFINER function is the runtime
    // role's only DELETE path, so its p_days must not be the whole policy.
    // Runs inside a rolled-back transaction because, clamped to 30 days, the
    // call WOULD prune real rows older than a month on a long-lived dev DB.
    const recent = await db
      .insertInto("app_audit_events")
      .values({
        event_type: `${PREFIX}probe`,
        outcome: "success",
        created_at: sql`now() - interval '2 days'`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const aged = await oldAuditRow(101);
    const client = await pgPool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role "${RUNTIME_ROLE}"`);
      // Drain like the worker does, so the aged probe is reached whatever
      // else is older than the floor.
      for (;;) {
        const { rows } = await client.query<{ n: number }>(
          `select app_audit_events_prune(1, 10000) as n`,
        );
        if (Number(rows[0]!.n) < 10000) break;
      }
      const { rows } = await client.query<{ id: string }>(
        `select id from app_audit_events where id = any($1::uuid[])`,
        [[recent.id, aged]],
      );
      // The 2-day-old row survived a request for a 1-day window; the
      // 101-year-old row is gone, proving the function did run and delete.
      expect(rows.map((r) => r.id)).toEqual([recent.id]);
      // The batch cap: asking for a million rows per call is honoured as at
      // most 10000 — the function's own limit, not the caller's.
      const cap = await client.query<{ n: number }>(
        `select app_audit_events_prune(36500, 1000000) as n`,
      );
      expect(Number(cap.rows[0]!.n)).toBeLessThanOrEqual(10000);
    } finally {
      await client.query("rollback");
      client.release();
    }
    // (The recent probe is still there after the rollback; cleanup() removes it.)
  });

  it("pruneAuditEvents deletes ONLY aged rows, through app_audit_events_prune(), in batches", async () => {
    const a = await oldAuditRow(101);
    const b = await oldAuditRow(101);
    const younger = await oldAuditRow(99);
    // 36500 days ≈ 99.9 years: the two 101-year rows are due, the 99-year one
    // is not. batchSize 1 → two full batches then an empty one.
    expect(await pruneAuditEvents(36500, 1)).toBe(2);
    const left = await db
      .selectFrom("app_audit_events")
      .select("id")
      .where("id", "in", [a, b, younger])
      .execute();
    expect(left.map((r) => r.id)).toEqual([younger]);
  });

  it("the prune function is SECURITY DEFINER with a pinned search_path and is not PUBLIC-executable", async () => {
    const { rows } = await sql<{ prosecdef: boolean; proconfig: string[] | null }>`
      select p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'app_audit_events_prune' and n.nspname = current_schema()
    `.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prosecdef).toBe(true);
    expect(rows[0]!.proconfig?.some((c) => c.startsWith("search_path="))).toBe(true);
    const pub = await sql<{ ok: boolean }>`
      select has_function_privilege('public', 'app_audit_events_prune(integer, integer)', 'execute') as ok
    `.execute(db);
    expect(pub.rows[0]!.ok).toBe(false);
  });

  it(`the runtime role ${RUNTIME_ROLE} exists (NOLOGIN) with INSERT/SELECT only on the audit table and full DML elsewhere`, async () => {
    const role = await sql<{ rolcanlogin: boolean }>`
      select rolcanlogin from pg_roles where rolname = ${RUNTIME_ROLE}
    `.execute(db);
    expect(
      role.rows,
      `${RUNTIME_ROLE} missing — 0005 creates it whenever the migrating role has CREATEROLE (true for the local devresponse role and CI's service user)`,
    ).toHaveLength(1);
    expect(role.rows[0]!.rolcanlogin).toBe(false);

    // Explicit casts: has_table_privilege is overloaded (name|oid × text|oid)
    // and bound parameters arrive untyped.
    const priv = (table: string, p: string) =>
      sql<{ ok: boolean }>`
        select has_table_privilege(${RUNTIME_ROLE}::name, ${table}::text, ${p}::text) as ok
      `
        .execute(db)
        .then((r) => r.rows[0]!.ok);
    expect(await priv("app_audit_events", "INSERT")).toBe(true);
    expect(await priv("app_audit_events", "SELECT")).toBe(true);
    expect(await priv("app_audit_events", "UPDATE")).toBe(false);
    expect(await priv("app_audit_events", "DELETE")).toBe(false);
    expect(await priv("app_audit_events", "TRUNCATE")).toBe(false);
    expect(await priv("app_users", "DELETE")).toBe(true);
    expect(await priv("app_organizations", "UPDATE")).toBe(true);
    const fn = await sql<{ ok: boolean }>`
      select has_function_privilege(${RUNTIME_ROLE}::name, 'app_audit_events_prune(integer, integer)', 'execute') as ok
    `.execute(db);
    expect(fn.rows[0]!.ok).toBe(true);
  });
});
