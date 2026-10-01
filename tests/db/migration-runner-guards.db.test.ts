import { spawn } from "node:child_process";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "@/db/schema-config";

/**
 * DB-BACKED proof of the migration runners' refusals (DEP2), through the
 * runners themselves, spawned as `pnpm db:app:migrate` / `pnpm db:auth:migrate`
 * would run them, each against a scratch schema of its own:
 *
 *   a. A pooled or re-pointed DATABASE_URL exits 1 before connecting: a
 *      `-pooler` host is refused by name, and the reachable test database
 *      marked `pgbouncer=true` or re-pointed with `?port=` is never touched
 *      (its scratch schema is not even created).
 *   b. With DB_SEARCH_PATH_VIA_OPTIONS=0 the session resolves to `public`, not
 *      the fresh scratch schema: exit 1, and nothing lands in `public` (no
 *      `public.app_schema_migrations`, no new table at all).
 *   c. A scratch schema whose ledger another role owns: exit 1, naming both
 *      roles, and nothing is created or ledgered.
 *   d. The migration lock held by this test's session and
 *      DB_MIGRATE_LOCK_WAIT_MS=1500: the application runner exits 1 within
 *      10 s, having created nothing (it waits before `ensureSchema`).
 *   e. The same for the Better Auth runner, which now takes that lock.
 *   f. A bounded wait still takes the lock once it is released: the Better
 *      Auth runner migrates its scratch schema and exits 0.
 *
 * The existing migration suites (deploy-gate, migration-transaction) stay
 * green: they migrate as the superuser that owns their scratch objects.
 * Driven by `pnpm test:db` (vitest.db.config.ts).
 */

const PREFIX = "__dbtest_runner_guards";
const OTHER_ROLE = `${PREFIX}_other`;
const APP_RUNNER = "src/db/migrations/run-migrations.ts";
const AUTH_RUNNER = "src/db/migrations/run-better-auth-migrate.ts";
const RUNNERS = [
  ["db:app:migrate", APP_RUNNER, "[migrate] FAILED"],
  ["db:auth:migrate", AUTH_RUNNER, "[auth:migrate] FAILED"],
] as const;

const DATABASE_URL = resolveDatabaseUrl()!;
/** No search_path option: scratch DDL is qualified. */
let admin: Pool;

interface Ran {
  code: number | null;
  output: string;
  ms: number;
}

/** Runs a runner with tsx, as its pnpm script does, over this process's env plus `extra`. */
function runRunner(script: string, extra: Record<string, string>): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      env: { ...process.env, ...extra } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

/** The test database's URL with its query extended (the original keeps sslmode etc.). */
function withQuery(extra: string): string {
  const url = new URL(DATABASE_URL);
  for (const [key, value] of new URLSearchParams(extra)) url.searchParams.append(key, value);
  return url.toString();
}

async function schemaExists(schema: string): Promise<boolean> {
  const { rows } = await admin.query("select 1 from pg_namespace where nspname = $1", [schema]);
  return rows.length > 0;
}

async function tablesIn(schema: string): Promise<string[]> {
  const { rows } = await admin.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = $1 order by tablename",
    [schema],
  );
  return rows.map((row) => row.tablename);
}

async function dropScratch(): Promise<void> {
  const { rows } = await admin.query<{ nspname: string }>(
    "select nspname from pg_namespace where nspname like $1",
    [`${PREFIX}%`],
  );
  for (const { nspname } of rows) await admin.query(`drop schema if exists "${nspname}" cascade`);
  const role = await admin.query("select 1 from pg_roles where rolname = $1", [OTHER_ROLE]);
  if (role.rows.length > 0) {
    await admin.query(`drop owned by "${OTHER_ROLE}"`);
    await admin.query(`drop role if exists "${OTHER_ROLE}"`);
  }
}

/** Holds the runners' advisory lock on a session of its own for `body`. */
async function holdingTheLock<T>(body: (release: () => Promise<void>) => Promise<T>): Promise<T> {
  const holder = new Client({ connectionString: DATABASE_URL });
  await holder.connect();
  let held = true;
  const release = async () => {
    if (!held) return;
    held = false;
    await holder.query("select pg_advisory_unlock(hashtext('app_schema_migrations'))");
  };
  try {
    await holder.query("select pg_advisory_lock(hashtext('app_schema_migrations'))");
    return await body(release);
  } finally {
    await release().catch(() => undefined);
    await holder.end();
  }
}

beforeAll(async () => {
  admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
  await dropScratch();
});

afterAll(async () => {
  try {
    await dropScratch();
  } finally {
    await admin.end();
  }
});

describe("the migration runners' refusals against a live database (DEP2)", () => {
  it.each(RUNNERS)(
    "(a) %s refuses a pooled or re-pointed URL before connecting",
    async (_label, script, failed) => {
      const schema = `${PREFIX}_a`;
      const neonPooled = "postgresql://owner:p4ss-SECRET-zz@ep-x-pooler.example.invalid:5432/app";
      const cases: Array<[string, RegExp]> = [
        [neonPooled, /DATABASE_URL looks pooled: its host carries Neon's `-pooler` suffix\./],
        [withQuery("pgbouncer=true"), /DATABASE_URL looks pooled: it carries `pgbouncer=true`\./],
        [withQuery("port=5432"), /re-points the connection with `port` in its query/],
      ];
      for (const [url, reason] of cases) {
        const ran = await runRunner(script, { DATABASE_URL: url, DB_SCHEMA: schema });
        expect(ran.code, ran.output).toBe(1);
        expect(ran.output).toContain(failed);
        expect(ran.output).toMatch(reason);
        expect(ran.output).toContain("Nothing was attempted.");
        // Nothing was attempted: no lookup of the unresolvable host, and the
        // reachable database never saw ensureSchema.
        expect(ran.output).not.toMatch(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|getaddrinfo/);
        expect(ran.output).not.toContain("p4ss-SECRET-zz");
        expect(ran.output).not.toContain(url);
        expect(await schemaExists(schema)).toBe(false);
      }
    },
    60_000,
  );

  it.each(RUNNERS)(
    "(b) %s refuses a session whose search_path is not DB_SCHEMA, creating nothing in public",
    async (_label, script, failed) => {
      const schema = `${PREFIX}_b`;
      const before = await tablesIn("public");
      expect(before).not.toContain("app_schema_migrations");

      const ran = await runRunner(script, { DB_SCHEMA: schema, DB_SEARCH_PATH_VIA_OPTIONS: "0" });

      expect(ran.code, ran.output).toBe(1);
      expect(ran.output).toContain(failed);
      expect(ran.output).toMatch(
        new RegExp(
          `the session's search_path resolves to (?:\\w+|no existing schema), not DB_SCHEMA ${schema} \\(DB_SEARCH_PATH_VIA_OPTIONS is off, or a role default points elsewhere\\); nothing was created there\\.`,
        ),
      );
      const { rows } = await admin.query<{ ledger: string | null }>(
        "select to_regclass('public.app_schema_migrations')::text as ledger",
      );
      expect(rows[0]!.ledger).toBeNull();
      expect(await tablesIn("public")).toEqual(before);
      // ensureSchema ran (qualified, so harmless); nothing was created inside.
      expect(await tablesIn(schema)).toEqual([]);
      await admin.query(`drop schema if exists "${schema}" cascade`);
    },
    60_000,
  );

  it.each(RUNNERS)(
    "(c) %s refuses to migrate a schema whose ledger another role owns",
    async (_label, script, failed) => {
      const schema = `${PREFIX}_c`;
      const { rows: me } = await admin.query<{ login: string }>("select current_user as login");
      const login = me[0]!.login;
      await admin.query(`create schema "${schema}"`);
      // A pre-#86 ledger, with no checksum column: the app runner's bootstrap
      // would add one, and as the superuser this suite connects as it could.
      await admin.query(
        `create table "${schema}".app_schema_migrations (id text primary key, applied_at timestamptz not null default now())`,
      );
      const exists = await admin.query("select 1 from pg_roles where rolname = $1", [OTHER_ROLE]);
      if (exists.rows.length === 0) await admin.query(`create role "${OTHER_ROLE}" nologin`);
      await admin.query(`alter table "${schema}".app_schema_migrations owner to "${OTHER_ROLE}"`);
      try {
        const ran = await runRunner(script, { DB_SCHEMA: schema });

        expect(ran.code, ran.output).toBe(1);
        expect(ran.output).toContain(failed);
        expect(ran.output).toContain(
          `${schema}.app_schema_migrations is owned by ${OTHER_ROLE}, but this session migrates as ${login}`,
        );
        expect(ran.output).toContain(`Migrate as ${OTHER_ROLE}; nothing was changed.`);
        // Nothing created, nothing ledgered, and the ledger not even altered.
        expect(await tablesIn(schema)).toEqual(["app_schema_migrations"]);
        const ledger = await admin.query(
          `select count(*)::int as n from "${schema}".app_schema_migrations`,
        );
        expect(ledger.rows[0]!.n).toBe(0);
        const checksum = await admin.query(
          "select 1 from information_schema.columns where table_schema = $1 and table_name = 'app_schema_migrations' and column_name = 'checksum'",
          [schema],
        );
        expect(checksum.rows).toHaveLength(0);
      } finally {
        await admin.query(`drop schema if exists "${schema}" cascade`);
      }
    },
    60_000,
  );

  it("(d) db:app:migrate gives up within 10 s when another session holds the lock past DB_MIGRATE_LOCK_WAIT_MS", async () => {
    const schema = `${PREFIX}_d`;
    const ran = await holdingTheLock(() =>
      runRunner(APP_RUNNER, { DB_SCHEMA: schema, DB_MIGRATE_LOCK_WAIT_MS: "1500" }),
    );

    expect(ran.code, ran.output).toBe(1);
    expect(ran.output).toContain("[migrate] FAILED");
    expect(ran.output).toContain(
      "another session holds the migration lock: gave up after DB_MIGRATE_LOCK_WAIT_MS=1500ms and applied nothing.",
    );
    expect(ran.ms).toBeLessThan(10_000);
    // The application runner waits before ensureSchema: nothing exists.
    expect(await schemaExists(schema)).toBe(false);
  }, 30_000);

  it("(e) db:auth:migrate takes the same lock, and gives up the same way", async () => {
    const schema = `${PREFIX}_e`;
    const ran = await holdingTheLock(() =>
      runRunner(AUTH_RUNNER, { DB_SCHEMA: schema, DB_MIGRATE_LOCK_WAIT_MS: "1500" }),
    );

    expect(ran.code, ran.output).toBe(1);
    expect(ran.output).toContain("[auth:migrate] FAILED");
    expect(ran.output).toContain(
      "another session holds the migration lock: gave up after DB_MIGRATE_LOCK_WAIT_MS=1500ms and applied nothing.",
    );
    expect(ran.ms).toBeLessThan(10_000);
    // It creates the schema first (before importing @/lib/auth), and
    // nothing in it: Better Auth never planned.
    expect(await tablesIn(schema)).toEqual([]);
    await admin.query(`drop schema if exists "${schema}" cascade`);
  }, 30_000);

  it("(f) a bounded wait takes the lock once it is released, and the run completes", async () => {
    const schema = `${PREFIX}_f`;
    const ran = await holdingTheLock(async (release) => {
      const running = runRunner(AUTH_RUNNER, {
        DB_SCHEMA: schema,
        DB_MIGRATE_LOCK_WAIT_MS: "30000",
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await release();
      return running;
    });

    expect(ran.code, ran.output).toBe(0);
    expect(ran.output).toContain("[auth:migrate] done");
    expect(await tablesIn(schema)).toEqual(
      expect.arrayContaining(["account", "session", "user", "verification"]),
    );
    await admin.query(`drop schema if exists "${schema}" cascade`);
  }, 60_000);
});
