import { DEFAULT_IDLE_IN_TX_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS } from "./session-defaults";

/**
 * What the least-privilege runtime role may do: the one source of truth
 * (DEP3, docs/deployment.md §8).
 *
 * Migration 0005 (its section of `0002-release.sql`) creates the NOLOGIN group
 * role `<DB_SCHEMA>_runtime` and grants it whole-schema DML once. Nothing kept
 * it there afterwards: a table Better Auth's own migrator created, a grant an
 * operator made by hand, or a privilege 0005 never meant to give (writing the
 * migration ledger, deleting `app_users`) stayed as it was. Now every `pnpm
 * db:app:migrate` ends by reconciling the role to {@link TABLE_GRANTS},
 * {@link FUNCTION_GRANTS} and {@link SCHEMA_PRIVILEGES}
 * (`reconcileRuntimePrivileges` in `migrations/runtime-privileges-db.ts`), the
 * production build's schema gate proves the runtime login holds exactly them
 * before it promotes, and `pnpm db:runtime-login` creates the LOGIN roles that
 * inherit the group (`runtime-login.ts`).
 *
 * v1 tightens only the ledger (SELECT), the audit table (SELECT, INSERT) and
 * `app_users` (no DELETE), together with the forbidden list below; every other
 * table keeps full DML. Narrower per-table grants are a follow-up. A NEW table
 * must get an explicit entry here: `tests/unit/runtime-privileges.test.ts`
 * fails on a `create table` this map does not list, and the gate treats any
 * privilege on an unlisted table as forbidden.
 *
 * Pure: no `pg`, no environment read, so all of it is unit-tested.
 */

/** A table privilege the manifest may grant. */
export type GrantablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
/** Every table privilege Postgres knows, granted or forbidden. */
export type TablePrivilege = GrantablePrivilege | "TRUNCATE" | "REFERENCES" | "TRIGGER";

/** Every table privilege, in the order the reconcile and the gate read them. */
export const TABLE_PRIVILEGES: readonly TablePrivilege[] = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

/** Never granted to the runtime role or a login, on any table. */
export const FORBIDDEN_TABLE_PRIVILEGES: readonly TablePrivilege[] = [
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

const FULL_DML: readonly GrantablePrivilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/**
 * Every table in DB_SCHEMA and what the runtime role holds on it, keyed by the
 * exact identifier (Better Auth's are case-sensitive: `rateLimit`).
 */
export const TABLE_GRANTS: Readonly<Record<string, readonly GrantablePrivilege[]>> = {
  // Readiness and the gate only read it. A write could forge readiness, or
  // make a later migrate skip a file it never applied.
  app_schema_migrations: ["SELECT"],
  // Append-only (review #83): rows leave only through the owner-owned
  // app_audit_events_prune, and change only through the erasure function.
  app_audit_events: ["SELECT", "INSERT"],
  // No runtime path deletes a user: erasure goes through the SECURITY
  // DEFINER app_users_pseudonymise, and nothing calls deleteFrom("app_users").
  app_users: ["SELECT", "INSERT", "UPDATE"],
  app_api_keys: FULL_DML,
  app_email_templates: FULL_DML,
  app_enterprise_applications: FULL_DML,
  app_group_memberships: FULL_DML,
  app_group_roles: FULL_DML,
  app_groups: FULL_DML,
  app_oauth_clients: FULL_DML,
  app_organization_auth_settings: FULL_DML,
  app_organization_invitations: FULL_DML,
  app_organization_memberships: FULL_DML,
  app_organizations: FULL_DML,
  app_outbox: FULL_DML,
  app_permissions: FULL_DML,
  app_provider_organizations: FULL_DML,
  app_rate_limits: FULL_DML,
  app_revoked_tokens: FULL_DML,
  app_role_permissions: FULL_DML,
  app_roles: FULL_DML,
  app_sso_handoff_nonces: FULL_DML,
  app_user_locale_preferences: FULL_DML,
  app_user_roles: FULL_DML,
  // Better Auth's tables, created by `pnpm db:auth:migrate` outside the ledger.
  user: FULL_DML,
  session: FULL_DML,
  account: FULL_DML,
  verification: FULL_DML,
  rateLimit: FULL_DML,
};

/** A function the runtime role may EXECUTE: its name and argument types, as Postgres prints them. */
export interface FunctionGrant {
  name: string;
  args: readonly string[];
}

/** The SECURITY DEFINER functions, the runtime role's only way past its table grants. */
export const FUNCTION_GRANTS: readonly FunctionGrant[] = [
  { name: "app_audit_events_prune", args: ["integer", "integer"] },
  { name: "app_users_pseudonymise", args: ["uuid"] },
];

/** What the runtime role holds on DB_SCHEMA itself: never CREATE. */
export const SCHEMA_PRIVILEGES = ["USAGE"] as const;

/** Role attributes the runtime role and every login must not have, by their `pg_roles` column. */
export const FORBIDDEN_ATTRIBUTES: Readonly<Record<string, string>> = {
  rolsuper: "SUPERUSER",
  rolcreaterole: "CREATEROLE",
  rolcreatedb: "CREATEDB",
  rolreplication: "REPLICATION",
  rolbypassrls: "BYPASSRLS",
};

/**
 * Roles whose membership would bypass the grants above. The ledger's owner
 * is added at run time. `neon_superuser` exists only on Neon: a role made in
 * the Neon Console, API or CLI joins it, and it holds `pg_write_all_data`.
 */
export const FORBIDDEN_MEMBERSHIPS: readonly string[] = [
  "pg_write_all_data",
  "pg_read_all_data",
  "neon_superuser",
  "pg_signal_backend",
];

/** `<schema>_runtime`, the NOLOGIN group role 0005 creates. */
export function runtimeRoleName(schema: string): string {
  return `${schema}_runtime`;
}

/** `<schema>_app`, the login `pnpm db:runtime-login` creates unless told otherwise. */
export function defaultLoginName(schema: string): string {
  return `${schema}_app`;
}

/** Postgres truncates identifiers past 63 bytes, so a longer name is not the role it names. */
const MAX_IDENTIFIER_BYTES = 63;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const fitsIdentifier = (name: string) => Buffer.byteLength(name, "utf8") <= MAX_IDENTIFIER_BYTES;

/**
 * A login name the kit may create for `schema`: `<schema>_app_` and 1 to 24
 * lower-case letters or digits, at most 63 bytes. A satellite's login
 * (`auth_sat_x`) or any other role is not one, so the command never alters a
 * role it does not own by convention.
 */
export function isKitLoginName(schema: string, name: string): boolean {
  return (
    new RegExp(`^${escapeRegExp(schema)}_app_[a-z0-9]{1,24}$`).test(name) && fitsIdentifier(name)
  );
}

/** The rotation form of a kit login: `<schema>_app_` and a 12-digit timestamp. */
export function isRotatedLoginName(schema: string, name: string): boolean {
  return new RegExp(`^${escapeRegExp(schema)}_app_\\d{12}$`).test(name) && fitsIdentifier(name);
}

/** One `alter role … in database … set` the login needs. */
export interface RoleDefault {
  name: "search_path" | "statement_timeout" | "idle_in_transaction_session_timeout";
  /** The value as SQL text, ready to follow `set <name> to`. */
  sql: string;
  /**
   * What `show <name>` answers once the default is in effect. Absent for
   * search_path, whose quoting Postgres decides: verify it by
   * `current_schema()`.
   */
  shown?: string;
}

/** How `show` prints a millisecond setting: in the largest unit that divides it (60000 is `1min`). */
const SHOWN_UNITS = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["min", 60_000],
  ["s", 1000],
] as const;
const shownMs = (ms: number) => {
  for (const [unit, size] of SHOWN_UNITS) if (ms % size === 0) return `${ms / size}${unit}`;
  return `${ms}ms`;
};

/**
 * The role defaults a pooled connection needs, set on the LOGIN (role
 * settings are not inherited through membership). A transaction pooler
 * refuses the startup parameters that carry them otherwise
 * (`DB_SEARCH_PATH_VIA_OPTIONS=0`). The numbers are the runtime pool's own
 * defaults.
 */
export function LOGIN_ROLE_DEFAULTS(schema: string): readonly RoleDefault[] {
  return [
    { name: "search_path", sql: `${quoteIdent(schema)}, public` },
    {
      name: "statement_timeout",
      sql: quoteLiteral(`${DEFAULT_STATEMENT_TIMEOUT_MS}ms`),
      shown: shownMs(DEFAULT_STATEMENT_TIMEOUT_MS),
    },
    {
      name: "idle_in_transaction_session_timeout",
      sql: quoteLiteral(`${DEFAULT_IDLE_IN_TX_TIMEOUT_MS}ms`),
      shown: shownMs(DEFAULT_IDLE_IN_TX_TIMEOUT_MS),
    },
  ];
}

/** An identifier, double-quoted: the only way a name reaches the SQL this module renders. */
export function quoteIdent(name: string): string {
  if (name.length === 0 || name.includes("\0")) throw new Error("invalid SQL identifier");
  return `"${name.replace(/"/g, '""')}"`;
}

/** A string literal, single-quoted (standard_conforming_strings, Postgres's default since 9.1). */
export function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("invalid SQL literal");
  return `'${value.replace(/'/g, "''")}'`;
}

/** `"<schema>"."<name>"(<args>)`, for a grant. */
export function qualifiedFunction(schema: string, fn: FunctionGrant): string {
  return `${quoteIdent(schema)}.${quoteIdent(fn.name)}(${fn.args.join(", ")})`;
}

/** `name(args)`, as the manifest and the reports name a function. */
export function functionSignature(fn: FunctionGrant): string {
  return `${fn.name}(${fn.args.join(", ")})`;
}

/* ------------------------------------------------------------------ */
/*  Repair: from direct ACL entries to the manifest                     */
/* ------------------------------------------------------------------ */

/** Privileges on one table. */
export interface TablePrivileges {
  table: string;
  privileges: readonly TablePrivilege[];
}

/** What it takes to bring the role's direct grants to the manifest. */
export interface PrivilegeRepair {
  grants: TablePrivileges[];
  revokes: TablePrivileges[];
}

/**
 * The grants and revokes that bring `actualDirect` (the privileges granted to
 * the role itself, per existing table, from `aclexplode(relacl)`) to
 * `manifest`. Only tables present in both are planned: a manifest table that
 * does not exist yet (Better Auth's, before `db:auth:migrate`) has nothing to
 * repair, and a table the manifest does not list is the caller's to report,
 * not to touch. Ordered by the manifest, privileges by {@link TABLE_PRIVILEGES}.
 */
export function planPrivilegeRepair(
  actualDirect: Readonly<Record<string, readonly TablePrivilege[]>>,
  manifest: Readonly<Record<string, readonly TablePrivilege[]>>,
): PrivilegeRepair {
  const repair: PrivilegeRepair = { grants: [], revokes: [] };
  for (const [table, wanted] of Object.entries(manifest)) {
    const actual = actualDirect[table];
    if (actual === undefined) continue;
    const grant = TABLE_PRIVILEGES.filter((p) => wanted.includes(p) && !actual.includes(p));
    const revoke = TABLE_PRIVILEGES.filter((p) => actual.includes(p) && !wanted.includes(p));
    if (grant.length > 0) repair.grants.push({ table, privileges: grant });
    if (revoke.length > 0) repair.revokes.push({ table, privileges: revoke });
  }
  return repair;
}

const privilegeList = (privileges: readonly TablePrivilege[]) => {
  for (const p of privileges) {
    // A privilege reaches the SQL only by being one of the known words.
    if (!TABLE_PRIVILEGES.includes(p)) throw new Error(`unknown table privilege ${String(p)}`);
  }
  return privileges.map((p) => p.toLowerCase()).join(", ");
};

/**
 * The statements for `plan`, revokes first. Every identifier goes through
 * {@link quoteIdent}; nothing else is interpolated.
 */
export function renderRepairSql(schema: string, role: string, plan: PrivilegeRepair): string[] {
  const on = (table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;
  return [
    ...plan.revokes.map(
      ({ table, privileges }) =>
        `revoke ${privilegeList(privileges)} on ${on(table)} from ${quoteIdent(role)}`,
    ),
    ...plan.grants.map(
      ({ table, privileges }) =>
        `grant ${privilegeList(privileges)} on ${on(table)} to ${quoteIdent(role)}`,
    ),
  ];
}

/* ------------------------------------------------------------------ */
/*  Verification: effective privileges against the manifest             */
/* ------------------------------------------------------------------ */

/** What a role actually holds, effective privileges included, as `verifyCurrentUserPrivileges` reads it. */
export interface PrivilegeFacts {
  /** Every table in DB_SCHEMA with the privileges the role holds on it, from any source. */
  tables: readonly TablePrivileges[];
  /** Each manifest function: true/false for EXECUTE, or null when the function does not exist. */
  functions: Readonly<Record<string, boolean | null>>;
  schemaUsage: boolean;
  schemaCreate: boolean;
  /** CREATE on `public`; false when there is no `public` schema. */
  publicCreate: boolean;
  databaseCreate: boolean;
  /** The forbidden attributes the role has, by `pg_roles` column. */
  attributes: readonly string[];
  /** The forbidden roles (ledger owner included) the role is a member of. */
  memberships: readonly string[];
}

/** Each list empty means the role holds exactly the manifest. */
export interface PrivilegeReport {
  /** Manifest privileges the role lacks: `SELECT on session`. */
  missing: string[];
  /** Privileges it holds that the manifest forbids: `INSERT on app_schema_migrations`. */
  forbidden: string[];
  /** Forbidden attributes: `SUPERUSER`. */
  attributes: string[];
  /** Forbidden memberships: `pg_write_all_data`. */
  memberships: string[];
}

/**
 * Compares effective privileges with the manifest. Missing means a grant the
 * reconcile would add; forbidden means a privilege outside the manifest on any
 * table (an unlisted one included), TRUNCATE, REFERENCES or TRIGGER anywhere,
 * or CREATE on DB_SCHEMA, `public` or the database.
 */
export function comparePrivileges(
  schema: string,
  facts: PrivilegeFacts,
  manifest: Readonly<Record<string, readonly TablePrivilege[]>> = TABLE_GRANTS,
): PrivilegeReport {
  const report: PrivilegeReport = { missing: [], forbidden: [], attributes: [], memberships: [] };
  const held = new Map(facts.tables.map((t) => [t.table, t.privileges]));
  for (const [table, wanted] of Object.entries(manifest)) {
    const actual = held.get(table);
    if (actual === undefined) continue;
    for (const p of wanted) if (!actual.includes(p)) report.missing.push(`${p} on ${table}`);
  }
  for (const { table, privileges } of facts.tables) {
    const allowed = manifest[table] ?? [];
    for (const p of TABLE_PRIVILEGES) {
      if (privileges.includes(p) && !allowed.includes(p)) {
        report.forbidden.push(`${p} on ${table}`);
      }
    }
  }
  for (const fn of FUNCTION_GRANTS) {
    const signature = functionSignature(fn);
    const can = facts.functions[signature];
    if (can === null || can === undefined) report.missing.push(`EXECUTE on ${signature} (absent)`);
    else if (!can) report.missing.push(`EXECUTE on ${signature}`);
  }
  if (!facts.schemaUsage) report.missing.push(`USAGE on schema ${schema}`);
  if (facts.schemaCreate) report.forbidden.push(`CREATE on schema ${schema}`);
  if (facts.publicCreate) report.forbidden.push("CREATE on schema public");
  if (facts.databaseCreate) report.forbidden.push("CREATE on the database");
  for (const column of facts.attributes)
    report.attributes.push(FORBIDDEN_ATTRIBUTES[column] ?? column);
  report.memberships.push(...facts.memberships);
  return report;
}

/** Whether a report found nothing. */
export function isCleanReport(report: PrivilegeReport): boolean {
  return (
    report.missing.length === 0 &&
    report.forbidden.length === 0 &&
    report.attributes.length === 0 &&
    report.memberships.length === 0
  );
}

/* ------------------------------------------------------------------ */
/*  The reconcile's plan                                                */
/* ------------------------------------------------------------------ */

/** The runtime role as the catalog shows it, read by `reconcileRuntimePrivileges`. */
export interface RuntimeRoleState {
  /** Every table in DB_SCHEMA. */
  tables: ReadonlyArray<{
    table: string;
    /** Granted to the role itself (`aclexplode(relacl)`, grantee = the role). */
    direct: readonly TablePrivilege[];
    /** Granted to PUBLIC on that table. */
    publicGrants: readonly TablePrivilege[];
    /** What `has_table_privilege(role, …)` answers: direct, PUBLIC and memberships together. */
    effective: readonly TablePrivilege[];
  }>;
  /** The schema privileges granted to the role itself (`USAGE`, `CREATE`). */
  schemaDirect: readonly string[];
  /** Each manifest function, by {@link functionSignature}: whether it exists, and EXECUTE granted to the role itself. */
  functions: ReadonlyArray<{ signature: string; present: boolean; direct: readonly string[] }>;
  /** The current user's default privileges in DB_SCHEMA for the role, for tables and sequences. */
  defaultAcl: { tables: readonly string[]; sequences: readonly string[] };
}

/** A privilege the role holds on a manifest table, outside the manifest, that no direct grant explains. */
export interface UnexplainedPrivilege {
  table: string;
  privilege: TablePrivilege;
  /** PUBLIC holds it on that table; otherwise it comes through a membership. */
  fromPublic: boolean;
}

export interface ReconcilePlan {
  /** Revokes, then grants, then the schema, the functions and the default privileges. */
  statements: string[];
  grants: number;
  revokes: number;
  /** Tables in DB_SCHEMA the manifest does not list: reported, never touched. */
  unlisted: string[];
  /** Must be empty before anything is applied: a revoke cannot remove these. */
  unexplained: UnexplainedPrivilege[];
}

const DEFAULT_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const DEFAULT_SEQUENCE_PRIVILEGES = ["USAGE", "SELECT"];

/**
 * Every statement that brings the role to the manifest, and nothing for a role
 * already there: table grants and revokes ({@link planPrivilegeRepair}), USAGE
 * on the schema and never CREATE, EXECUTE on each manifest function that
 * exists, and the current user's default privileges for tables a later
 * migration creates (0005's, re-asserted only when missing).
 */
export function planRuntimeReconcile(
  schema: string,
  role: string,
  state: RuntimeRoleState,
): ReconcilePlan {
  const manifestTables = new Set(Object.keys(TABLE_GRANTS));
  const direct: Record<string, readonly TablePrivilege[]> = {};
  const unlisted: string[] = [];
  const unexplained: UnexplainedPrivilege[] = [];
  for (const t of state.tables) {
    if (!manifestTables.has(t.table)) {
      unlisted.push(t.table);
      continue;
    }
    direct[t.table] = t.direct;
    const allowed = TABLE_GRANTS[t.table]!;
    for (const p of t.effective) {
      // A revoke removes only the direct grant: one PUBLIC also holds stays.
      const revocable = t.direct.includes(p) && !t.publicGrants.includes(p);
      if (!allowed.includes(p as GrantablePrivilege) && !revocable) {
        unexplained.push({ table: t.table, privilege: p, fromPublic: t.publicGrants.includes(p) });
      }
    }
  }

  const repair = planPrivilegeRepair(direct, TABLE_GRANTS);
  const statements = renderRepairSql(schema, role, repair);
  let grants = repair.grants.length;
  let revokes = repair.revokes.length;
  const to = quoteIdent(role);

  if (!state.schemaDirect.includes("USAGE")) {
    statements.push(`grant usage on schema ${quoteIdent(schema)} to ${to}`);
    grants++;
  }
  if (state.schemaDirect.includes("CREATE")) {
    statements.push(`revoke create on schema ${quoteIdent(schema)} from ${to}`);
    revokes++;
  }
  for (const fn of FUNCTION_GRANTS) {
    const found = state.functions.find((f) => f.signature === functionSignature(fn));
    if (found?.present && !found.direct.includes("EXECUTE")) {
      statements.push(`grant execute on function ${qualifiedFunction(schema, fn)} to ${to}`);
      grants++;
    }
  }
  if (!DEFAULT_TABLE_PRIVILEGES.every((p) => state.defaultAcl.tables.includes(p))) {
    statements.push(
      `alter default privileges in schema ${quoteIdent(schema)} grant select, insert, update, delete on tables to ${to}`,
    );
    grants++;
  }
  if (!DEFAULT_SEQUENCE_PRIVILEGES.every((p) => state.defaultAcl.sequences.includes(p))) {
    statements.push(
      `alter default privileges in schema ${quoteIdent(schema)} grant usage, select on sequences to ${to}`,
    );
    grants++;
  }
  return { statements, grants, revokes, unlisted, unexplained };
}

/**
 * One clause per unexplained privilege, naming where it comes from and what
 * removes it. `memberOf` lists the roles whose privileges the role inherits.
 */
export function describeUnexplained(
  role: string,
  items: readonly UnexplainedPrivilege[],
  memberOf: readonly string[],
): string {
  const through = memberOf.length > 0 ? memberOf.join(", ") : "a role it is a member of";
  return items
    .map(({ table, privilege, fromPublic }) =>
      fromPublic
        ? `${role} holds ${privilege} on ${table} through PUBLIC: revoke ${privilege.toLowerCase()} on ${table} from public, as the owner`
        : `${role} holds ${privilege} on ${table} through membership in ${through}: revoke that membership, or that role's grant`,
    )
    .join("; ");
}
