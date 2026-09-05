import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_STATUS_VALUES,
  APP_USER_STATUS_VALUES,
  CREDENTIAL_STATUS_VALUES,
  MEMBERSHIP_STATUS_VALUES,
  ORGANIZATION_STATUSES,
} from "@/lib/status-values";

/**
 * Drift guard between the status CHECK constraints migration 0004 adds
 * (review #217 / #63) and the TypeScript enums the runtime validates against
 * (`src/lib/status-values.ts`). Same pattern as
 * `migration-permission-catalog-sync.test.ts`: parse the SQL, diff in BOTH
 * directions. A value added to the TS enum without a forward migration would
 * be rejected by the database; a value added to the SQL without the enum
 * would be accepted by the database and mis-handled by the runtime (the
 * boundary coercion in auth-status.ts fails closed on it). Either way this
 * test fails first.
 *
 * Both the constraint's DDL and the migration's PREFLIGHT (the query that
 * lists violating rows before anything changes) carry the value list, and the
 * two must agree — otherwise the preflight could pass rows the CHECK then
 * rejects (or vice versa), so both are parsed.
 */
const MIGRATION = path.resolve(__dirname, "../../src/db/migrations/0004-integrity-constraints.sql");
const sql = readFileSync(MIGRATION, "utf8");

/** table.column → the values the runtime allows. */
const EXPECTED: ReadonlyArray<[table: string, column: string, values: readonly string[]]> = [
  ["app_organizations", "status", ORGANIZATION_STATUSES],
  ["app_users", "status", APP_USER_STATUS_VALUES],
  ["app_organization_memberships", "status", MEMBERSHIP_STATUS_VALUES],
  ["app_organization_memberships", "pre_deactivation_status", MEMBERSHIP_STATUS_VALUES],
  ["app_enterprise_applications", "status", APP_STATUS_VALUES],
  ["app_api_keys", "status", CREDENTIAL_STATUS_VALUES],
  ["app_oauth_clients", "status", CREDENTIAL_STATUS_VALUES],
];

function parseValueList(list: string): string[] {
  return [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

/** `add constraint <table>_<column>_check check (… <column> in ('a', 'b'))`. */
function constraintValues(table: string, column: string): string[] | null {
  const re = new RegExp(
    String.raw`alter table ${table} add constraint ${table}_${column}_check\s+check \((?:${column} is null or )?${column} in \(([^)]*)\)\)`,
  );
  const m = sql.match(re);
  return m ? parseValueList(m[1]!) : null;
}

/** The preflight's `where <column> not in (…)` for the same table.column. */
function preflightValues(table: string, column: string): string[] | null {
  const re = new RegExp(
    String.raw`select '${table}', '${column}', ${column}, count\(\*\)\s+from ${table}\s+where (?:${column} is not null\s+and )?${column} not in \(([^)]*)\)`,
  );
  // The first union branch has `as` aliases; normalise them away.
  const normalised = sql.replace(
    /select 'app_organizations' as tbl, 'status' as col, status as val, count\(\*\) as n/,
    "select 'app_organizations', 'status', status, count(*)",
  );
  const m = normalised.match(re);
  return m ? parseValueList(m[1]!) : null;
}

describe("0004 status CHECK constraints ↔ src/lib/status-values.ts (review #217)", () => {
  it("parses every expected constraint (guards against the DDL shape drifting past the regex)", () => {
    for (const [table, column] of EXPECTED) {
      expect(
        constraintValues(table, column),
        `no CHECK found for ${table}.${column}`,
      ).not.toBeNull();
      expect(
        preflightValues(table, column),
        `no preflight found for ${table}.${column}`,
      ).not.toBeNull();
    }
  });

  it.each(EXPECTED)("%s.%s CHECK matches the TS enum exactly", (table, column, values) => {
    expect(constraintValues(table, column)).toEqual([...values]);
  });

  it.each(EXPECTED)("%s.%s preflight uses the same list as its CHECK", (table, column) => {
    expect(preflightValues(table, column)).toEqual(constraintValues(table, column));
  });

  it("enterprise-app status has ONE state model — no `degraded` anywhere (review #63)", () => {
    expect(APP_STATUS_VALUES).not.toContain("degraded");
    expect(sql).not.toMatch(/'degraded'/);
  });

  it("lowercases invitation email at the schema level", () => {
    expect(sql).toMatch(
      /add constraint app_organization_invitations_email_lower_check\s+check \(email = lower\(email\)\)/,
    );
  });
});
