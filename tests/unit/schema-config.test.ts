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

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DB_SCHEMA;
    else process.env.DB_SCHEMA = ORIGINAL;
    vi.resetModules();
  });

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
});
