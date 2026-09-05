import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guard ORDERING for the development fixture script (`src/db/seeds/dev-init.ts`,
 * review #19). The script runs `main()` at import time, so each test imports
 * a fresh copy with `@/db/schema-config` mocked: `createAppPool` throws a
 * sentinel, which makes "the pre-flight passed and the script reached the
 * database stage" observable without a Postgres. What the suite pins:
 *
 *   - a remote host (Neon) with NODE_ENV unset is refused BEFORE
 *     `createAppPool` is ever called — no connection, no write;
 *   - `DEV_SEED_ALLOW_REMOTE=1` / `--force` lift that refusal (the script
 *     then reaches the pool stage);
 *   - a local host reaches the pool stage without any override;
 *   - the original NODE_ENV=production refusal is still there and also fires
 *     before any pool is created.
 */

const createAppPool = vi.fn();
const ensureSchema = vi.fn();

vi.mock("@/db/schema-config", () => ({
  createAppPool: (...args: unknown[]) => createAppPool(...args),
  ensureSchema: (...args: unknown[]) => ensureSchema(...args),
  DB_SCHEMA: "auth",
}));

const NEON =
  "postgresql://app:secret@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";
const LOCAL = "postgresql://devresponse:devresponse@localhost:5444/devresponse_db";
const POOL_SENTINEL = "pool-stage-reached";

const env = process.env as Record<string, string | undefined>;
const SAVED = {
  DATABASE_URL: env.DATABASE_URL,
  NODE_ENV: env.NODE_ENV,
  DEV_SEED_ALLOW_PROD: env.DEV_SEED_ALLOW_PROD,
  DEV_SEED_ALLOW_REMOTE: env.DEV_SEED_ALLOW_REMOTE,
};
const SAVED_ARGV = [...process.argv];

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

/** Imports the script and waits for its top-level `main().catch` to settle. */
async function runScript(): Promise<{ exitCode: number | undefined; failure: unknown }> {
  vi.resetModules();
  await import("@/db/seeds/dev-init");
  await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
  const exitCode = exitSpy.mock.calls[0]?.[0] as number | undefined;
  const failedCall = errorSpy.mock.calls.find((c: unknown[]) => c[0] === "[dev-init] FAILED");
  return { exitCode, failure: failedCall?.[1] };
}

describe("dev-init pre-flight ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAppPool.mockImplementation(() => {
      throw new Error(POOL_SENTINEL);
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    delete env.NODE_ENV;
    delete env.DEV_SEED_ALLOW_PROD;
    delete env.DEV_SEED_ALLOW_REMOTE;
    process.argv = ["node", "dev-init.ts"];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    process.argv = [...SAVED_ARGV];
    vi.restoreAllMocks();
  });

  it("refuses a remote host with NODE_ENV unset, before any pool is created", async () => {
    env.DATABASE_URL = NEON;
    const { exitCode, failure } = await runScript();
    expect(exitCode).toBe(1);
    expect(String((failure as Error).message)).toMatch(/REFUSING: host "ep-cool-name-123456/);
    expect(String((failure as Error).message)).toContain("DEV_SEED_ALLOW_REMOTE=1");
    expect(createAppPool).not.toHaveBeenCalled();
    expect(ensureSchema).not.toHaveBeenCalled();
  });

  it("DEV_SEED_ALLOW_REMOTE=1 lifts the host refusal (the script reaches the pool stage)", async () => {
    env.DATABASE_URL = NEON;
    env.DEV_SEED_ALLOW_REMOTE = "1";
    const { failure } = await runScript();
    expect((failure as Error).message).toBe(POOL_SENTINEL);
    expect(createAppPool).toHaveBeenCalledTimes(1);
  });

  it("--force lifts the host refusal too", async () => {
    env.DATABASE_URL = NEON;
    process.argv = ["node", "dev-init.ts", "--force"];
    const { failure } = await runScript();
    expect((failure as Error).message).toBe(POOL_SENTINEL);
    expect(createAppPool).toHaveBeenCalledTimes(1);
  });

  it("a local host reaches the pool stage with no override (legitimate path intact)", async () => {
    env.DATABASE_URL = LOCAL;
    const { failure } = await runScript();
    expect((failure as Error).message).toBe(POOL_SENTINEL);
    expect(createAppPool).toHaveBeenCalledTimes(1);
  });

  it("still refuses under NODE_ENV=production, also before any pool is created", async () => {
    env.DATABASE_URL = LOCAL;
    env.NODE_ENV = "production";
    const { exitCode, failure } = await runScript();
    expect(exitCode).toBe(1);
    expect((failure as Error).message).toMatch(/NODE_ENV=production/);
    expect(createAppPool).not.toHaveBeenCalled();
  });

  it("refuses when DATABASE_URL is missing, before either guard or any pool", async () => {
    delete env.DATABASE_URL;
    const { exitCode, failure } = await runScript();
    expect(exitCode).toBe(1);
    expect((failure as Error).message).toMatch(/DATABASE_URL is required/);
    expect(createAppPool).not.toHaveBeenCalled();
  });
});
