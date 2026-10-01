import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SchemaConfig from "@/db/schema-config";
import { CONSOLIDATED_CORE_MIGRATIONS, migrationChecksum } from "@/db/migrations/migration-plan";

/**
 * MIG: what `pnpm db:app:migrate` (run-migrations.ts) DOES with each ledger a
 * database can hold after 0002…0008 became `0002-release.sql`. The verdicts
 * themselves are `planConsolidatedMigrations`, unit-tested in
 * migration-plan.test.ts; this suite runs the real runner module against a
 * recording session whose ledger query answers with the ledger under test, and
 * pins the side effects: a pre-consolidation ledger gets ONE ledger row for
 * `0002-release.sql` and none of the file is run (0007's token scrub and
 * 0005's preflights must not run twice); a partial or mismatched legacy ledger
 * is refused with nothing written; a new database applies the file.
 */

vi.mock("dotenv/config", () => ({}));
const appPool = vi.hoisted(() => ({ fake: undefined as unknown }));
vi.mock("@/db/schema-config", async (importOriginal) => {
  const actual = await importOriginal<typeof SchemaConfig>();
  return {
    ...actual,
    ensureSchema: vi.fn(async () => undefined),
    createAppPool: () => appPool.fake as Pool,
  };
});

const DIR = path.resolve(__dirname, "../../src/db/migrations");
const RELEASE = "0002-release.sql";
const RELEASE_SQL = readFileSync(path.join(DIR, RELEASE), "utf8");
const BASELINE_SQL = readFileSync(path.join(DIR, "0001-initial-schema.sql"), "utf8");
const FOLDS = CONSOLIDATED_CORE_MIGRATIONS[RELEASE]!.folds;
const LEDGER_INSERT = "insert into app_schema_migrations (id, checksum) values ($1, $2)";

/** Ledger rows for 0001 and every locale file, under their real checksums (no backfill). */
function currentRows(): Array<[string, string | null]> {
  const locales = readdirSync(path.join(DIR, "locales")).filter((f) => f.endsWith(".sql"));
  return [
    ["0001-initial-schema.sql", migrationChecksum(BASELINE_SQL)],
    ...locales.map((file): [string, string] => [
      `locales/${file}`,
      migrationChecksum(readFileSync(path.join(DIR, "locales", file), "utf8")),
    ]),
  ];
}

/** Production's ledger on 2026-09-30: 0001…0008 under their pins, plus the locales. */
function legacyRows(): Array<[string, string | null]> {
  return [...currentRows(), ...FOLDS.map((fold): [string, string] => [fold.id, fold.checksum])];
}

interface Run {
  statements: Array<{ text: string; params?: unknown[] }>;
  logs: string[];
  errors: unknown[][];
  exitCode: number | undefined;
}

/** Imports the runner (it runs main() on import) against a session holding `ledger`. */
async function runMigrations(ledger: Array<[string, string | null]>): Promise<Run> {
  const run: Run = { statements: [], logs: [], errors: [], exitCode: undefined };
  const session = {
    query: async (text: string, params?: unknown[]) => {
      run.statements.push({ text, params });
      if (text.trim() === "select id, checksum from app_schema_migrations") {
        return { rows: ledger.map(([id, checksum]) => ({ id, checksum })) };
      }
      // DEP2's session check: the search_path resolves to DB_SCHEMA, and the
      // migrating role owns the ledger.
      if (text.includes("current_schema()")) {
        return { rows: [{ schema_name: params?.[0], login: "owner", ledger_owner: "owner" }] };
      }
      return { rows: [] };
    },
    on: () => session,
    release: () => undefined,
  };
  const end = vi.fn(async () => undefined);
  appPool.fake = { connect: async () => session, end };
  vi.spyOn(console, "log").mockImplementation((line: string) => void run.logs.push(line));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void run.errors.push(args));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    run.exitCode = code;
  }) as never);
  await import("@/db/migrations/run-migrations");
  // Generous: a cold run transforms the runner's imports first.
  await vi.waitFor(() => expect(end).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  // A refusal reaches process.exit after the pool has ended.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return run;
}

const ledgerWrites = (run: Run) =>
  run.statements.filter(
    (s) => s.text === LEDGER_INSERT || s.text.startsWith("update app_schema_migrations"),
  );
const ranFile = (run: Run, sql: string) => run.statements.some((s) => s.text === sql);

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  appPool.fake = undefined;
});

describe("db:app:migrate across the consolidation (MIG)", () => {
  it("records 0002-release.sql on a pre-consolidation ledger, in a transaction, and runs none of it", async () => {
    const run = await runMigrations(legacyRows());

    expect(run.errors).toEqual([]);
    expect(run.exitCode).toBeUndefined();
    expect(ledgerWrites(run)).toEqual([
      { text: LEDGER_INSERT, params: [RELEASE, migrationChecksum(RELEASE_SQL)] },
    ]);
    const insert = run.statements.findIndex((s) => s.text === LEDGER_INSERT);
    expect(run.statements[insert - 1]!.text).toBe("begin");
    expect(run.statements[insert + 1]!.text).toBe("commit");
    expect(ranFile(run, RELEASE_SQL)).toBe(false);
    expect(ranFile(run, BASELINE_SQL)).toBe(false);
    expect(run.logs).toContain("[migrate] record 0002-release.sql (already applied as 0002…0008)");
    expect(run.logs).toContain(`[migrate] skip   ${RELEASE}`);
    expect(run.logs.filter((line) => line.startsWith("[migrate] apply"))).toEqual([]);
    // The legacy rows are history and stay: nothing deletes from the ledger.
    expect(run.statements.some((s) => /delete from app_schema_migrations/i.test(s.text))).toBe(
      false,
    );
  });

  it("skips everything once 0002-release.sql is recorded", async () => {
    const recorded: [string, string] = [RELEASE, migrationChecksum(RELEASE_SQL)];
    const run = await runMigrations([...legacyRows(), recorded]);
    expect(run.errors).toEqual([]);
    expect(ledgerWrites(run)).toEqual([]);
    expect(run.statements.some((s) => s.text === "begin")).toBe(false);
    expect(run.logs.some((line) => line.startsWith("[migrate] record"))).toBe(false);
  });

  it("records with a warning when a legacy row has no checksum (ledgered before review #86)", async () => {
    const rows = legacyRows().map(([id, checksum]): [string, string | null] =>
      id === "0006-rate-limit-buckets.sql" ? [id, null] : [id, checksum],
    );
    const run = await runMigrations(rows);
    expect(run.errors).toEqual([]);
    expect(ledgerWrites(run)).toEqual([
      { text: LEDGER_INSERT, params: [RELEASE, migrationChecksum(RELEASE_SQL)] },
    ]);
    expect(run.logs).toContainEqual(
      expect.stringMatching(
        /^\[migrate\] warning: 0006-rate-limit-buckets\.sql has no ledgered checksum/,
      ),
    );
  });

  it("refuses a partial legacy ledger (0001…0005) and writes nothing", async () => {
    const run = await runMigrations(legacyRows().filter(([id]) => !/^000[678]-/.test(id)));
    expect(run.exitCode).toBe(1);
    expect(String(run.errors[0]?.[1])).toMatch(
      /missing: 0006-rate-limit-buckets\.sql, 0007-uniqueness-search-indexes-token-scrub\.sql, 0008-user-data-export-erasure\.sql.*commit 79b4803/s,
    );
    expect(ledgerWrites(run)).toEqual([]);
    expect(run.statements.some((s) => s.text === "begin")).toBe(false);
  });

  it("refuses a legacy row under another checksum and records nothing", async () => {
    const rows = legacyRows().map(([id, checksum]): [string, string | null] =>
      id === "0007-uniqueness-search-indexes-token-scrub.sql"
        ? [id, "0".repeat(64)]
        : [id, checksum],
    );
    const run = await runMigrations(rows);
    expect(run.exitCode).toBe(1);
    expect(String(run.errors[0]?.[1])).toMatch(
      /cannot record "0002-release\.sql": the ledger has 0{64} for "0007-uniqueness-search-indexes-token-scrub\.sql"/,
    );
    expect(ledgerWrites(run)).toEqual([]);
    expect(run.statements.some((s) => s.text === "begin")).toBe(false);
  });

  it("applies 0001 and 0002-release.sql on a new database, and records nothing it did not run", async () => {
    const run = await runMigrations([]);
    expect(run.errors).toEqual([]);
    expect(ranFile(run, BASELINE_SQL)).toBe(true);
    expect(ranFile(run, RELEASE_SQL)).toBe(true);
    expect(run.logs).toContain(`[migrate] apply  ${RELEASE}`);
    expect(run.logs.some((line) => line.startsWith("[migrate] record"))).toBe(false);
  });
});
