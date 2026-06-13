import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

/**
 * Lightweight migration runner.
 *
 * Applies every `*.sql` file inside this directory in lexical order,
 * skipping `better-auth*` files (which are owned by Better Auth's own
 * migration tooling). Tracks applied filenames in an
 * `app_schema_migrations` table so each file runs at most once.
 *
 * The schema baseline is `0001-initial-schema.sql` (every core `app_*`
 * table, index, and baseline row for a first-time setup). Additive
 * changes ship as further numbered files — currently
 * `0003-api-credentials.sql` (API keys, OAuth clients, JWT revocation
 * list). The runner applies all `NNNN-*.sql` files in lexical order;
 * numbering gaps (there is no `0002` on disk) are tolerated.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await ensureMigrationTable(pool);
    const applied = await getApplied(pool);

    const entries = await fs.readdir(__dirname);
    const migrations = entries
      .filter((name) => name.endsWith(".sql"))
      .filter((name) => !name.startsWith("better-auth"))
      .sort();

    for (const file of migrations) {
      if (applied.has(file)) {
        console.log(`[migrate] skip   ${file}`);
        continue;
      }
      const fullPath = path.join(__dirname, file);
      const sql = await fs.readFile(fullPath, "utf8");
      console.log(`[migrate] apply  ${file}`);
      await pool.query("begin");
      try {
        await pool.query(sql);
        await pool.query("insert into app_schema_migrations (id) values ($1)", [file]);
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
