import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { resolveDatabaseUrl } from "@/db/schema-config";

/**
 * Better Auth schema generator (B4).
 *
 * Emits the REAL Better Auth identity DDL (the user/session/account/
 * verification tables plus any plugin-added columns) to a committed SQL
 * snapshot — `better-auth-schema.sql` — so the vendor schema applied at deploy
 * has a reviewable diff in version control, and the `auth-schema-drift` CI job
 * can fail when a Better Auth upgrade silently changes it (which is also the
 * cue to revisit the hand-typed Kysely mirrors in `db/schema/app-schema.ts`).
 *
 * Determinism: `compileMigrations()` returns the SQL for the schema MISSING
 * from the connected database, so we point it at a throwaway, freshly-EMPTY
 * schema. That makes the output the FULL create-table set every time,
 * independent of whatever the real `DB_SCHEMA` already contains — which is what
 * lets the drift check compare byte-for-byte.
 */
const SNAPSHOT_SCHEMA = "ba_schema_snapshot";

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outFile = path.join(__dirname, "better-auth-schema.sql");

  const pool = new Pool({
    connectionString: resolveDatabaseUrl(),
    options: `-c search_path="${SNAPSHOT_SCHEMA}",public`,
  });

  const { pgPool } = await import("@/db/database");
  try {
    // A fresh, empty schema makes compileMigrations() emit the complete DDL.
    await pool.query(`drop schema if exists "${SNAPSHOT_SCHEMA}" cascade`);
    await pool.query(`create schema "${SNAPSHOT_SCHEMA}"`);

    const { auth } = await import("@/lib/auth");
    const { compileMigrations } = await getMigrations({
      ...auth.options,
      database: pool,
    } as Parameters<typeof getMigrations>[0]);

    const ddl = (await compileMigrations()).trim();
    const header = [
      "-- Better Auth identity schema — GENERATED, DO NOT EDIT BY HAND.",
      "-- Regenerate with `pnpm db:auth:generate`; the `auth-schema-drift` CI job",
      "-- fails if this snapshot is stale (e.g. after a better-auth upgrade) — that",
      "-- is also the signal to re-check the hand-typed mirrors in app-schema.ts.",
      "-- Applied at deploy by `pnpm db:auth:migrate` (Better Auth's own migrator).",
      "",
      "",
    ].join("\n");
    await fs.writeFile(outFile, header + (ddl ? `${ddl}\n` : ""), "utf8");
    console.log(`[auth:generate] wrote ${outFile} (${ddl.length} bytes of DDL)`);
  } finally {
    await pool.query(`drop schema if exists "${SNAPSHOT_SCHEMA}" cascade`).catch(() => {});
    await pool.end();
    await pgPool.end();
  }
}

main().catch((error) => {
  console.error("[auth:generate] FAILED", error);
  process.exit(1);
});
