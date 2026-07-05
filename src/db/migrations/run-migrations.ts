import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { createAppPool, ensureSchema } from "../schema-config";
import { planMigrations, shouldIncludeLocales } from "./migration-plan";

/**
 * Lightweight migration runner.
 *
 * Applies SQL migrations in two ordered passes, skipping `better-auth*` files
 * (owned by Better Auth's own tooling) and tracking applied ids in an
 * `app_schema_migrations` table so each runs at most once:
 *
 *   1. CORE — every top-level `*.sql` (lexical). Today that is the SINGLE
 *      `0001-initial-schema.sql`: the consolidated baseline (every `app_*`
 *      table, index, trigger, and non-language baseline row — but NOT email
 *      templates, which live under `locales/`). The former standalone forward
 *      migrations 0002–0005 / 0007 / 0008 were folded back into it, in order,
 *      to keep the core setup one file / one transaction. Core is FROZEN and
 *      never renamed, so its ledger id (the bare filename) is stable and an
 *      existing database skips it. New core migrations continue MONOTONICALLY
 *      as new `NNNN-*.sql` files; the next is `0010-…`. Numbers are never
 *      reused — 0002–0009 have all been used (0006/0009 were the retired
 *      email-template migrations; the rest are folded into 0001).
 *
 *   2. LOCALES — `locales/*.sql` (lexical): the email templates, one file per
 *      locale. `0000-email-templates-en.sql` is the English BASE and is ALWAYS
 *      applied (the fallback every locale resolves to); the localized files
 *      (`0001-…`+) are included BY DEFAULT but skipped when `DB_MIGRATE_LOCALES`
 *      is `0`/`false`/`no`/`off` (an English-only install). Locale ids are
 *      ledgered as `locales/<file>`.
 *
 * Each not-yet-applied file runs inside its own transaction and is ledgered on
 * success. The planning/ordering logic lives in `migration-plan.ts` (pure +
 * unit-tested); this module only does the fs + db side effects.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCALES_DIR = path.join(__dirname, "locales");

async function ensureMigrationTable(pool: Pool) {
  await pool.query(`
    create table if not exists app_schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

async function getApplied(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>(`select id from app_schema_migrations`);
  return new Set(rows.map((row) => row.id));
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

  try {
    // The target schema must exist before the (unqualified) ledger and
    // schema DDL run, so they land in DB_SCHEMA rather than `public`.
    await ensureSchema(pool);
    await ensureMigrationTable(pool);
    const applied = await getApplied(pool);

    const coreEntries = await fs.readdir(__dirname);
    const localeEntries = await readDirSafe(LOCALES_DIR);
    const plan = planMigrations(coreEntries, localeEntries, includeLocales);

    if (!includeLocales) {
      console.log(
        "[migrate] locales EXCLUDED (DB_MIGRATE_LOCALES is off) — applying core migrations only",
      );
    }

    for (const migration of plan) {
      if (applied.has(migration.id)) {
        console.log(`[migrate] skip   ${migration.id}`);
        continue;
      }
      const fullPath = migration.subdir
        ? path.join(__dirname, migration.subdir, migration.file)
        : path.join(__dirname, migration.file);
      const sql = await fs.readFile(fullPath, "utf8");
      console.log(`[migrate] apply  ${migration.id}`);
      await pool.query("begin");
      try {
        await pool.query(sql);
        await pool.query("insert into app_schema_migrations (id) values ($1)", [migration.id]);
        await pool.query("commit");
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }

    console.log("[migrate] done");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[migrate] FAILED", error);
  process.exit(1);
});
