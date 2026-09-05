import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { createAppPool, ensureSchema } from "../schema-config";
import {
  migrationChecksum,
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
 *   1. CORE — every top-level `*.sql` (lexical). `0001-initial-schema.sql` is
 *      the complete baseline (every `app_*` table, index, trigger, and
 *      non-language baseline row — but NOT email templates, which live under
 *      `locales/`). It is FROZEN and never renamed, so its ledger id (the
 *      bare filename) is stable and an existing database skips it. Further
 *      schema changes are the numbered `NNNN-*.sql` files after it, applied
 *      in lexical order, each recorded once in the ledger.
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
 * Each not-yet-applied file runs inside its own transaction on the SAME
 * dedicated client (review #84: `begin`/`commit` on a pool would only be
 * atomic by accident of connection reuse) and is ledgered on success. The
 * planning/ordering/checksum logic lives in `migration-plan.ts` (pure +
 * unit-tested); this module only does the fs + db side effects.
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

    for (const migration of plan) {
      if (applied.has(migration.id)) {
        console.log(`[migrate] skip   ${migration.id}`);
        continue;
      }
      const { sql, checksum } = sources.get(migration.id)!;
      console.log(`[migrate] apply  ${migration.id}`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into app_schema_migrations (id, checksum) values ($1, $2)`, [
          migration.id,
          checksum,
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
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
