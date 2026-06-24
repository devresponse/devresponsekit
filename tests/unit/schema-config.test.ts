import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

/**
 * `src/db/schema-config.ts` is the single source of truth for which schema
 * every table is deployed into. It reads `DB_SCHEMA` at module load and
 * interpolates it into DDL + the connection `search_path`, so the
 * identifier-safety guard is security-relevant. These tests pin the default,
 * the option-string format, the injection guard, and the bootstrap DDL.
 */
describe("schema-config", () => {
  const ORIGINAL = process.env.DB_SCHEMA;
  const ORIGINAL_VIA = process.env.DB_SEARCH_PATH_VIA_OPTIONS;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DB_SCHEMA;
    else process.env.DB_SCHEMA = ORIGINAL;
    if (ORIGINAL_VIA === undefined) delete process.env.DB_SEARCH_PATH_VIA_OPTIONS;
    else process.env.DB_SEARCH_PATH_VIA_OPTIONS = ORIGINAL_VIA;
    vi.resetModules();
  });

  /** Reads the libpq `options` a constructed pg Pool was given (or undefined). */
  const libpqOptions = (pool: Pool): string | undefined =>
    (pool as unknown as { options: { options?: string } }).options.options;

  it("defaults to the `auth` schema and builds the search_path option", async () => {
    delete process.env.DB_SCHEMA;
    vi.resetModules();
    const mod = await import("@/db/schema-config");
    expect(mod.DB_SCHEMA).toBe("auth");
    expect(mod.SEARCH_PATH_OPTION).toBe('-c search_path="auth",public');
  });

  it("honors a configured DB_SCHEMA (separation by schema)", async () => {
    process.env.DB_SCHEMA = "auth2";
    vi.resetModules();
    const mod = await import("@/db/schema-config");
    expect(mod.DB_SCHEMA).toBe("auth2");
    expect(mod.SEARCH_PATH_OPTION).toBe('-c search_path="auth2",public');
  });

  it("rejects an unsafe DB_SCHEMA identifier (injection guard)", async () => {
    process.env.DB_SCHEMA = "auth; drop schema public --";
    vi.resetModules();
    await expect(import("@/db/schema-config")).rejects.toThrow(/Invalid DB_SCHEMA/);
  });

  it("ensureSchema issues an idempotent create-schema for the target", async () => {
    process.env.DB_SCHEMA = "auth";
    vi.resetModules();
    const mod = await import("@/db/schema-config");
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await mod.ensureSchema({ query } as unknown as Pool);
    expect(query).toHaveBeenCalledWith('create schema if not exists "auth"');
  });

  it("sends search_path via the libpq options parameter by default (direct endpoint)", async () => {
    delete process.env.DB_SCHEMA;
    delete process.env.DB_SEARCH_PATH_VIA_OPTIONS;
    vi.resetModules();
    const mod = await import("@/db/schema-config");
    expect(mod.SEARCH_PATH_VIA_OPTIONS).toBe(true);
    const pool = mod.createAppPool();
    expect(libpqOptions(pool)).toBe('-c search_path="auth",public');
    await pool.end();
  });

  it("omits the options parameter when DB_SEARCH_PATH_VIA_OPTIONS=0 (transaction poolers)", async () => {
    process.env.DB_SEARCH_PATH_VIA_OPTIONS = "0";
    delete process.env.DB_SCHEMA;
    vi.resetModules();
    const mod = await import("@/db/schema-config");
    expect(mod.SEARCH_PATH_VIA_OPTIONS).toBe(false);
    const pool = mod.createAppPool();
    expect(libpqOptions(pool)).toBeUndefined();
    await pool.end();
  });
});
