import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pgPool } from "@/db/database";
import { DB_SCHEMA, resolveDatabaseUrl, SEARCH_PATH_VIA_OPTIONS } from "@/db/schema-config";
import { intFromEnv } from "@/lib/env";

/**
 * Review #20 smoke test: with DB_SEARCH_PATH_VIA_OPTIONS on (the default, and
 * what a DIRECT endpoint gets) every connection the runtime pool hands out
 * must already carry the configured `statement_timeout` /
 * `idle_in_transaction_session_timeout` — i.e. the startup parameters really
 * are applied server-side, not merely present in the Pool config.
 *
 * The expected values are read the same way `src/db/database.ts` reads them,
 * so an operator's PG_*_TIMEOUT_MS override in `.env` does not fail the test.
 * A control connection with NO startup parameters proves the values come from
 * the packet and not from a pre-existing role default on the test database.
 */
const EXPECTED_STATEMENT_MS = intFromEnv("PG_STATEMENT_TIMEOUT_MS", 30_000);
const EXPECTED_IDLE_IN_TX_MS = intFromEnv("PG_IDLE_IN_TX_TIMEOUT_MS", 30_000);

/** `show <setting>` renders `30000ms` as `30s`; compare in ms via interval. */
const SETTING_MS_SQL = (name: string) =>
  `select (extract(epoch from current_setting('${name}')::interval) * 1000)::int as ms`;

async function settingMs(pool: Pool, name: string): Promise<number> {
  const { rows } = await pool.query<{ ms: number }>(SETTING_MS_SQL(name));
  return rows[0]!.ms;
}

describe.skipIf(!SEARCH_PATH_VIA_OPTIONS)(
  "runtime pool session settings via startup parameters (review #20)",
  () => {
    const control = new Pool({ connectionString: resolveDatabaseUrl(), max: 1 });

    afterAll(async () => {
      await control.end();
      await pgPool.end();
    });

    it("every app-pool connection has the configured statement_timeout", async () => {
      expect(await settingMs(pgPool, "statement_timeout")).toBe(EXPECTED_STATEMENT_MS);
    });

    it("every app-pool connection has the configured idle_in_transaction_session_timeout", async () => {
      expect(await settingMs(pgPool, "idle_in_transaction_session_timeout")).toBe(
        EXPECTED_IDLE_IN_TX_MS,
      );
    });

    it("every app-pool connection resolves unqualified names to DB_SCHEMA first", async () => {
      const { rows } = await pgPool.query<{ search_path: string }>("show search_path");
      expect(rows[0]!.search_path).toMatch(new RegExp(`^"?${DB_SCHEMA}"?,\\s*public$`));
    });

    it("control: a connection WITHOUT the startup parameters gets the server defaults (0 = off)", async () => {
      // If this ever fails, someone has set role/database defaults on the test
      // DB and the assertions above would no longer prove the packet works.
      expect(await settingMs(control, "statement_timeout")).toBe(0);
      expect(await settingMs(control, "idle_in_transaction_session_timeout")).toBe(0);
    });

    it("the statement ceiling is enforced, not just reported", async () => {
      // A dedicated client (destroyed on release) so the session-level
      // override and the cancelled statement can never leak into the pool.
      const client = await pgPool.connect();
      try {
        await client.query("set statement_timeout = '200ms'");
        await expect(client.query("select pg_sleep(2)")).rejects.toMatchObject({
          code: "57014", // query_canceled
        });
      } finally {
        client.release(true);
      }
    });
  },
);
