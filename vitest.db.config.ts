import "dotenv/config";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * DB-backed integration test config (review F1).
 *
 * These suites run the real query layer against a LIVE Postgres to verify
 * SQL / tenant-isolation correctness — distinct from the default `pnpm test`
 * run, which Proxy-mocks the DB and needs no database. They are kept in their
 * own config so the default run never tries to open a connection.
 *
 * Driven by `pnpm test:db` against a database with migrations applied (the CI
 * `quality` job's postgres service, or a local dev DB). `tests/setup/
 * vitest.setup.ts` only fills MISSING env vars (`??=`), so a real DATABASE_URL
 * from the environment always wins.
 */
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
    pool: "forks",
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
