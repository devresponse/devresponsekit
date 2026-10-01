import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { createAppPool, ensureSchema } from "../schema-config";
import {
  applyMigrationInTransaction,
  recordMigrationInTransaction,
  resolveMigrationTimeouts,
  RUNNER_SESSION_STATEMENTS,
} from "./apply-migration";
import {
  CONSOLIDATED_CORE_MIGRATIONS,
  migrationChecksum,
  planConsolidatedMigrations,
  planMigrations,
  reconcileLedgerChecksum,
  shouldIncludeLocales,
} from "./migration-plan";

/**
 * Lightweight migration runner.
 *
 * Applies SQL migrations in two ordered passes, skipping `better-auth*` files
 * (owned by Better Auth's own tooling) and tracking applied ids in an
 * `app_schema_migrations` table so each runs at most once:
 *
 *   1. CORE — every top-level `*.sql` (lexical). Two files today:
 *      `0001-initial-schema.sql`, the baseline (the `app_*` tables, indexes,
 *      triggers, and non-language baseline rows — but NOT email templates,
 *      which live under `locales/`), and `0002-release.sql`, the
 *      1.x/2.x changes that followed it (the former 0002…0008, consolidated
 *      on 2026-09-30; see below). Both are FROZEN and never renamed, so their
 *      ledger ids (the bare filenames) are stable and an existing database
 *      skips them. A new schema change is a new numbered file after them
 *      (`0003-*.sql`), applied in lexical order and recorded once.
 *
 *   2. LOCALES — `locales/*.sql` (lexical): the email templates, one file per
 *      locale. `0000-email-templates-en.sql` is the English BASE and is ALWAYS
 *      applied (the fallback every locale resolves to); the localized files
 *      (`0001-…`+) are included BY DEFAULT but skipped when `DB_MIGRATE_LOCALES`
 *      is `0`/`false`/`no`/`off` (an English-only install). Locale ids are
 *      ledgered as `locales/<file>`.
 *
 * Concurrency (review #85): the whole run holds
 * `pg_advisory_lock(hashtext('app_schema_migrations'))` on ONE dedicated
 * session — taken BEFORE the ledger is read, released in `finally` — so two
 * runners started together (a redeploy racing a manual `db:app:migrate`)
 * serialise instead of colliding on the ledger primary key or on the DDL
 * itself. This is the lock `provision.ts`, `schema-config.ts` and
 * `deploy.yml` describe. It is a SESSION lock, so it must live on a client
 * checked out for the run's lifetime — not on `pool.query`, which may hand
 * every statement a different connection.
 *
 * Integrity (review #86): the ledger also stores a sha256 `checksum` of each
 * applied file — of its NORMALISED content (`normalizeMigrationSql`: comments
 * stripped, whitespace collapsed, literals verbatim), so the deliberate
 * comment-only edits this repo makes to frozen files never trip it while any
 * functional edit does. On every run the hash of every already-applied file
 * is compared with the ledger; a mismatch aborts before anything is applied
 * (`reconcileLedgerChecksum`). Rows ledgered before the column existed are
 * backfilled with the current hash and logged. The column is added
 * idempotently in the bootstrap below — not as a numbered migration — because
 * the ledger must be readable before any numbered file is considered.
 *
 * Consolidation (MIG): a core file may replace several applied ones, as
 * `0002-release.sql` replaces 0002…0008. It is listed in
 * `CONSOLIDATED_CORE_MIGRATIONS` with the ids and pinned checksums of the
 * files it folds, and `planConsolidatedMigrations` decides, before anything is
 * written: ledgered under its own id → the usual path; absent but every folded
 * id ledgered under its pin (a database migrated before the consolidation) →
 * RECORD its ledger row and apply nothing, keeping the legacy rows; only some
 * of them ledgered → refuse, naming the commit to migrate from first; none →
 * apply it (a new database). To consolidate again later: concatenate the
 * files verbatim under the same `-- ===== BEGIN/END folded <id> =====`
 * banners into a new id, add it to `CONSOLIDATED_CORE_MIGRATIONS` with the
 * folded pins and the last commit that has the files, replace their ids in
 * `REQUIRED_CORE_MIGRATIONS` with it, and delete them. Fold only files every
 * live database has applied (one that has not is refused until it migrates
 * from that commit), and only SQL that is safe as ONE transaction, as the new
 * file is (no `create index concurrently`, no `alter type … add value`).
 *
 * Each not-yet-applied file runs inside its own transaction on the SAME
 * dedicated client (review #84: `begin`/`commit` on a pool would only be
 * atomic by accident of connection reuse) and is ledgered in that same
 * transaction — see `apply-migration.ts`, whose rollback path is proven in
 * `tests/db/migration-transaction.db.test.ts`. Each of those transactions
 * starts with `set local lock_timeout` / `statement_timeout` (F-94;
 * `DB_MIGRATE_LOCK_TIMEOUT_MS`, default 5 s, and
 * `DB_MIGRATE_STATEMENT_TIMEOUT_MS`, default 10 min), so a file whose DDL
 * waits on a lock fails and rolls back instead of queueing every query on that
 * table behind it. The advisory-lock wait above is outside those transactions
 * and unbounded: before taking the lock the runner clears `lock_timeout` and
 * `statement_timeout` for its session (`RUNNER_SESSION_STATEMENTS`), so a
 * role default cannot cancel it. The planning/ordering/checksum
 * logic lives in `migration-plan.ts` (pure + unit-tested); this module only
 * does the fs + db side effects.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCALES_DIR = path.join(__dirname, "locales");

/** Stable advisory-lock key shared by every runner instance (review #85). */
const MIGRATION_LOCK_SQL = "select pg_advisory_lock(hashtext('app_schema_migrations'))";
const MIGRATION_UNLOCK_SQL = "select pg_advisory_unlock(hashtext('app_schema_migrations'))";

/**
 * Bootstraps the ledger. Both statements are idempotent so the runner can
 * always execute them first, on any database age: the table for a fresh
 * database, the `checksum` column for one ledgered before review #86.
 */
async function ensureMigrationTable(client: PoolClient) {
  await client.query(`
    create table if not exists app_schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    );
  `);
  await client.query(`alter table app_schema_migrations add column if not exists checksum text`);
}

async function getApplied(client: PoolClient): Promise<Map<string, string | null>> {
  const { rows } = await client.query<{ id: string; checksum: string | null }>(
    `select id, checksum from app_schema_migrations`,
  );
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

/** Lists a directory, treating "does not exist" as empty. */
async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const includeLocales = shouldIncludeLocales(process.env.DB_MIGRATE_LOCALES);
  // Resolved before connecting, so a malformed value fails with nothing
  // touched (F-94).
  const timeouts = resolveMigrationTimeouts();
  const pool = createAppPool();
  // One dedicated session for the whole run: it owns the advisory lock and
  // every migration transaction (reviews #84, #85).
  const client = await pool.connect();
  // Migrations report operator steps via RAISE NOTICE (e.g. 0005's runtime
  // role split, review #83); `pg` drops notices unless something listens.
  client.on("notice", (notice) => {
    console.log(`[migrate] notice ${notice.message ?? ""}`);
  });
  let locked = false;

  try {
    // No inherited ceiling on this session (F-94): a role default such as
    // deployment.md §5's `statement_timeout = '30s'` would cancel the wait
    // below. Each file still sets its own, `set local`, in its transaction.
    for (const statement of RUNNER_SESSION_STATEMENTS) {
      await client.query(statement);
    }
    await client.query(MIGRATION_LOCK_SQL);
    locked = true;

    // The target schema must exist before the (unqualified) ledger and
    // schema DDL run, so they land in DB_SCHEMA rather than `public`.
    await ensureSchema(pool);
    await ensureMigrationTable(client);
    const applied = await getApplied(client);

    const coreEntries = await fs.readdir(__dirname);
    const localeEntries = await readDirSafe(LOCALES_DIR);
    const plan = planMigrations(coreEntries, localeEntries, includeLocales);

    console.log(
      `[migrate] each file runs with lock_timeout=${timeouts.lockTimeoutMs}ms statement_timeout=${timeouts.statementTimeoutMs}ms`,
    );
    if (!includeLocales) {
      console.log(
        "[migrate] locales EXCLUDED (DB_MIGRATE_LOCALES is off) — applying core migrations only",
      );
    }

    // Read + hash every planned file up front so a checksum mismatch on an
    // applied file aborts BEFORE any pending file is applied (review #86).
    const sources = new Map<string, { sql: string; checksum: string }>();
    for (const migration of plan) {
      const fullPath = migration.subdir
        ? path.join(__dirname, migration.subdir, migration.file)
        : path.join(__dirname, migration.file);
      const sql = await fs.readFile(fullPath, "utf8");
      sources.set(migration.id, { sql, checksum: migrationChecksum(sql) });
    }
    // MIG: decided before the backfill below writes anything, so a refusal
    // (some folded files applied, or one under another checksum) leaves the
    // ledger exactly as it was found.
    const consolidation = planConsolidatedMigrations(applied);
    for (const migration of plan) {
      if (!applied.has(migration.id)) continue;
      const stored = applied.get(migration.id) ?? null;
      const { checksum } = sources.get(migration.id)!;
      // Throws on a mismatch — nothing has been applied yet at this point.
      const verdict = reconcileLedgerChecksum(migration.id, stored, checksum);
      if (verdict === "backfill") {
        await client.query(`update app_schema_migrations set checksum = $2 where id = $1`, [
          migration.id,
          checksum,
        ]);
        console.log(`[migrate] backfilled checksum for ${migration.id} (${checksum})`);
      }
    }

    // MIG: a database migrated before a consolidation already holds the
    // consolidated file's schema under the folded ids. Its row is recorded,
    // nothing is applied (re-running 0002…0008 would repeat 0007's token
    // scrub and 0005's preflights), and the legacy rows stay.
    for (const step of consolidation) {
      if (step.action !== "record") continue;
      const { folds } = CONSOLIDATED_CORE_MIGRATIONS[step.id]!;
      for (const id of step.unverified) {
        console.log(
          `[migrate] warning: ${id} has no ledgered checksum (ledgered before review #86), so it ` +
            `was not compared with its section of ${step.id}`,
        );
      }
      const { checksum } = sources.get(step.id)!;
      await recordMigrationInTransaction(client, { id: step.id, checksum });
      applied.set(step.id, checksum);
      const range = `${folds[0]!.id.slice(0, 4)}…${folds.at(-1)!.id.slice(0, 4)}`;
      console.log(`[migrate] record ${step.id} (already applied as ${range})`);
    }

    for (const migration of plan) {
      if (applied.has(migration.id)) {
        console.log(`[migrate] skip   ${migration.id}`);
        continue;
      }
      const { sql, checksum } = sources.get(migration.id)!;
      console.log(`[migrate] apply  ${migration.id}`);
      await applyMigrationInTransaction(client, { id: migration.id, sql, checksum }, timeouts);
    }

    console.log("[migrate] done");
  } finally {
    // Release the advisory lock explicitly (the session end would drop it
    // too, but an explicit unlock keeps a pooled/proxied connection clean).
    if (locked) {
      await client.query(MIGRATION_UNLOCK_SQL).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[migrate] FAILED", error);
  process.exit(1);
});
