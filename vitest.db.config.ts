import "dotenv/config";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
// With the extension, because Vite's planned native config loader resolves
// imports as Node does and warns about an extensionless one on every run
// (tsconfig's allowImportingTsExtensions lets tsc accept it).
import { resolveDbTestTarget } from "./src/db/guards.ts";

/**
 * DB-backed integration test config (review F1).
 *
 * These suites run the real query layer against a LIVE Postgres to verify
 * SQL / tenant-isolation correctness — distinct from the default `pnpm test`
 * run, which Proxy-mocks the DB and needs no database. They are kept in their
 * own config so the default run never tries to open a connection.
 *
 * Driven by `pnpm test:db` against a database with migrations applied (the CI
 * `quality` job's postgres service, or a local database). Which database is
 * decided HERE, once, by `resolveDbTestTarget` (F-44): `DATABASE_TEST_URL`
 * when set, else `DATABASE_URL`, and a non-local host is refused unless
 * `DB_TEST_ALLOW_REMOTE=1`. Before F-44 this config never read
 * `DATABASE_TEST_URL`, so the suites wrote their users and organizations into
 * `.env`'s `DATABASE_URL`, hosted or not, while the docs promised an isolated
 * test database. A refusal throws while the config loads, before any worker
 * starts, so it opens no connection.
 */
const target = resolveDbTestTarget();
// The db layer reads only DATABASE_URL, so the chosen database is handed over
// under that name, twice: on this process's env, which the forked workers copy
// today and anything else the runner starts inherits, and through `test.env`,
// Vitest's documented channel into the workers, which it applies last. A
// child process a test spawns (the shutdown fixture) inherits it from its
// worker.
process.env.DATABASE_URL = target.url;
console.info(
  `[test:db] target  host=${target.host}  database=${target.database}  (from ${target.source})`,
);
// DATABASE_TEST_URL names a database of its own, and an .env copied from
// .env.example before F-44 already sets it (the old config ignored it). When
// that database is missing or behind on migrations every suite fails on its
// own, so this line, printed above those failures, says what to do.
if (target.source === "DATABASE_TEST_URL") {
  console.info(
    "[test:db] Nothing creates or migrates this database. Create it once, and re-run " +
      "db:app:migrate and db:auth:migrate against it after a migration lands: " +
      "docs/testing.md#the-db-backed-suites-database",
  );
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "server-only": new URL("./tests/setup/server-only-shim.ts", import.meta.url).pathname,
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup/vitest.setup.ts"],
    include: ["tests/db/**/*.test.ts"],
    env: { DATABASE_URL: target.url },
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
