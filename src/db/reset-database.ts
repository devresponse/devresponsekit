import "dotenv/config";
import { spawnSync } from "node:child_process";
import { describeDatabaseTarget } from "./guards";
import { createAppPool, DB_SCHEMA } from "./schema-config";

/**
 * Destructive local-database reset (testing only).
 *
 * Drops EVERYTHING in the application schema (`DB_SCHEMA`, default `auth`) —
 * every table (the `app_*` tables, the Better Auth tables, and the
 * `app_schema_migrations` ledger), plus any sequences / types / functions —
 * and recreates an empty schema. The shared `public` schema is left intact
 * so the PostgreSQL extensions (pgcrypto, pg_trgm) survive. After this the
 * application schema is blank, so the full initial-setup path can be
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
 *   pnpm db:reset --yes      # actually drop + recreate the application schema
 *   pnpm db:reset:reload     # drop, then re-run auth + app migrations + seed
 *   pnpm db:reset --yes --force   # also allow a non-local host (careful!)
 *
 * `--reload` runs the rebuild steps IN-PROCESS (via spawnSync) rather than
 * relying on a shell `&&` chain in package.json — that chaining is not
 * portable across shells (PowerShell 5.1 has no `&&`, and pnpm's
 * script-shell differs by platform), which could leave the app tables
 * un-recreated. Driving the steps from Node guarantees the same ordered,
 * fail-fast behaviour everywhere.
 */

function parseArgs(argv: string[]): { yes: boolean; force: boolean; reload: boolean } {
  const args = new Set(argv.slice(2));
  return {
    yes: args.has("--yes") || args.has("-y"),
    force: args.has("--force") || args.has("-f"),
    reload: args.has("--reload"),
  };
}

/**
 * Runs the initial-setup steps in order, aborting on the first failure.
 * Each is spawned through the OS shell (cmd.exe on Windows, /bin/sh
 * elsewhere) as a SINGLE command — never a `&&` chain — so it works the
 * same regardless of the caller's shell.
 */
function runReloadSteps(): void {
  const steps: Array<{ label: string; command: string }> = [
    { label: "Better Auth migrations", command: "pnpm db:auth:migrate" },
    { label: "application schema (core + locale migrations)", command: "pnpm db:app:migrate" },
    { label: "local seed", command: "pnpm db:seed" },
  ];
  for (const { label, command } of steps) {
    console.log(`\n[db:reset] → ${label}  (${command})`);
    const result = spawnSync(command, { stdio: "inherit", shell: true });
    if (result.status !== 0) {
      console.error(
        `[db:reset] reload aborted — "${command}" exited with code ${result.status ?? "signal"}.`,
      );
      process.exit(result.status ?? 1);
    }
  }
  console.log("\n[db:reset] reload complete — schema + seed rebuilt from an empty database.");
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to reset the database.");
  }

  const { yes, force, reload } = parseArgs(process.argv);
  // Host classification is shared with the dev seed (src/db/guards.ts) so
  // both tools agree on what "local" means; an unparseable URL counts as
  // remote (fail closed).
  const { host, database, local } = describeDatabaseTarget(databaseUrl);

  console.log(`[db:reset] target  host=${host}  database=${database}`);

  if (!local && !force) {
    console.error(
      `[db:reset] REFUSING: host "${host}" is not local and --force was not given.\n` +
        `           This command DROPS EVERY TABLE in the "${DB_SCHEMA}" schema.\n` +
        `           If you really intend to reset a remote database, re-run with --force.`,
    );
    process.exitCode = 1;
    return;
  }

  const pool = createAppPool();
  try {
    const { rows } = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = $1 order by tablename`,
      [DB_SCHEMA],
    );

    if (rows.length === 0) {
      console.log(`[db:reset] the "${DB_SCHEMA}" schema already has no tables.`);
    } else {
      console.log(`[db:reset] ${rows.length} table(s) in "${DB_SCHEMA}":`);
      for (const r of rows) console.log(`             - ${r.tablename}`);
    }

    if (!yes) {
      console.log(
        "\n[db:reset] DRY RUN — nothing was changed.\n" +
          "           Re-run with --yes to DROP all of the above (and ALL their data).",
      );
      return;
    }

    console.log(`\n[db:reset] dropping and recreating schema "${DB_SCHEMA}" …`);
    // DB_SCHEMA is identifier-validated in schema-config.ts, so it is safe to
    // interpolate into this DDL. `public` is intentionally left untouched so
    // the shared extensions (pgcrypto, pg_trgm) survive the reset.
    await pool.query("begin");
    try {
      await pool.query(`drop schema if exists "${DB_SCHEMA}" cascade`);
      await pool.query(`create schema "${DB_SCHEMA}"`);
      // Grant to the migrating role so it can recreate objects (the role that
      // created the schema already owns it; this is defensive for split roles).
      const who = (await pool.query<{ u: string }>("select current_user as u")).rows[0]?.u;
      if (who)
        await pool.query(`grant all on schema "${DB_SCHEMA}" to "${who.replace(/"/g, '""')}"`);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }

    console.log("[db:reset] done — the database is empty.");
  } finally {
    await pool.end();
  }

  if (reload) {
    runReloadSteps();
  } else {
    console.log(
      "           Reload the initial setup with:\n" +
        "             pnpm db:reset:reload\n" +
        "           (or manually: pnpm db:auth:migrate, then db:app:migrate, then db:seed)",
    );
  }
}

main().catch((error) => {
  console.error("[db:reset] FAILED", error);
  process.exit(1);
});
