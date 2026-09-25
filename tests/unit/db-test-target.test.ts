import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteDatabaseRefusedError, resolveDbTestTarget } from "@/db/guards";

/**
 * F-44: which database `pnpm test:db` writes to. The DB-backed suites create
 * and delete users and organizations and briefly change the platform sign-up
 * policy. Before F-44, `vitest.db.config.ts` never read `DATABASE_TEST_URL`
 * and had no host check, so a developer whose `.env` pointed `DATABASE_URL` at
 * a hosted database ran the suites there, although the docs promised an
 * isolated test database.
 *
 * The first block pins the pure policy (`resolveDbTestTarget` in
 * src/db/guards.ts). The second loads the real config file, because the
 * policy is worthless unless the config calls it and hands its answer to the
 * workers.
 */

const LOCAL_APP = "postgresql://devresponse:devresponse@localhost:5444/devresponse_db";
const LOCAL_TEST = "postgresql://devresponse:devresponse@localhost:5444/devresponse_db_test";
const NEON =
  "postgresql://app:secret@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("resolveDbTestTarget (pnpm test:db pre-flight)", () => {
  it("uses DATABASE_TEST_URL when it is set, over DATABASE_URL", () => {
    expect(resolveDbTestTarget({ DATABASE_URL: LOCAL_APP, DATABASE_TEST_URL: LOCAL_TEST })).toEqual(
      {
        url: LOCAL_TEST,
        source: "DATABASE_TEST_URL",
        host: "localhost",
        database: "devresponse_db_test",
        local: true,
      },
    );
  });

  it("uses a local DATABASE_TEST_URL even when DATABASE_URL is hosted (the finding's setup)", () => {
    expect(
      resolveDbTestTarget({ DATABASE_URL: NEON, DATABASE_TEST_URL: LOCAL_TEST }),
    ).toMatchObject({ url: LOCAL_TEST, source: "DATABASE_TEST_URL", local: true });
  });

  it("refuses a hosted DATABASE_TEST_URL, naming the variable and the override but no credentials", () => {
    let caught: unknown;
    try {
      resolveDbTestTarget({ DATABASE_URL: LOCAL_APP, DATABASE_TEST_URL: NEON });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteDatabaseRefusedError);
    const err = caught as RemoteDatabaseRefusedError;
    expect(err.host).toBe("ep-cool-name-123456.us-east-2.aws.neon.tech");
    expect(err.database).toBe("neondb");
    expect(err.message).toContain("[test:db] REFUSING");
    expect(err.message).toContain("DATABASE_TEST_URL names it");
    expect(err.message).toContain("DB_TEST_ALLOW_REMOTE=1");
    expect(err.message).not.toContain("secret");
  });

  it("falls back to a local DATABASE_URL when DATABASE_TEST_URL is unset or empty", () => {
    for (const env of [
      { DATABASE_URL: LOCAL_APP },
      { DATABASE_URL: LOCAL_APP, DATABASE_TEST_URL: "" },
    ]) {
      expect(resolveDbTestTarget(env)).toEqual({
        url: LOCAL_APP,
        source: "DATABASE_URL",
        host: "localhost",
        database: "devresponse_db",
        local: true,
      });
    }
  });

  it("refuses a hosted DATABASE_URL when it is the fallback", () => {
    expect(() => resolveDbTestTarget({ DATABASE_URL: NEON })).toThrow(RemoteDatabaseRefusedError);
    expect(() => resolveDbTestTarget({ DATABASE_URL: NEON })).toThrow(/DATABASE_URL names it/);
  });

  it("runs CI's quality job unchanged (its DATABASE_URL is the localhost service), and CI is no override", () => {
    expect(resolveDbTestTarget({ CI: "true", DATABASE_URL: LOCAL_APP })).toMatchObject({
      url: LOCAL_APP,
      source: "DATABASE_URL",
      local: true,
    });
    expect(() => resolveDbTestTarget({ CI: "true", DATABASE_URL: NEON })).toThrow(
      RemoteDatabaseRefusedError,
    );
  });

  it("lets only DB_TEST_ALLOW_REMOTE=1 through to a remote host", () => {
    expect(
      resolveDbTestTarget({ DATABASE_TEST_URL: NEON, DB_TEST_ALLOW_REMOTE: "1" }),
    ).toMatchObject({ url: NEON, source: "DATABASE_TEST_URL", local: false });
    // Only the exact value "1" counts, and the dev seed's switch is another tool's.
    expect(() =>
      resolveDbTestTarget({ DATABASE_TEST_URL: NEON, DB_TEST_ALLOW_REMOTE: "true" }),
    ).toThrow(RemoteDatabaseRefusedError);
    expect(() =>
      resolveDbTestTarget({ DATABASE_TEST_URL: NEON, DEV_SEED_ALLOW_REMOTE: "1" }),
    ).toThrow(RemoteDatabaseRefusedError);
  });

  it("fails closed on a connection string it cannot parse", () => {
    expect(() =>
      resolveDbTestTarget({ DATABASE_TEST_URL: "host=localhost dbname=devresponse_db_test" }),
    ).toThrow(RemoteDatabaseRefusedError);
  });

  it("throws a message saying what to set when neither variable is set", () => {
    for (const env of [{}, { DATABASE_URL: "", DATABASE_TEST_URL: "" }]) {
      expect(() => resolveDbTestTarget(env)).toThrow(/set DATABASE_TEST_URL to a local, migrated/);
    }
  });
});

// The config loads `.env` on import; a developer's file would fill the
// variables a test leaves unset, so it is kept out.
vi.mock("dotenv/config", () => ({}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function loadDbConfig(env: {
  DATABASE_URL?: string;
  DATABASE_TEST_URL?: string;
  DB_TEST_ALLOW_REMOTE?: string;
}) {
  vi.stubEnv("DATABASE_URL", env.DATABASE_URL);
  vi.stubEnv("DATABASE_TEST_URL", env.DATABASE_TEST_URL);
  vi.stubEnv("DB_TEST_ALLOW_REMOTE", env.DB_TEST_ALLOW_REMOTE);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.resetModules();
  const mod = await import("../../vitest.db.config");
  return { config: mod.default, info };
}

describe("vitest.db.config.ts hands the resolved database to the suites", () => {
  it("gives the workers DATABASE_TEST_URL as their DATABASE_URL and says where it writes", async () => {
    const { config, info } = await loadDbConfig({
      DATABASE_URL: NEON,
      DATABASE_TEST_URL: LOCAL_TEST,
    });
    expect(config.test?.env).toEqual({ DATABASE_URL: LOCAL_TEST });
    expect(process.env.DATABASE_URL).toBe(LOCAL_TEST);
    // An .env copied from .env.example before F-44 already names
    // devresponse_db_test, which the old config ignored and nothing creates. The
    // second line is what points a "database does not exist" run at the fix.
    expect(info.mock.calls).toEqual([
      ["[test:db] target  host=localhost  database=devresponse_db_test  (from DATABASE_TEST_URL)"],
      [
        "[test:db] Nothing creates or migrates this database. Create it once, and re-run " +
          "db:app:migrate and db:auth:migrate against it after a migration lands: " +
          "docs/testing.md#the-db-backed-suites-database",
      ],
    ]);
  });

  it("keeps a local DATABASE_URL when DATABASE_TEST_URL is unset (CI's quality job)", async () => {
    const { config, info } = await loadDbConfig({ DATABASE_URL: LOCAL_APP });
    expect(config.test?.env).toEqual({ DATABASE_URL: LOCAL_APP });
    // The fallback is the database the developer (or CI) already migrates, so
    // it gets the target line only.
    expect(info.mock.calls).toEqual([
      ["[test:db] target  host=localhost  database=devresponse_db  (from DATABASE_URL)"],
    ]);
  });

  it("refuses to load against a hosted DATABASE_URL, before any worker could connect", async () => {
    await expect(loadDbConfig({ DATABASE_URL: NEON })).rejects.toThrow(
      /\[test:db\] REFUSING: host "ep-cool-name-123456\.us-east-2\.aws\.neon\.tech"/,
    );
  });

  it("refuses to load against a hosted DATABASE_TEST_URL", async () => {
    await expect(
      loadDbConfig({ DATABASE_URL: LOCAL_APP, DATABASE_TEST_URL: NEON }),
    ).rejects.toThrow(/\[test:db\] REFUSING/);
  });
});
