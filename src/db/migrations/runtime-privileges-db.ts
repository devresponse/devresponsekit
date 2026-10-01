import {
  FORBIDDEN_ATTRIBUTES,
  FORBIDDEN_MEMBERSHIPS,
  FUNCTION_GRANTS,
  type PrivilegeReport,
  type ReconcilePlan,
  type RuntimeRoleState,
  TABLE_PRIVILEGES,
  type TablePrivilege,
  comparePrivileges,
  describeUnexplained,
  functionSignature,
  planRuntimeReconcile,
  qualifiedFunction,
  runtimeRoleName,
} from "../runtime-privileges";

/**
 * The runtime role's privileges against a live database (DEP3): the I/O half
 * of `../runtime-privileges.ts`, which holds the manifest and every decision.
 * It lives with the migration tooling because the unit coverage gate excludes
 * this directory; tests/db/runtime-role-grants.db.test.ts and
 * tests/db/deploy-gate.db.test.ts cover it.
 *
 * - {@link reconcileRuntimePrivileges}: the last step of every `pnpm
 *   db:app:migrate` (and of `pnpm db:runtime-login`). It reaches Better Auth's
 *   tables, which `db:auth:migrate` creates outside the ledger, and makes
 *   docs/deployment.md §8's "re-running db:app:migrate re-applies the grants"
 *   true. It changes the grants of `<DB_SCHEMA>_runtime` only.
 * - {@link verifyCurrentUserPrivileges}: what the session's own role holds,
 *   effective privileges included. The production build's gate and the login
 *   command's verification share it.
 * - {@link listRuntimeLoginMembers}: the gate's ratchet.
 */

/** The one method these functions need: a `pg` Pool, PoolClient or Client. */
export interface SqlSession {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** What {@link reconcileRuntimePrivileges} did. */
export type ReconcileResult =
  | { status: "absent"; role: string }
  | {
      status: "reconciled";
      role: string;
      grants: number;
      revokes: number;
      statements: string[];
      unlisted: string[];
    };

const ROLE_SQL = "select oid::int8::text as oid from pg_roles where rolname = $1";

/** Each table in the schema: direct, PUBLIC and effective privileges of the role. */
const TABLES_SQL = `
  select c.relname as table_name,
         array(select a.privilege_type from aclexplode(c.relacl) a
                where a.grantee = $2::oid order by 1) as direct,
         array(select a.privilege_type from aclexplode(c.relacl) a
                where a.grantee = 0 order by 1) as public_grants,
         array(select p from unnest($3::text[]) p
                where has_table_privilege($2::oid, c.oid, p)) as effective
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = $1 and c.relkind in ('r', 'p')
   order by c.relname`;

const SCHEMA_SQL = `
  select array(select a.privilege_type from aclexplode(n.nspacl) a
                where a.grantee = $2::oid) as direct
    from pg_namespace n
   where n.nspname = $1`;

const FUNCTIONS_SQL = `
  select f.sig, p.oid is not null as present,
         array(select a.privilege_type from aclexplode(p.proacl) a
                where a.grantee = $2::oid) as direct
    from unnest($1::text[]) with ordinality as f(sig, i)
    left join pg_proc p on p.oid = to_regprocedure(f.sig)
   order by f.i`;

/** The current user's default privileges in the schema, for the role. */
const DEFAULT_ACL_SQL = `
  select d.defaclobjtype as objtype,
         array(select a.privilege_type from aclexplode(d.defaclacl) a
                where a.grantee = $2::oid) as privileges
    from pg_default_acl d
   where d.defaclrole = (select oid from pg_roles where rolname = current_user)
     and d.defaclnamespace = (select oid from pg_namespace where nspname = $1)`;

/** Every role whose privileges the role inherits. */
const MEMBER_OF_SQL = `
  select r.rolname from pg_roles r
   where r.oid <> $1::oid and pg_has_role($1::oid, r.oid, 'USAGE')
   order by 1`;

async function readRuntimeState(
  client: SqlSession,
  schema: string,
  roleOid: string,
): Promise<RuntimeRoleState> {
  const tables = await client.query<{
    table_name: string;
    direct: TablePrivilege[];
    public_grants: TablePrivilege[];
    effective: TablePrivilege[];
  }>(TABLES_SQL, [schema, roleOid, TABLE_PRIVILEGES]);
  const nsp = await client.query<{ direct: string[] }>(SCHEMA_SQL, [schema, roleOid]);
  const functions = await client.query<{ sig: string; present: boolean; direct: string[] }>(
    FUNCTIONS_SQL,
    [FUNCTION_GRANTS.map((fn) => qualifiedFunction(schema, fn)), roleOid],
  );
  const defaults = await client.query<{ objtype: string; privileges: string[] }>(DEFAULT_ACL_SQL, [
    schema,
    roleOid,
  ]);
  const defaultsFor = (objtype: string) =>
    defaults.rows.filter((row) => row.objtype === objtype).flatMap((row) => row.privileges);
  return {
    tables: tables.rows.map((row) => ({
      table: row.table_name,
      direct: row.direct,
      publicGrants: row.public_grants,
      effective: row.effective,
    })),
    schemaDirect: nsp.rows[0]?.direct ?? [],
    functions: functions.rows.map((row, i) => ({
      signature: functionSignature(FUNCTION_GRANTS[i]!),
      present: row.present,
      direct: row.direct,
    })),
    defaultAcl: { tables: defaultsFor("r"), sequences: defaultsFor("S") },
  };
}

/**
 * Brings `<schema>_runtime` to the manifest (DEP3), in one transaction that
 * issues only the statements needed: none on a steady-state run. Called at
 * the end of `run-migrations.ts`, inside the advisory lock, after the last
 * file. `log` receives each line without a prefix.
 *
 * - A missing role is reported and left missing: 0005 owns its creation, and
 *   some scratch schemas rely on it being absent.
 * - A table the manifest does not list is reported and left as it is
 *   (tests/unit/runtime-privileges.test.ts fails on it first).
 * - A privilege outside the manifest that no direct grant explains (it comes
 *   from PUBLIC or a membership, so no revoke here removes it) throws before
 *   anything is applied, naming its source.
 * - Postgres only WARNS when a grant or revoke changes nothing (a role that
 *   does not own the table), so the state is read again after the commit and
 *   anything still out of line throws.
 *
 * A throw fails the migrate job. Its ledger rows are already committed then;
 * once the app runs as the login, the gate's privilege check is the backstop.
 */
export async function reconcileRuntimePrivileges(
  client: SqlSession,
  schema: string,
  log: (line: string) => void,
): Promise<ReconcileResult> {
  const role = runtimeRoleName(schema);
  const found = await client.query<{ oid: string }>(ROLE_SQL, [role]);
  const roleOid = found.rows[0]?.oid;
  if (!roleOid) {
    log(
      `warning: ${role} does not exist; runtime privileges not reconciled (docs/deployment.md §8)`,
    );
    return { status: "absent", role };
  }

  const unexplained = async (items: ReconcilePlan["unexplained"], outcome: string) => {
    const memberOf = await client.query<{ rolname: string }>(MEMBER_OF_SQL, [roleOid]);
    return new Error(
      `runtime role ${role}: privileges outside the manifest that no grant to ${role} explains, ${outcome}: ${describeUnexplained(
        role,
        items,
        memberOf.rows.map((row) => row.rolname),
      )}`,
    );
  };

  const plan = planRuntimeReconcile(schema, role, await readRuntimeState(client, schema, roleOid));
  for (const table of plan.unlisted) {
    log(
      `warning: ${schema}.${table} is not in the runtime privilege manifest (src/db/runtime-privileges.ts); its grants were left as they are`,
    );
  }
  if (plan.unexplained.length > 0) {
    throw await unexplained(plan.unexplained, "so nothing was changed");
  }

  if (plan.statements.length > 0) {
    await client.query("begin");
    try {
      await client.query("set local lock_timeout = '5s'");
      for (const statement of plan.statements) await client.query(statement);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    }
    const after = planRuntimeReconcile(
      schema,
      role,
      await readRuntimeState(client, schema, roleOid),
    );
    // A revoked direct grant can leave the same privilege held through PUBLIC
    // or a membership: what the role holds afterwards is what counts.
    if (after.unexplained.length > 0) {
      throw await unexplained(after.unexplained, "after the repair");
    }
    if (after.statements.length > 0) {
      throw new Error(
        `runtime role ${role}: still out of line after the repair, so the migrating role does not own every table, function and the schema (Postgres only warns then): ${after.statements.join("; ")}`,
      );
    }
    log(`runtime role ${role}: ${plan.grants} grants, ${plan.revokes} revokes`);
  } else {
    log(`runtime role ${role}: in sync`);
  }
  return {
    status: "reconciled",
    role,
    grants: plan.grants,
    revokes: plan.revokes,
    statements: plan.statements,
    unlisted: plan.unlisted,
  };
}

/** What the session's role holds on each table of the schema, from any source. */
const CURRENT_TABLES_SQL = `
  select c.relname as table_name,
         array(select p from unnest($2::text[]) p where has_table_privilege(c.oid, p)) as privileges
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = $1 and c.relkind in ('r', 'p')
   order by c.relname`;

const CURRENT_ROLE_SQL = `
  select coalesce((select has_schema_privilege(n.oid, 'USAGE') from pg_namespace n
                    where n.nspname = $1), false) as schema_usage,
         coalesce((select has_schema_privilege(n.oid, 'CREATE') from pg_namespace n
                    where n.nspname = $1), false) as schema_create,
         coalesce((select has_schema_privilege(n.oid, 'CREATE') from pg_namespace n
                    where n.nspname = 'public'), false) as public_create,
         has_database_privilege(current_database(), 'CREATE') as database_create,
         (select pg_get_userbyid(c.relowner)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = $1 and c.relname = 'app_schema_migrations') as ledger_owner,
         r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls
    from pg_roles r
   where r.rolname = current_user`;

const CURRENT_FUNCTIONS_SQL = `
  select case when p.oid is null then null
              else has_function_privilege(p.oid, 'EXECUTE') end as can
    from unnest($1::text[]) with ordinality as f(sig, i)
    left join pg_proc p on p.oid = to_regprocedure(f.sig)
   order by f.i`;

const CURRENT_MEMBERSHIPS_SQL = `
  select r.rolname from pg_roles r
   where r.rolname = any($1::text[]) and pg_has_role(current_user, r.oid, 'MEMBER')
   order by 1`;

/**
 * What `current_user` holds against the manifest (DEP3), effective privileges
 * included: through PUBLIC, through any membership, as a superuser. Every
 * list empty means it holds exactly the manifest. Read-only.
 */
export async function verifyCurrentUserPrivileges(
  client: SqlSession,
  schema: string,
): Promise<PrivilegeReport> {
  const tables = await client.query<{ table_name: string; privileges: TablePrivilege[] }>(
    CURRENT_TABLES_SQL,
    [schema, TABLE_PRIVILEGES],
  );
  const { rows } = await client.query<
    {
      schema_usage: boolean;
      schema_create: boolean;
      public_create: boolean;
      database_create: boolean;
      ledger_owner: string | null;
    } & Record<string, unknown>
  >(CURRENT_ROLE_SQL, [schema]);
  const role = rows[0]!;
  const functions = await client.query<{ can: boolean | null }>(CURRENT_FUNCTIONS_SQL, [
    FUNCTION_GRANTS.map((fn) => qualifiedFunction(schema, fn)),
  ]);
  const forbiddenRoles = [
    ...FORBIDDEN_MEMBERSHIPS,
    ...(role.ledger_owner ? [role.ledger_owner] : []),
  ];
  const memberships = await client.query<{ rolname: string }>(CURRENT_MEMBERSHIPS_SQL, [
    forbiddenRoles,
  ]);
  return comparePrivileges(schema, {
    tables: tables.rows.map((row) => ({ table: row.table_name, privileges: row.privileges })),
    functions: Object.fromEntries(
      FUNCTION_GRANTS.map((fn, i) => [functionSignature(fn), functions.rows[i]?.can ?? null]),
    ),
    schemaUsage: role.schema_usage,
    schemaCreate: role.schema_create,
    publicCreate: role.public_create,
    databaseCreate: role.database_create,
    attributes: Object.keys(FORBIDDEN_ATTRIBUTES).filter((column) => role[column] === true),
    memberships: memberships.rows.map((row) => row.rolname),
  });
}

/**
 * LOGIN roles that are direct members of `<schema>_runtime` and inherit or
 * may SET it, other than the session's own role. The member a non-superuser
 * CREATEROLE owner becomes on PG16+ when it creates the role (ADMIN only, no
 * INHERIT or SET) is not one: that is how 0005 leaves `neondb_owner`.
 */
export async function listRuntimeLoginMembers(
  client: SqlSession,
  schema: string,
): Promise<string[]> {
  const { rows } = await client.query<{ rolname: string }>(
    `select distinct r.rolname
       from pg_auth_members m
       join pg_roles g on g.oid = m.roleid
       join pg_roles r on r.oid = m.member
      where g.rolname = $1
        and r.rolcanlogin
        and r.rolname <> current_user
        and (pg_has_role(r.oid, g.oid, 'USAGE') or pg_has_role(r.oid, g.oid, 'SET'))
      order by 1`,
    [runtimeRoleName(schema)],
  );
  return rows.map((row) => row.rolname);
}
