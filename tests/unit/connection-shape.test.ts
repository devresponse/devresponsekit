import { describe, expect, it } from "vitest";
import { migrationUrlProblem, pooledReason, repointingParams } from "@/db/connection-shape";
// drk-deploy's copy, which refuses the same URLs before it hands one to the
// kit's runners. Its `./log.js` import resolves under the kit's vitest (as
// env-spec.ts's import of this module does for drk-deploy-required-keys).
import {
  pooledReason as cliPooledReason,
  repointingParams as cliRepointingParams,
} from "../../vercel-cli/src/lib/migration-target";

/**
 * DEP2: the migration runners refuse a pooled or re-pointed `DATABASE_URL`
 * before they connect (`migrationUrlProblem`), with the rules drk-deploy has
 * applied to its migration URL since F-47. The two copies cannot import each
 * other, so one vector list runs through both, and a rule changed in one copy
 * fails here until the other follows.
 */

const DIRECT = "postgresql://owner:s3cret@ep-cool-river-123456.us-east-2.aws.neon.tech/neondb";

/** [url, pooled reason or null, re-pointing params]. */
const VECTORS: ReadonlyArray<readonly [string, string | null, readonly string[]]> = [
  // Direct endpoints.
  [`${DIRECT}?sslmode=require`, null, []],
  ["postgres://devresponse:devresponse@localhost:5444/devresponse_db", null, []],
  ["postgresql://u:p@db.example.com:5432/app?sslmode=require&application_name=migrate", null, []],
  // Look-alikes that are not pooled.
  ["postgresql://u:p@mypooler.example.com/app", null, []],
  ["postgresql://u:p@my-pooler-db.example.com/app", null, []],
  ["postgresql://u:p@db.example.com:65430/app", null, []],
  ["postgresql://u:p@db.example.com/app?pgbouncer=false", null, []],
  // Neon's pooled host, in any case, with or without a domain.
  [
    "postgresql://owner:s3cret@ep-cool-river-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
    "its host carries Neon's `-pooler` suffix",
    [],
  ],
  [
    "postgresql://u:p@EP-X-POOLER.Region.AWS.Neon.Tech/app",
    "its host carries Neon's `-pooler` suffix",
    [],
  ],
  ["postgresql://u:p@db-pooler:5432/app", "its host carries Neon's `-pooler` suffix", []],
  // Supabase's pooler, which is also on 6543: the host is reported first.
  [
    "postgresql://postgres.abcdefghijkl:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    "its host is a `.pooler.` endpoint",
    [],
  ],
  ["postgresql://u:p@pooler.example.com/app", "its host is a `.pooler.` endpoint", []],
  // A transaction pooler's port, and PgBouncer's marker.
  [
    "postgresql://u:p@db.example.com:6543/app",
    "it uses port 6543, the transaction pooler's port",
    [],
  ],
  ["postgresql://u:p@db.example.com/app?pgbouncer=true", "it carries `pgbouncer=true`", []],
  ["postgresql://u:p@db.example.com/app?pgbouncer=TRUE", "it carries `pgbouncer=true`", []],
  // Re-pointing query parameters, reported in a fixed order.
  ["postgresql://u:p@db.example.com/app?host=/var/run/postgresql", null, ["host"]],
  ["postgresql://u:p@db.example.com/app?hostaddr=10.0.0.5", null, ["hostaddr"]],
  ["postgresql://u:p@db.example.com/app?port=5433", null, ["port"]],
  ["postgresql://u:p@db.example.com/app?dbname=other", null, ["dbname"]],
  ["postgresql://u:p@db.example.com/app?database=other", null, ["database"]],
  ["postgresql://u:p@db.example.com/app?user=other&host=elsewhere", null, ["host", "user"]],
  [
    "postgresql://u:p@db-pooler.example.com/app?sslmode=require&port=6432",
    "its host carries Neon's `-pooler` suffix",
    ["port"],
  ],
];

describe("the runners' copy of drk-deploy's URL rules (DEP2, F-47)", () => {
  it.each(VECTORS)("%s", (raw, pooled, params) => {
    const url = new URL(raw);
    expect(pooledReason(url)).toBe(pooled);
    expect(repointingParams(url)).toEqual(params);
  });

  it.each(VECTORS)("drk-deploy agrees on %s", (raw) => {
    const url = new URL(raw);
    expect(cliPooledReason(url)).toBe(pooledReason(url));
    expect(cliRepointingParams(url)).toEqual(repointingParams(url));
  });
});

describe("migrationUrlProblem (DEP2)", () => {
  it("allows a direct postgres URL", () => {
    expect(migrationUrlProblem(`${DIRECT}?sslmode=require`)).toBeNull();
    expect(migrationUrlProblem("postgres://devresponse@localhost:5444/devresponse_db")).toBeNull();
  });

  it.each([undefined, ""])("requires a URL (%j)", (raw) => {
    expect(migrationUrlProblem(raw)).toBe("DATABASE_URL is required to run migrations.");
  });

  it.each([
    "not a url",
    "mysql://u:p@db.example.com/app",
    "https://db.example.com/app",
    "host=db.example.com dbname=app",
  ])("refuses what is not a postgres URL: %s", (raw) => {
    expect(migrationUrlProblem(raw)).toBe(
      "DATABASE_URL is not a postgres:// or postgresql:// URL.",
    );
  });

  it.each(VECTORS.filter(([, pooled]) => pooled !== null))(
    "refuses a pooled URL, giving the reason: %s",
    (raw, pooled) => {
      const problem = migrationUrlProblem(raw)!;
      expect(problem).toContain(`DATABASE_URL looks pooled: ${pooled}.`);
      expect(problem).toContain("DIRECT endpoint");
      expect(problem).toContain("Nothing was attempted.");
    },
  );

  it.each(VECTORS.filter(([, pooled, params]) => pooled === null && params.length > 0))(
    "refuses a re-pointed URL, naming the parameters: %s",
    (raw, _pooled, params) => {
      const problem = migrationUrlProblem(raw)!;
      expect(problem).toContain(
        `re-points the connection with ${params.map((p) => `\`${p}\``).join(", ")} in its query`,
      );
      expect(problem).toContain("Nothing was attempted.");
    },
  );

  it("never repeats the URL, its password or its host", () => {
    for (const [raw] of VECTORS) {
      const problem = migrationUrlProblem(raw);
      if (problem === null) continue;
      const url = new URL(raw);
      expect(problem).not.toContain(raw);
      // The one-letter fixture passwords would match any prose.
      if (url.password.length > 3) expect(problem).not.toContain(url.password);
      expect(problem.toLowerCase()).not.toContain(url.hostname.toLowerCase());
    }
    expect(migrationUrlProblem(VECTORS[7]![0])).not.toContain("s3cret");
    expect(migrationUrlProblem("mysql://u:s3cret@db.example.com/app")).not.toContain("s3cret");
  });
});
