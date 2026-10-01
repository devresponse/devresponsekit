import "dotenv/config";
import pg from "pg";
import {
  reconcileRuntimePrivileges,
  verifyCurrentUserPrivileges,
} from "@/db/migrations/runtime-privileges-db";
import { type LoginSession, runRuntimeLogin } from "@/db/runtime-login";
import { DB_SCHEMA, createAppPool, resolveDatabaseUrl } from "@/db/schema-config";

/**
 * `pnpm db:runtime-login` (DEP3): create or rotate the least-privilege login
 * for DB_SCHEMA and verify it. The rules and the steps are in
 * src/db/runtime-login.ts and docs/deployment.md §8; this file only wires the
 * real connections in:
 *
 *   DB_RUNTIME_LOGIN_PASSWORD=<32-128 of A-Za-z0-9_-> pnpm db:runtime-login \
 *     [--login <schema>_app_<x>] [--connection-limit <n>] \
 *     [--verify-host <pooled host>] [--allow-remote] [--plaintext-password]
 *
 * DATABASE_URL is the owner's DIRECT connection, as for db:app:migrate, and
 * dotenv fills it from .env like every other kit db script.
 */

async function connectOwner(): Promise<LoginSession> {
  // The owner session, startup search_path on (DB_SEARCH_PATH_VIA_OPTIONS
  // applies as for the migrators), one connection held for the run.
  const pool = createAppPool({ max: 1 });
  const client = await pool.connect();
  return {
    query: client.query.bind(client),
    end: async () => {
      client.release();
      await pool.end();
    },
  };
}

async function connectLogin(connectionString: string): Promise<LoginSession> {
  // A plain client with no `options`: what a transaction pooler forwards.
  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(connectionString),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  return { query: client.query.bind(client), end: () => client.end() };
}

runRuntimeLogin({
  env: process.env,
  argv: process.argv.slice(2),
  schema: DB_SCHEMA,
  connectOwner,
  connectLogin,
  reconcile: reconcileRuntimePrivileges,
  verify: verifyCurrentUserPrivileges,
  log: (line) => console.log(line),
})
  .catch((err: unknown) => {
    // describeError-style: code and message only, never a connection string.
    const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
    console.log(
      `[db:runtime-login] FAILED ${typeof code === "string" ? `${code} ` : ""}${String(message ?? err)}`,
    );
    return 1;
  })
  .then((code) => process.exit(code));
