import type { Pool } from "pg";
import {
  type AttemptResult,
  type LedgerRow,
  describeError,
  evaluateLedger,
  isConnectionError,
} from "../deploy-gate";
import { CORE_MIGRATION_LEDGER_IDS } from "./migration-plan";

/**
 * One attempt of the production build's schema gate (DEP1): the database
 * half. The decisions are in `../deploy-gate.ts`, which is pure; this module
 * only asks the database, through the build's own pool (`createAppPool`, so
 * `DB_SCHEMA` and `DB_SEARCH_PATH_VIA_OPTIONS` apply exactly as they do for
 * the running app), and never writes. It lives with the migration tooling
 * because the unit coverage gate excludes this directory: the live database
 * test (tests/db/deploy-gate.db.test.ts) is what covers it.
 */

/** What Better Auth's migrator would do here, as `getMigrations` (better-auth 1.7.6) reports it. */
export interface BetterAuthMigrationPlan {
  toBeCreated: ReadonlyArray<{ table: string }>;
  toBeAdded: ReadonlyArray<{ table: string; fields: Readonly<Record<string, unknown>> }>;
  toBeAddedIndexes: ReadonlyArray<{ table: string; name: string }>;
  unsafeChanges: readonly string[];
  schemaProblems: readonly string[];
}

export interface GateCheckOptions {
  /** `DB_SCHEMA`: where the build's connections must resolve. */
  schema: string;
  /** This build's core migration files, by ledger id. */
  files: ReadonlyMap<string, string>;
  /**
   * Better Auth's plan for this database, read through `pool` and never run:
   * the script passes `getMigrations({ ...auth.options, database: pool },
   * { throwOnUnsafe: false })`, the way run-better-auth-migrate.ts reads it.
   */
  betterAuth: (pool: Pool) => Promise<BetterAuthMigrationPlan>;
}

/** Who the build connects as, read on every attempt that reaches the database. */
export interface GateIdentity {
  currentUser: string;
  currentSchema: string | null;
  /** A superuser, or the owner of `<schema>.app_schema_migrations`: not the least-privilege login. */
  isOwner: boolean;
}

export interface GateCheckResult extends AttemptResult {
  /** Null when the database could not be reached at all. */
  identity: GateIdentity | null;
  warnings: string[];
}

/**
 * Identity and ownership in one round trip. The ledger's owner is looked up
 * by schema and name, so it answers (null) even where the table is missing.
 */
const IDENTITY_SQL = `
  select current_user as user_name,
         current_schema() as schema_name,
         coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
         (select pg_get_userbyid(c.relowner)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = $1 and c.relname = 'app_schema_migrations') as ledger_owner`;

/** The rows `missingCoreMigrations` and the checksum comparison need, and no others. */
const LEDGER_SQL = "select id, checksum from app_schema_migrations where id = any($1::text[])";

/** A ledger read refused for a reason migrating (or granting) fixes, which waiting may outlast. */
const LEDGER_BEHIND: Readonly<Record<string, string>> = {
  "42P01": "no migration ledger: app_schema_migrations does not exist in this schema",
  "42501": "the runtime role cannot read the ledger: grant it SELECT on app_schema_migrations",
  "42703": "the ledger has no checksum column (written before review #86): db:app:migrate adds it",
};

function sqlState(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * Checks the database once (DEP1): identity, the schema the connection
 * resolves to, the ledger against this build (`evaluateLedger`), then Better
 * Auth's own plan. Better Auth is asked only when the ledger matches this
 * build's files, and its gaps are reported with the ledger's, so one attempt
 * names everything missing. Connection-class errors anywhere are
 * `unreachable`, retried by the loop; any other error is `fatal`.
 */
export async function checkDatabase(
  pool: Pool,
  options: GateCheckOptions,
): Promise<GateCheckResult> {
  let identity: GateIdentity | null = null;
  const warnings: string[] = [];
  const result = (status: AttemptResult["status"], reasons: string[]): GateCheckResult => ({
    status,
    reasons,
    identity,
    warnings,
  });

  try {
    const { rows } = await pool.query<{
      user_name: string;
      schema_name: string | null;
      superuser: boolean;
      ledger_owner: string | null;
    }>(IDENTITY_SQL, [options.schema]);
    const row = rows[0]!;
    identity = {
      currentUser: row.user_name,
      currentSchema: row.schema_name,
      isOwner: row.superuser || row.ledger_owner === row.user_name,
    };

    if (row.schema_name !== options.schema) {
      return result("behind", [
        `search_path resolves to ${row.schema_name ?? "no schema"}, not DB_SCHEMA ${options.schema}: the schema is missing or the runtime role's search_path default is wrong`,
      ]);
    }

    let ledgerRows: LedgerRow[];
    try {
      ({ rows: ledgerRows } = await pool.query<LedgerRow>(LEDGER_SQL, [CORE_MIGRATION_LEDGER_IDS]));
    } catch (err) {
      const behind = LEDGER_BEHIND[sqlState(err) ?? ""];
      if (behind) return result("behind", [behind]);
      throw err;
    }

    const ledger = evaluateLedger(ledgerRows, options.files);
    warnings.push(...ledger.warnings);
    if (ledger.status === "fatal") return result("fatal", ledger.reasons);

    const plan = await options.betterAuth(pool);
    const problems = [...plan.schemaProblems, ...plan.unsafeChanges];
    if (problems.length > 0) {
      return result(
        "fatal",
        problems.map((problem) => `Better Auth: ${problem}`),
      );
    }
    const gaps = [...ledger.reasons];
    if (plan.toBeCreated.length > 0) {
      gaps.push(
        `Better Auth table(s) missing: ${plan.toBeCreated.map((entry) => entry.table).join(", ")}`,
      );
    }
    if (plan.toBeAdded.length > 0) {
      const columns = plan.toBeAdded.flatMap((entry) =>
        Object.keys(entry.fields).map((field) => `${entry.table}.${field}`),
      );
      gaps.push(`Better Auth column(s) missing: ${columns.join(", ")}`);
    }
    if (plan.toBeAddedIndexes.length > 0) {
      gaps.push(
        `Better Auth index(es) missing: ${plan.toBeAddedIndexes.map((entry) => `${entry.table}.${entry.name}`).join(", ")}`,
      );
    }
    return gaps.length > 0 ? result("behind", gaps) : result("ok", []);
  } catch (err) {
    return result(isConnectionError(err) ? "unreachable" : "fatal", [describeError(err)]);
  }
}
