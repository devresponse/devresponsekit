import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitStatements } from "@/db/migration-compat";
import { normalizeMigrationSql } from "@/db/migrations/migration-plan";
import {
  FORBIDDEN_TABLE_PRIVILEGES,
  FUNCTION_GRANTS,
  LOGIN_ROLE_DEFAULTS,
  type PrivilegeFacts,
  type RuntimeRoleState,
  TABLE_GRANTS,
  TABLE_PRIVILEGES,
  comparePrivileges,
  defaultLoginName,
  describeUnexplained,
  functionSignature,
  isCleanReport,
  isKitLoginName,
  isRotatedLoginName,
  planPrivilegeRepair,
  planRuntimeReconcile,
  qualifiedFunction,
  quoteIdent,
  quoteLiteral,
  renderRepairSql,
  runtimeRoleName,
} from "@/db/runtime-privileges";
import { DEFAULT_IDLE_IN_TX_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS } from "@/db/session-defaults";

/**
 * The runtime role's privilege manifest (DEP3), its pure half: the manifest
 * against the migrations it describes, the repair plan and its SQL, the
 * reconcile's plan, the verification's comparison, the login names and the
 * role defaults. The database half is covered by
 * tests/db/runtime-role-grants.db.test.ts.
 */

const MIGRATIONS = path.join(process.cwd(), "src/db/migrations");
/** Every top-level migration file: the core files (a later 0003 included) and Better Auth's snapshot. */
const CORE_FILES = readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql"));
const read = (file: string) => readFileSync(path.join(MIGRATIONS, file), "utf8");

function createdTables(): Set<string> {
  const tables = new Set<string>();
  for (const file of CORE_FILES) {
    for (const match of normalizeMigrationSql(read(file)).matchAll(
      /\bcreate table (?:if not exists )?(?:"([^"]+)"|([a-z_][a-z0-9_]*))/gi,
    )) {
      tables.add(match[1] ?? match[2]!);
    }
  }
  return tables;
}

/** `name(type, type)` for every SECURITY DEFINER function a core migration creates. */
function securityDefinerFunctions(): Set<string> {
  const found = new Set<string>();
  for (const file of CORE_FILES) {
    for (const { text } of splitStatements(read(file))) {
      const sql = normalizeMigrationSql(text);
      const m = /^create (?:or replace )?function ([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(sql);
      if (!m) continue;
      const header = sql.slice(0, sql.search(/\bas \$/i));
      if (!/\bsecurity definer\b/i.test(header)) continue;
      const types = m[2]!
        .split(",")
        .map((arg) => arg.trim())
        .filter(Boolean)
        .map((arg) => arg.split(/\s+/).slice(1).join(" "));
      found.add(`${m[1]}(${types.join(", ")})`);
    }
  }
  return found;
}

describe("the manifest against the migrations (DEP3)", () => {
  it("lists exactly every table the migrations create, plus the ledger", () => {
    const expected = [...createdTables(), "app_schema_migrations"].sort();
    expect(expected.length).toBeGreaterThan(25);
    expect(
      Object.keys(TABLE_GRANTS).sort(),
      "a new table needs an explicit entry in TABLE_GRANTS (src/db/runtime-privileges.ts)",
    ).toEqual(expected);
  });

  it("grants EXECUTE on every SECURITY DEFINER function, and on nothing else", () => {
    const definers = securityDefinerFunctions();
    expect(definers.size).toBeGreaterThanOrEqual(2);
    expect(new Set(FUNCTION_GRANTS.map(functionSignature))).toEqual(definers);
  });

  it("tightens what v1 names: the ledger, the audit table and app_users", () => {
    expect(TABLE_GRANTS.app_schema_migrations).toEqual(["SELECT"]);
    expect(TABLE_GRANTS.app_audit_events).toEqual(["SELECT", "INSERT"]);
    expect(TABLE_GRANTS.app_users).toEqual(["SELECT", "INSERT", "UPDATE"]);
    for (const [table, privileges] of Object.entries(TABLE_GRANTS)) {
      for (const p of FORBIDDEN_TABLE_PRIVILEGES) {
        expect(privileges as readonly string[], `${table} must never hold ${p}`).not.toContain(p);
      }
    }
    for (const table of ["user", "session", "account", "verification", "rateLimit", "app_outbox"]) {
      expect(TABLE_GRANTS[table]).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
    }
  });
});

describe("names and role defaults", () => {
  it("names the group role and the default login after the schema", () => {
    expect(runtimeRoleName("auth")).toBe("auth_runtime");
    expect(defaultLoginName("auth")).toBe("auth_app");
  });

  it("recognises a kit login: <schema>_app_ and 1-24 of [a-z0-9], within 63 bytes", () => {
    expect(isKitLoginName("auth", "auth_app_ci")).toBe(true);
    expect(isKitLoginName("auth", `auth_app_${"a".repeat(24)}`)).toBe(true);
    expect(isKitLoginName("auth", `auth_app_${"a".repeat(25)}`)).toBe(false);
    expect(isKitLoginName("auth", "auth_app")).toBe(false);
    expect(isKitLoginName("auth", "auth_app_")).toBe(false);
    expect(isKitLoginName("auth", "auth_app_CI")).toBe(false);
    expect(isKitLoginName("auth", "auth_app_c-i")).toBe(false);
    // A satellite's login, another schema's, and the group role are not kit logins.
    expect(isKitLoginName("auth", "auth_sat_x")).toBe(false);
    expect(isKitLoginName("auth", "tenant_app_x")).toBe(false);
    expect(isKitLoginName("auth", "auth_runtime")).toBe(false);
    // 63 bytes is Postgres's identifier limit: past it, the name is truncated.
    const schema = "s".repeat(34);
    expect(isKitLoginName(schema, `${schema}_app_${"a".repeat(24)}`)).toBe(true); // 63 bytes
    expect(isKitLoginName(`${schema}x`, `${schema}x_app_${"a".repeat(24)}`)).toBe(false); // 64
  });

  it("recognises the rotation form: <schema>_app_ and 12 digits", () => {
    expect(isRotatedLoginName("auth", "auth_app_202610011200")).toBe(true);
    expect(isRotatedLoginName("auth", "auth_app_20261001120")).toBe(false);
    expect(isRotatedLoginName("auth", "auth_app_2026100112000")).toBe(false);
    expect(isRotatedLoginName("auth", "auth_app_ci")).toBe(false);
    expect(isRotatedLoginName("s".repeat(50), `${"s".repeat(50)}_app_202610011200`)).toBe(false);
  });

  it("the login's role defaults are the runtime pool's defaults, from one module", async () => {
    const defaults = LOGIN_ROLE_DEFAULTS("auth");
    expect(defaults).toEqual([
      { name: "search_path", sql: '"auth", public' },
      { name: "statement_timeout", sql: "'30000ms'", shown: "30s" },
      { name: "idle_in_transaction_session_timeout", sql: "'30000ms'", shown: "30s" },
    ]);
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_IDLE_IN_TX_TIMEOUT_MS).toBe(30_000);
    // database.ts sends the same numbers as startup parameters when nothing
    // overrides them: build its pool with neither variable set and read them.
    vi.resetModules();
    vi.stubEnv("PG_STATEMENT_TIMEOUT_MS", undefined);
    vi.stubEnv("PG_IDLE_IN_TX_TIMEOUT_MS", undefined);
    vi.stubEnv("DB_SEARCH_PATH_VIA_OPTIONS", undefined);
    const { pgPool } = await import("@/db/database");
    const options = (pgPool as unknown as { options: Record<string, unknown> }).options;
    expect(options.statement_timeout).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
    expect(options.idle_in_transaction_session_timeout).toBe(DEFAULT_IDLE_IN_TX_TIMEOUT_MS);
    await pgPool.end();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("quoting", () => {
  it("double-quotes identifiers and single-quotes literals, doubling the quote", () => {
    expect(quoteIdent("user")).toBe('"user"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(() => quoteIdent("")).toThrow("invalid SQL identifier");
    expect(() => quoteIdent("a\0b")).toThrow("invalid SQL identifier");
    expect(() => quoteLiteral("a\0b")).toThrow("invalid SQL literal");
    expect(qualifiedFunction("auth", FUNCTION_GRANTS[0]!)).toBe(
      '"auth"."app_audit_events_prune"(integer, integer)',
    );
  });
});

describe("planPrivilegeRepair and renderRepairSql", () => {
  it("revokes an extra ledger INSERT", () => {
    const plan = planPrivilegeRepair(
      { app_schema_migrations: ["SELECT", "INSERT"] },
      { app_schema_migrations: ["SELECT"] },
    );
    expect(plan).toEqual({
      grants: [],
      revokes: [{ table: "app_schema_migrations", privileges: ["INSERT"] }],
    });
  });

  it("grants a missing session SELECT", () => {
    const plan = planPrivilegeRepair(
      { session: ["INSERT", "UPDATE", "DELETE"] },
      { session: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
    );
    expect(plan).toEqual({ grants: [{ table: "session", privileges: ["SELECT"] }], revokes: [] });
  });

  it("revokes TRUNCATE, and leaves absent tables and unlisted ones alone", () => {
    const plan = planPrivilegeRepair(
      { app_outbox: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"], stray: ["SELECT"] },
      { app_outbox: ["SELECT", "INSERT", "UPDATE", "DELETE"], rateLimit: ["SELECT"] },
    );
    expect(plan).toEqual({
      grants: [],
      revokes: [{ table: "app_outbox", privileges: ["TRUNCATE"] }],
    });
  });

  it("is empty for a role already at the manifest", () => {
    const direct = Object.fromEntries(Object.entries(TABLE_GRANTS));
    expect(planPrivilegeRepair(direct, TABLE_GRANTS)).toEqual({ grants: [], revokes: [] });
  });

  it("renders revokes then grants, quoting every identifier", () => {
    expect(
      renderRepairSql("auth", "auth_runtime", {
        grants: [
          { table: "user", privileges: ["SELECT", "UPDATE"] },
          { table: "rateLimit", privileges: ["INSERT"] },
        ],
        revokes: [{ table: "app_users", privileges: ["DELETE", "TRUNCATE"] }],
      }),
    ).toEqual([
      'revoke delete, truncate on "auth"."app_users" from "auth_runtime"',
      'grant select, update on "auth"."user" to "auth_runtime"',
      'grant insert on "auth"."rateLimit" to "auth_runtime"',
    ]);
  });

  it("refuses a privilege that is not one of the known words", () => {
    expect(() =>
      renderRepairSql("auth", "r", {
        grants: [{ table: "t", privileges: ["SELECT; drop table x" as never] }],
        revokes: [],
      }),
    ).toThrow("unknown table privilege");
  });
});

/** The catalog of a role reconciled exactly to the manifest. */
function steadyState(): RuntimeRoleState {
  return {
    tables: Object.entries(TABLE_GRANTS).map(([table, privileges]) => ({
      table,
      direct: privileges,
      publicGrants: [],
      effective: privileges,
    })),
    schemaDirect: ["USAGE"],
    functions: FUNCTION_GRANTS.map((fn) => ({
      signature: functionSignature(fn),
      present: true,
      direct: ["EXECUTE"],
    })),
    defaultAcl: {
      tables: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      sequences: ["USAGE", "SELECT"],
    },
  };
}

describe("planRuntimeReconcile", () => {
  it("issues nothing on a steady-state role", () => {
    expect(planRuntimeReconcile("auth", "auth_runtime", steadyState())).toEqual({
      statements: [],
      grants: 0,
      revokes: 0,
      unlisted: [],
      unexplained: [],
    });
  });

  it("repairs 0005's grants to v1: the ledger's writes and app_users DELETE go", () => {
    const state = steadyState();
    state.tables = state.tables.map((t) =>
      t.table === "app_schema_migrations" || t.table === "app_users"
        ? {
            ...t,
            direct: ["SELECT", "INSERT", "UPDATE", "DELETE"],
            effective: ["SELECT", "INSERT", "UPDATE", "DELETE"],
          }
        : t,
    );
    const plan = planRuntimeReconcile("auth", "auth_runtime", state);
    expect(plan.statements).toEqual([
      'revoke insert, update, delete on "auth"."app_schema_migrations" from "auth_runtime"',
      'revoke delete on "auth"."app_users" from "auth_runtime"',
    ]);
    expect([plan.grants, plan.revokes]).toEqual([0, 2]);
  });

  it("re-asserts schema USAGE, function EXECUTE and the default privileges only when missing", () => {
    const state = steadyState();
    state.schemaDirect = ["CREATE"];
    state.functions = [
      { signature: "app_audit_events_prune(integer, integer)", present: true, direct: [] },
      { signature: "app_users_pseudonymise(uuid)", present: false, direct: [] },
    ];
    state.defaultAcl = { tables: ["SELECT"], sequences: [] };
    const plan = planRuntimeReconcile("auth", "auth_runtime", state);
    expect(plan.statements).toEqual([
      'grant usage on schema "auth" to "auth_runtime"',
      'revoke create on schema "auth" from "auth_runtime"',
      'grant execute on function "auth"."app_audit_events_prune"(integer, integer) to "auth_runtime"',
      'alter default privileges in schema "auth" grant select, insert, update, delete on tables to "auth_runtime"',
      'alter default privileges in schema "auth" grant usage, select on sequences to "auth_runtime"',
    ]);
    expect([plan.grants, plan.revokes]).toEqual([4, 1]);
  });

  it("reports an unlisted table and never touches it", () => {
    const state = steadyState();
    state.tables = [
      ...state.tables,
      { table: "stray", direct: ["TRUNCATE"], publicGrants: [], effective: ["TRUNCATE"] },
    ];
    const plan = planRuntimeReconcile("auth", "auth_runtime", state);
    expect(plan.unlisted).toEqual(["stray"]);
    expect(plan.statements).toEqual([]);
  });

  it("flags a forbidden privilege no direct grant explains, naming PUBLIC or a membership", () => {
    const state = steadyState();
    state.tables = state.tables.map((t) =>
      t.table === "app_users"
        ? { ...t, publicGrants: ["DELETE"], effective: ["SELECT", "INSERT", "UPDATE", "DELETE"] }
        : t.table === "app_schema_migrations"
          ? { ...t, effective: ["SELECT", "INSERT"] }
          : t,
    );
    const plan = planRuntimeReconcile("auth", "auth_runtime", state);
    expect(plan.unexplained).toEqual([
      { table: "app_schema_migrations", privilege: "INSERT", fromPublic: false },
      { table: "app_users", privilege: "DELETE", fromPublic: true },
    ]);
    expect(describeUnexplained("auth_runtime", plan.unexplained, ["pg_write_all_data"])).toBe(
      "auth_runtime holds INSERT on app_schema_migrations through membership in pg_write_all_data: revoke that membership, or that role's grant; " +
        "auth_runtime holds DELETE on app_users through PUBLIC: revoke delete on app_users from public, as the owner",
    );
    expect(describeUnexplained("r", [plan.unexplained[0]!], [])).toContain(
      "through membership in a role it is a member of",
    );
  });

  it("flags a forbidden privilege granted directly AND to PUBLIC: the revoke would leave it", () => {
    const state = steadyState();
    state.tables = state.tables.map((t) =>
      t.table === "app_outbox"
        ? {
            ...t,
            direct: [...t.direct, "TRUNCATE"],
            publicGrants: ["TRUNCATE"],
            effective: [...t.effective, "TRUNCATE"],
          }
        : t,
    );
    expect(planRuntimeReconcile("auth", "auth_runtime", state).unexplained).toEqual([
      { table: "app_outbox", privilege: "TRUNCATE", fromPublic: true },
    ]);
  });
});

/** The facts of a login that holds exactly the manifest. */
function cleanFacts(): PrivilegeFacts {
  return {
    tables: Object.entries(TABLE_GRANTS).map(([table, privileges]) => ({ table, privileges })),
    functions: Object.fromEntries(FUNCTION_GRANTS.map((fn) => [functionSignature(fn), true])),
    schemaUsage: true,
    schemaCreate: false,
    publicCreate: false,
    databaseCreate: false,
    attributes: [],
    memberships: [],
  };
}

describe("comparePrivileges", () => {
  it("reports nothing for a login at the manifest", () => {
    const report = comparePrivileges("auth", cleanFacts());
    expect(report).toEqual({ missing: [], forbidden: [], attributes: [], memberships: [] });
    expect(isCleanReport(report)).toBe(true);
  });

  it("names what is missing and what is forbidden, an unlisted table included", () => {
    const facts = cleanFacts();
    facts.tables = [
      ...facts.tables.map((t) =>
        t.table === "session"
          ? { table: "session", privileges: ["INSERT", "UPDATE", "DELETE"] as const }
          : t.table === "app_schema_migrations"
            ? { table: t.table, privileges: ["SELECT", "INSERT"] as const }
            : t.table === "app_outbox"
              ? { table: t.table, privileges: [...TABLE_PRIVILEGES] }
              : t,
      ),
      { table: "stray", privileges: ["SELECT"] },
    ];
    facts.functions = {
      "app_audit_events_prune(integer, integer)": false,
      "app_users_pseudonymise(uuid)": null,
    };
    facts.schemaUsage = false;
    facts.schemaCreate = true;
    facts.publicCreate = true;
    facts.databaseCreate = true;
    facts.attributes = ["rolsuper", "rolbypassrls", "rolother"];
    facts.memberships = ["auth_owner", "pg_write_all_data"];
    const report = comparePrivileges("auth", facts);
    expect(report.missing).toEqual([
      "SELECT on session",
      "EXECUTE on app_audit_events_prune(integer, integer)",
      "EXECUTE on app_users_pseudonymise(uuid) (absent)",
      "USAGE on schema auth",
    ]);
    expect(report.forbidden).toEqual([
      "INSERT on app_schema_migrations",
      "TRUNCATE on app_outbox",
      "REFERENCES on app_outbox",
      "TRIGGER on app_outbox",
      "SELECT on stray",
      "CREATE on schema auth",
      "CREATE on schema public",
      "CREATE on the database",
    ]);
    expect(report.attributes).toEqual(["SUPERUSER", "BYPASSRLS", "rolother"]);
    expect(report.memberships).toEqual(["auth_owner", "pg_write_all_data"]);
    expect(isCleanReport(report)).toBe(false);
  });

  it("skips a manifest table that does not exist yet", () => {
    const facts = cleanFacts();
    facts.tables = facts.tables.filter((t) => t.table !== "rateLimit");
    expect(isCleanReport(comparePrivileges("auth", facts))).toBe(true);
  });
});
