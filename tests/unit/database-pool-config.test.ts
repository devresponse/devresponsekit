import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Review #20: `statement_timeout` / `idle_in_transaction_session_timeout` are
 * STARTUP-PACKET parameters in `pg` (like the libpq `options` that carries
 * search_path), so a transaction pooler rejects them the same way. The
 * runtime pool must therefore gate all three behind DB_SEARCH_PATH_VIA_OPTIONS:
 * on by default, and with `=0` none of them may reach the Pool config.
 *
 * `pg`'s Pool keeps its constructor config on `pool.options`; nothing connects
 * until the first query, so constructing the module-level pool is side-effect
 * free here.
 */
type PoolOptions = Record<string, unknown>;

const poolOptions = (pool: unknown): PoolOptions => (pool as { options: PoolOptions }).options;

const STARTUP_KEYS = ["options", "statement_timeout", "idle_in_transaction_session_timeout"];

describe("src/db/database.ts pool config (review #20)", () => {
  const saved = {
    via: process.env.DB_SEARCH_PATH_VIA_OPTIONS,
    stmt: process.env.PG_STATEMENT_TIMEOUT_MS,
    idle: process.env.PG_IDLE_IN_TX_TIMEOUT_MS,
  };

  afterEach(async () => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("DB_SEARCH_PATH_VIA_OPTIONS", saved.via);
    restore("PG_STATEMENT_TIMEOUT_MS", saved.stmt);
    restore("PG_IDLE_IN_TX_TIMEOUT_MS", saved.idle);
    vi.resetModules();
  });

  async function loadPool() {
    vi.resetModules();
    const { pgPool } = await import("@/db/database");
    return pgPool;
  }

  it("sends search_path AND both timeouts as startup parameters by default (direct endpoint)", async () => {
    delete process.env.DB_SEARCH_PATH_VIA_OPTIONS;
    delete process.env.PG_STATEMENT_TIMEOUT_MS;
    delete process.env.PG_IDLE_IN_TX_TIMEOUT_MS;
    const pool = await loadPool();
    try {
      const opts = poolOptions(pool);
      expect(opts.options).toMatch(/^-c search_path="[a-z_][a-z0-9_]*",public$/i);
      // The defaults the docs' `ALTER ROLE … '30s'` equivalents must match.
      expect(opts.statement_timeout).toBe(30_000);
      expect(opts.idle_in_transaction_session_timeout).toBe(30_000);
    } finally {
      await pool.end();
    }
  });

  it("honours the PG_*_TIMEOUT_MS overrides when the flag is on", async () => {
    delete process.env.DB_SEARCH_PATH_VIA_OPTIONS;
    process.env.PG_STATEMENT_TIMEOUT_MS = "12345";
    process.env.PG_IDLE_IN_TX_TIMEOUT_MS = "6789";
    const pool = await loadPool();
    try {
      expect(poolOptions(pool).statement_timeout).toBe(12_345);
      expect(poolOptions(pool).idle_in_transaction_session_timeout).toBe(6_789);
    } finally {
      await pool.end();
    }
  });

  it.each(["0", "false", "no", "off"])(
    "DB_SEARCH_PATH_VIA_OPTIONS=%s sends NONE of options / statement_timeout / idle_in_transaction_session_timeout",
    async (flag) => {
      process.env.DB_SEARCH_PATH_VIA_OPTIONS = flag;
      // Even an explicit override must not leak through: the pooler would
      // reject the connection regardless of the value.
      process.env.PG_STATEMENT_TIMEOUT_MS = "12345";
      process.env.PG_IDLE_IN_TX_TIMEOUT_MS = "6789";
      const pool = await loadPool();
      try {
        const opts = poolOptions(pool);
        for (const key of STARTUP_KEYS) expect(opts).not.toHaveProperty(key);
        // The non-startup pool settings are untouched by the flag.
        expect(opts.max).toBeGreaterThanOrEqual(1);
        expect(opts.connectionTimeoutMillis).toBeGreaterThanOrEqual(1);
        expect(opts.idleTimeoutMillis).toBe(30_000);
      } finally {
        await pool.end();
      }
    },
  );
});
