import { describe, expect, it } from "vitest";
import {
  assertDevSeedTarget,
  assertLocalDatabaseTarget,
  describeDatabaseTarget,
  isLocalDatabaseHost,
  LOCAL_DB_HOSTS,
  RemoteDatabaseRefusedError,
} from "@/db/guards";

/**
 * `src/db/guards.ts` is the shared local-host safety rail for the destructive
 * / credential-leaking database tools (`db:reset`, `db:seed:dev`) — review
 * #19. These tests pin the classification (loopback in every spelling is
 * local; a hosted Postgres is not; an unparseable URL fails CLOSED), the
 * override switch, and the dev seed's two-stage pre-flight.
 */

const NEON =
  "postgresql://app:secret@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("describeDatabaseTarget / isLocalDatabaseHost", () => {
  it.each([
    ["postgresql://devresponse:devresponse@localhost:5444/devresponse_db", "localhost"],
    ["postgresql://u:p@127.0.0.1:5432/db", "127.0.0.1"],
    ["postgresql://u:p@[::1]:5432/db", "::1"],
    ["postgresql://u:p@0.0.0.0:5432/db", "0.0.0.0"],
    ["postgresql://u:p@LOCALHOST/db", "localhost"],
    ["postgresql:///db", ""],
  ])("treats %s as local (host %j)", (url, host) => {
    const target = describeDatabaseTarget(url);
    expect(target.host).toBe(host);
    expect(target.local).toBe(true);
    expect(isLocalDatabaseHost(host)).toBe(true);
  });

  it("classifies a hosted (Neon) database as remote and reports host + database", () => {
    const target = describeDatabaseTarget(NEON);
    expect(target).toEqual({
      host: "ep-cool-name-123456.us-east-2.aws.neon.tech",
      database: "neondb",
      local: false,
    });
  });

  it.each([
    "db.internal.example.com",
    "10.0.0.5",
    "192.168.1.20",
    "localhost.evil.example",
    "notlocalhost",
  ])("does not treat %s as local", (host) => {
    expect(isLocalDatabaseHost(host)).toBe(false);
    expect(describeDatabaseTarget(`postgresql://u:p@${host}/db`).local).toBe(false);
  });

  it("fails CLOSED on an unparseable connection string", () => {
    expect(describeDatabaseTarget("host=localhost dbname=db")).toEqual({
      host: "?",
      database: "?",
      local: false,
    });
    expect(describeDatabaseTarget("")).toMatchObject({ local: false });
  });

  it("exposes the local-host allow-list both tools share", () => {
    expect([...LOCAL_DB_HOSTS].sort()).toEqual(["", "0.0.0.0", "127.0.0.1", "::1", "localhost"]);
  });
});

describe("assertLocalDatabaseTarget", () => {
  const options = {
    allowRemote: false,
    tool: "db:test",
    consequence: "This would do something irreversible.",
    overrideHint: "re-run with --force",
  };

  it("returns the target for a local host", () => {
    expect(assertLocalDatabaseTarget("postgresql://u:p@localhost/db", options)).toEqual({
      host: "localhost",
      database: "db",
      local: true,
    });
  });

  it("throws RemoteDatabaseRefusedError for a remote host, naming host + override", () => {
    let caught: unknown;
    try {
      assertLocalDatabaseTarget(NEON, options);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteDatabaseRefusedError);
    const err = caught as RemoteDatabaseRefusedError;
    expect(err.host).toBe("ep-cool-name-123456.us-east-2.aws.neon.tech");
    expect(err.database).toBe("neondb");
    expect(err.message).toContain("[db:test] REFUSING");
    expect(err.message).toContain("This would do something irreversible.");
    expect(err.message).toContain("re-run with --force");
    // the URL's credentials never appear in the refusal
    expect(err.message).not.toContain("secret");
  });

  it("honours the explicit override and still reports the target as remote", () => {
    expect(assertLocalDatabaseTarget(NEON, { ...options, allowRemote: true })).toMatchObject({
      host: "ep-cool-name-123456.us-east-2.aws.neon.tech",
      local: false,
    });
  });
});

describe("assertDevSeedTarget (db:seed:dev pre-flight)", () => {
  const LOCAL = "postgresql://devresponse:devresponse@localhost:5444/devresponse_db";
  const argv = ["node", "dev-init.ts"];

  it("allows a local host with NODE_ENV unset (the everyday path)", () => {
    expect(assertDevSeedTarget({ databaseUrl: LOCAL, env: {}, argv })).toMatchObject({
      host: "localhost",
      local: true,
    });
  });

  it("refuses a remote host even when NODE_ENV is unset or development", () => {
    expect(() => assertDevSeedTarget({ databaseUrl: NEON, env: {}, argv })).toThrow(
      RemoteDatabaseRefusedError,
    );
    expect(() =>
      assertDevSeedTarget({ databaseUrl: NEON, env: { NODE_ENV: "development" }, argv }),
    ).toThrow(/not local/);
  });

  it("refuses a remote host when only the (unrelated) DEV_SEED_ALLOW_PROD override is set", () => {
    expect(() =>
      assertDevSeedTarget({ databaseUrl: NEON, env: { DEV_SEED_ALLOW_PROD: "1" }, argv }),
    ).toThrow(RemoteDatabaseRefusedError);
  });

  it("lets DEV_SEED_ALLOW_REMOTE=1 or --force override the host check", () => {
    expect(
      assertDevSeedTarget({ databaseUrl: NEON, env: { DEV_SEED_ALLOW_REMOTE: "1" }, argv }),
    ).toMatchObject({ local: false });
    expect(
      assertDevSeedTarget({ databaseUrl: NEON, env: {}, argv: [...argv, "--force"] }),
    ).toMatchObject({ local: false });
    // only the exact value "1" counts
    expect(() =>
      assertDevSeedTarget({ databaseUrl: NEON, env: { DEV_SEED_ALLOW_REMOTE: "true" }, argv }),
    ).toThrow(RemoteDatabaseRefusedError);
  });

  it("keeps the NODE_ENV=production refusal, checked first and independent of the host", () => {
    expect(() =>
      assertDevSeedTarget({ databaseUrl: LOCAL, env: { NODE_ENV: "production" }, argv }),
    ).toThrow(/NODE_ENV=production/);
    // the remote override does not lift the production refusal...
    expect(() =>
      assertDevSeedTarget({
        databaseUrl: NEON,
        env: { NODE_ENV: "production", DEV_SEED_ALLOW_REMOTE: "1" },
        argv,
      }),
    ).toThrow(/NODE_ENV=production/);
    // ...and DEV_SEED_ALLOW_PROD alone still leaves the host check in force.
    expect(() =>
      assertDevSeedTarget({
        databaseUrl: NEON,
        env: { NODE_ENV: "production", DEV_SEED_ALLOW_PROD: "1" },
        argv,
      }),
    ).toThrow(RemoteDatabaseRefusedError);
    // both overrides together is the only way through.
    expect(
      assertDevSeedTarget({
        databaseUrl: NEON,
        env: { NODE_ENV: "production", DEV_SEED_ALLOW_PROD: "1", DEV_SEED_ALLOW_REMOTE: "1" },
        argv,
      }),
    ).toMatchObject({ local: false });
  });
});
