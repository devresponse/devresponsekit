import "dotenv/config";
import { Pool } from "pg";

/**
 * Destructive local-database reset (testing only).
 *
 * Drops EVERYTHING in the `public` schema — every table (the `app_*`
 * tables, the Better Auth tables, and the `app_schema_migrations` ledger),
 * plus any sequences / types / functions — and recreates an empty schema.
 * After this the database is blank, so the full initial-setup path can be
 * exercised from scratch:
 *
 *   pnpm db:auth:migrate && pnpm db:app:migrate && pnpm db:seed
 *
 * (or the convenience one-shot `pnpm db:reset:reload`).
 *
 * Safety rails — this command is irreversible:
 *   - It refuses to run against a non-local host unless `--force` is given,
 *     so a misconfigured DATABASE_URL cannot wipe a shared/remote database.
 *   - It does NOTHING without an explicit `--yes` (a dry run lists the
 *     tables it WOULD drop and exits).
 *
 * Usage:
 *   pnpm db:reset            # dry run — lists tables, changes nothing
 *   pnpm db:reset --yes      # actually drop + recreate the public schema
 *   pnpm db:reset --yes --force   # also allow a non-local host (careful!)
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

function parseArgs(argv: string[]): { yes: boolean; force: boolean } {
  const args = new Set(argv.slice(2));
  return {
    yes: args.has("--yes") || args.has("-y"),
    force: args.has("--force") || args.has("-f"),
  };
}

function describeTarget(url: string): { host: string; database: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "?" };
  } catch {
    return { host: "?", database: "?" };
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to reset the database.");
  }

  const { yes, force } = parseArgs(process.argv);
  const { host, database } = describeTarget(databaseUrl);

  console.log(`[db:reset] target  host=${host}  database=${database}`);

  if (!LOCAL_HOSTS.has(host) && !force) {
    console.error(
      `[db:reset] REFUSING: host "${host}" is not local and --force was not given.\n` +
        `           This command DROPS EVERY TABLE in the public schema.\n` +
        `           If you really intend to reset a remote database, re-run with --force.`,
    );
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );

    if (rows.length === 0) {
      console.log("[db:reset] the public schema already has no tables.");
    } else {
      console.log(`[db:reset] ${rows.length} table(s) in public:`);
      for (const r of rows) console.log(`             - ${r.tablename}`);
    }

    if (!yes) {
      console.log(
        "\n[db:reset] DRY RUN — nothing was changed.\n" +
          "           Re-run with --yes to DROP all of the above (and ALL their data).",
      );
      return;
    }

    console.log('\n[db:reset] dropping and recreating schema "public" …');
    await pool.query("begin");
    try {
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      // Restore the grants Postgres normally puts on a fresh public schema
      // so the migrator and app role can recreate objects.
      const who = (await pool.query<{ u: string }>("select current_user as u")).rows[0]?.u;
      if (who) await pool.query(`grant all on schema public to "${who.replace(/"/g, '""')}"`);
      await pool.query("grant all on schema public to public");
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }

    console.log(
      "[db:reset] done — the database is empty.\n" +
        "           Reload the initial setup with:\n" +
        "             pnpm db:auth:migrate && pnpm db:app:migrate && pnpm db:seed\n" +
        "           (or in one step: pnpm db:reset:reload)",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[db:reset] FAILED", error);
  process.exit(1);
});
