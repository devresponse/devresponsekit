import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgPool } from "@/db/database";
import {
  coreMigrationSql,
  coreMigrationsBefore,
  readMigrationFile,
} from "../helpers/core-migrations";

/**
 * DB-BACKED proof of migration 0007-uniqueness-search-indexes-token-scrub.sql
 * (F-97, M-02, F-93, F-150), built in a SCRATCH SCHEMA on a dedicated
 * connection the way migration-0005-preflight.db.test.ts does: every core
 * migration that came before 0007 is applied there first, plus Better Auth's
 * generated `user` and `account` tables, then 0007 runs in a transaction
 * exactly as the runner applied it. MIG: 0007 and its predecessors after 0001
 * are sections of 0002-release.sql, read out of it by
 * tests/helpers/core-migrations.ts, byte for byte the SQL production ledgered.
 *
 *   1. PREFLIGHT: with a duplicated global role key and a second default
 *      organization it refuses, names both, and changes nothing (no index, the
 *      stored provider tokens still there).
 *   2. Once the data is fixed it applies; its two unique indexes then refuse a
 *      duplicate global key and a second default (org-scoped keys are not
 *      affected); the scrub clears every provider token and keeps a credential
 *      password; it skips with a notice when Better Auth's `account` table is
 *      absent; a re-run is a no-op.
 *   3. F-93: before 0007 neither search OR can be served by indexes (one arm
 *      has none); after it, both are a BitmapOr over one trigram index per
 *      arm. Sequential and plain index scans are switched off for the EXPLAIN
 *      so the plan shows what the indexes CAN serve, not what an empty table
 *      makes cheapest.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */
const SCHEMA = "__dbtest_m0007";
const RUNTIME_ROLE = `${SCHEMA}_runtime`;
const MIGRATION = "0007-uniqueness-search-indexes-token-scrub.sql";
const MIGRATION_SQL = coreMigrationSql(MIGRATION);
/** The core migrations the scratch schema needs first: 0001, then 0002…0006. */
const BASELINE = coreMigrationsBefore(MIGRATION);
const NEW_INDEXES = [
  "idx_app_roles_global_key",
  "idx_app_organizations_single_default",
  "idx_app_audit_events_event_type_trgm",
  "idx_app_outbox_template_key_trgm",
];

let client: PoolClient;
const notices: string[] = [];

async function applyInTransaction(sql: string): Promise<void> {
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function indexesPresent(): Promise<string[]> {
  const { rows } = await client.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = $1 and indexname = any($2) order by 1`,
    [SCHEMA, NEW_INDEXES],
  );
  return rows.map((r) => r.indexname);
}

async function tokensOf(id: string) {
  const { rows } = await client.query(
    `select "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt",
            "refreshTokenExpiresAt", password, scope
       from "account" where id = $1`,
    [id],
  );
  return rows[0];
}

/** The SQL error Postgres raises for `text`, or null when it succeeds. */
async function errorOf(text: string): Promise<{ code?: string; constraint?: string } | null> {
  try {
    await client.query(text);
    return null;
  } catch (err) {
    return err as { code?: string; constraint?: string };
  }
}

/** Plan node types and index names of `query`, with only bitmap scans allowed on indexes. */
async function planOf(query: string): Promise<{ nodes: string[]; indexes: string[] }> {
  await client.query("begin");
  try {
    await client.query("set local enable_seqscan = off");
    await client.query("set local enable_indexscan = off");
    await client.query("set local enable_indexonlyscan = off");
    const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
      `explain (format json) ${query}`,
    );
    const nodes: string[] = [];
    const indexes: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(String(node["Node Type"]));
      if (node["Index Name"]) indexes.push(String(node["Index Name"]));
      for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk((rows[0]!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
    return { nodes, indexes: indexes.sort() };
  } finally {
    await client.query("rollback");
  }
}

/** The audit explorer's and the audit export's `q` predicate (audit/route.ts). */
const AUDIT_SEARCH = `select id from app_audit_events e
  where e.event_type ilike '%token%' or e.email ilike '%token%' or e.reason ilike '%token%'`;
/** The outbox grid's `q` predicate (email/outbox/route.ts). */
const OUTBOX_SEARCH = `select id from app_outbox o
  where o.to_email ilike '%verify%' or o.subject ilike '%verify%' or o.template_key ilike '%verify%'`;

beforeAll(async () => {
  client = await pgPool.connect();
  client.on("notice", (notice) => notices.push(notice.message ?? ""));
  await client.query(`drop schema if exists "${SCHEMA}" cascade`);
  await client.query(`create schema "${SCHEMA}"`);
  await client.query(`set search_path to "${SCHEMA}", public`);
  expect(BASELINE[0]!.id).toBe("0001-initial-schema.sql");
  expect(BASELINE.map((m) => m.id)).toContain("0006-rate-limit-buckets.sql");
  for (const migration of BASELINE) {
    await applyInTransaction(migration.sql);
  }
  // Better Auth's own tables, from the generated snapshot `db:auth:migrate` applies.
  const authSchema = readMigrationFile("better-auth-schema.sql");
  for (const table of ["user", "account"]) {
    const ddl = authSchema.match(new RegExp(`^create table "${table}" .*;$`, "m"));
    expect(ddl, `better-auth-schema.sql has no "${table}" table`).toBeTruthy();
    await client.query(ddl![0]);
  }
  await client.query(`
    insert into "user" (id, name, email, "emailVerified") values ('u1', 'U', 'u@example.test', true);
    insert into "account" (id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
        "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, "updatedAt")
      values ('gh', '42', 'github', 'u1', 'gho_live', 'ghr_live', null,
        now() + interval '8 hours', now() + interval '180 days', 'read:user', now()),
             ('ms', 'oid', 'microsoft', 'u1', 'eyJ.access', 'refresh', 'eyJ.id',
        now() + interval '1 hour', null, 'openid', now()),
             ('pw', 'u1', 'credential', 'u1', null, null, null, null, null, null, now());
    update "account" set password = 'hash' where id = 'pw';
  `);
});

afterAll(async () => {
  try {
    await client.query(`drop schema if exists "${SCHEMA}" cascade`);
    const { rows } = await client.query(`select 1 from pg_roles where rolname = $1`, [
      RUNTIME_ROLE,
    ]);
    if (rows.length > 0) {
      await client.query(`drop owned by "${RUNTIME_ROLE}"`);
      await client.query(`drop role "${RUNTIME_ROLE}"`);
    }
  } finally {
    client.release();
    await pgPool.end();
  }
});

describe("0007 (scratch schema)", () => {
  it("F-93: before 0007 neither search OR can be served by indexes alone", async () => {
    for (const query of [AUDIT_SEARCH, OUTBOX_SEARCH]) {
      const plan = await planOf(query);
      expect(plan.nodes).not.toContain("BitmapOr");
      expect(plan.nodes).toContain("Seq Scan");
    }
  });

  it("PREFLIGHT refuses a duplicated global role key and a second default, and changes nothing", async () => {
    await client.query(`
      insert into app_roles (organization_id, key, name)
        values (null, 'dup-key', 'Kept'), (null, 'dup-key', 'Extra');
      insert into app_organizations (slug, name, is_default) values ('second-default', 'Second', true);
    `);

    let message = "";
    try {
      await applyInTransaction(MIGRATION_SQL);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\[0007\] refusing to apply: 2 row group\(s\)/);
    expect(message).toContain("app_roles.key (global) = 'dup-key' (2 rows)");
    // Oldest first: the default sign-ups resolve to is named first.
    expect(message).toMatch(
      /app_organizations\.is_default = 'default [0-9a-f-]{36}, second-default [0-9a-f-]{36}' \(2 rows\)/,
    );

    expect(await indexesPresent()).toEqual([]);
    expect(await tokensOf("gh")).toMatchObject({
      accessToken: "gho_live",
      refreshToken: "ghr_live",
    });
  });

  it("applies once the data is fixed, enforces both unique indexes, scrubs the tokens and re-runs as a no-op", async () => {
    await client.query(`
      delete from app_roles where key = 'dup-key' and name = 'Extra';
      update app_organizations set is_default = false where slug = 'second-default';
    `);

    // Without Better Auth's table the scrub is skipped with a notice, not an error.
    await client.query(`alter table "account" rename to account_parked`);
    notices.length = 0;
    await applyInTransaction(MIGRATION_SQL);
    expect(notices.join("\n")).toContain('Better Auth "account" table not found');
    expect(await indexesPresent()).toEqual([...NEW_INDEXES].sort());

    // With it, a re-run clears every stored provider token (and only those).
    await client.query(`alter table account_parked rename to "account"`);
    notices.length = 0;
    await applyInTransaction(MIGRATION_SQL);
    expect(notices.join("\n")).toContain("cleared stored provider tokens on 2 account row(s)");
    for (const id of ["gh", "ms"]) {
      expect(await tokensOf(id)).toMatchObject({
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
      });
    }
    expect(await tokensOf("gh")).toMatchObject({ scope: "read:user" });
    expect(await tokensOf("pw")).toMatchObject({ password: "hash" });

    // F-97: one global role per key; org-scoped keys are unaffected.
    expect(
      await errorOf(
        `insert into app_roles (organization_id, key, name) values (null, 'dup-key', 'Again')`,
      ),
    ).toMatchObject({ code: "23505", constraint: "idx_app_roles_global_key" });
    expect(
      await errorOf(
        `insert into app_roles (organization_id, key, name)
         select id, 'dup-key', 'Org copy' from app_organizations where slug = 'second-default'`,
      ),
    ).toBeNull();

    // M-02: at most one default, whoever writes it; moving it clear-then-set works.
    expect(
      await errorOf(`update app_organizations set is_default = true where slug = 'second-default'`),
    ).toMatchObject({ code: "23505", constraint: "idx_app_organizations_single_default" });
    await applyInTransaction(`
      update app_organizations set is_default = false where is_default;
      update app_organizations set is_default = true where slug = 'second-default';
    `);
    const { rows: defaults } = await client.query<{ slug: string }>(
      `select slug from app_organizations where is_default`,
    );
    expect(defaults).toEqual([{ slug: "second-default" }]);

    // Idempotent: a third run changes nothing and raises nothing.
    notices.length = 0;
    await applyInTransaction(MIGRATION_SQL);
    expect(notices.join("\n")).toContain("cleared stored provider tokens on 0 account row(s)");
  });

  it("F-93: after 0007 both search ORs are a BitmapOr over one trigram index per arm", async () => {
    const audit = await planOf(AUDIT_SEARCH);
    expect(audit.nodes).toContain("BitmapOr");
    expect(audit.nodes).not.toContain("Seq Scan");
    expect(audit.indexes).toEqual([
      "idx_app_audit_events_email_trgm",
      "idx_app_audit_events_event_type_trgm",
      "idx_app_audit_events_reason_trgm",
    ]);

    const outbox = await planOf(OUTBOX_SEARCH);
    expect(outbox.nodes).toContain("BitmapOr");
    expect(outbox.nodes).not.toContain("Seq Scan");
    expect(outbox.indexes).toEqual([
      "idx_app_outbox_subject_trgm",
      "idx_app_outbox_template_key_trgm",
      "idx_app_outbox_to_email_trgm",
    ]);
  });
});
