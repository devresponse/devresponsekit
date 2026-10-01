import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRST_GUARDED_MIGRATION,
  compatGuardTargets,
  findCompatViolations,
  splitStatements,
} from "@/db/migration-compat";

/**
 * The expand/contract guard (DEP1, docs/deployment.md §5 "Compatibility:
 * expand, then contract"). The production build's schema gate lets old code
 * run on the new schema during the build, after a failed build and after an
 * Instant Rollback, so a core migration from 0003 on must add before it
 * removes, and say why when it tightens or removes anything.
 *
 * The enforcement test applies to whatever core files exist; there are none
 * after the frozen 0002 today, so the classifier is proven on fixtures and on
 * real SQL from 0002-release.sql, where the patterns must find statements
 * known to be of each kind.
 */
const MIGRATIONS = path.join(process.cwd(), "src/db/migrations");
const FIXTURES = path.join(process.cwd(), "tests/unit/fixtures/migration-compat");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");
const rules = (sql: string) => findCompatViolations(sql).map((v) => `${v.rule}: ${v.what}`);

describe("every core migration from 0003 on keeps the expand/contract rule", () => {
  const targets = compatGuardTargets(readdirSync(MIGRATIONS));

  it.each(targets.length > 0 ? targets : ["(none yet)"])("%s", (file) => {
    if (file === "(none yet)") return;
    const violations = findCompatViolations(readFileSync(path.join(MIGRATIONS, file), "utf8"));
    expect(
      violations.map((v) => `${file}:${v.line} ${v.rule}: ${v.what} — ${v.statement}`),
      "Each statement listed breaks the expand/contract rule (docs/deployment.md §5, " +
        '"Compatibility: expand, then contract"). FORBIDDEN and IDEMPOTENCY cannot be waived: ' +
        "rewrite the statement. A CONTRACT statement needs `-- compat: contract — <reason>` directly " +
        "above it, naming the release that removed the last reader; a TIGHTEN or DATA statement needs " +
        "`-- compat: expand — <reason>` (or contract), saying why the live build, rolled-back builds " +
        "and the satellites are unaffected.",
    ).toEqual([]);
  });

  it("covers new numbered core files only: not the frozen ones, Better Auth's or locales", () => {
    expect(FIRST_GUARDED_MIGRATION).toBe(3);
    // The real listing: the frozen files are there, and never guarded.
    const listing = readdirSync(MIGRATIONS);
    expect(listing).toEqual(
      expect.arrayContaining([
        "0001-initial-schema.sql",
        "0002-release.sql",
        "better-auth-schema.sql",
        "locales",
      ]),
    );
    const real = compatGuardTargets(listing);
    for (const frozen of [
      "0001-initial-schema.sql",
      "0002-release.sql",
      "better-auth-schema.sql",
    ]) {
      expect(real).not.toContain(frozen);
    }
    // A listing as it looks once 0003 lands.
    expect(
      compatGuardTargets([
        "0001-initial-schema.sql",
        "0002-release.sql",
        "better-auth-schema.sql",
        "locales",
        "migration-plan.ts",
        "0010-add-widgets.sql",
        "0003-x.sql",
        "0004-Bad-Case.sql",
        "0005-x.sql.bak",
      ]),
    ).toEqual(["0003-x.sql", "0010-add-widgets.sql"]);
  });
});

describe("the classifier on fixtures", () => {
  it.each([
    ["bad-drop-column.sql", ["contract: drop"]],
    ["bad-add-not-null-no-default.sql", ["tighten: not null column added without a default"]],
    ["bad-no-if-not-exists.sql", ["idempotency: create table without if not exists"]],
    ["bad-do-block-dynamic-drop.sql", ["contract: drop"]],
    ["bad-short-reason.sql", ["contract: drop"]],
  ])("%s is a violation", (name, expected) => {
    expect(rules(fixture(name))).toEqual(expected);
  });

  it("a marker never waives CONCURRENTLY", () => {
    expect(rules(fixture("bad-concurrently-with-marker.sql"))).toContain("forbidden: CONCURRENTLY");
  });

  it.each(["good-drop-column.sql", "good-add-column-default.sql"])("%s passes", (name) => {
    expect(findCompatViolations(fixture(name))).toEqual([]);
  });
});

describe("the classifier on real SQL: 0002-release.sql", () => {
  const sql = readFileSync(path.join(MIGRATIONS, "0002-release.sql"), "utf8");
  const statements = splitStatements(sql);
  const violations = findCompatViolations(sql);
  /** The rules reported for the one statement whose text contains `needle`. */
  const flagged = (needle: string) => {
    const matches = statements.filter((s) => s.text.includes(needle));
    expect(matches, needle).toHaveLength(1);
    return violations.filter((v) => v.line === matches[0]!.line).map((v) => `${v.rule}: ${v.what}`);
  };

  it("finds five statements known to be of each kind", () => {
    // 0005's revoke, inside a do block as dynamic SQL.
    expect(
      flagged("execute format('revoke update, delete, truncate on %i.app_audit_events"),
    ).toContain("contract: revoke");
    // 0005's NOT NULL, made safe by its fill trigger.
    expect(
      flagged("alter table app_group_roles alter column organization_id set not null"),
    ).toContain("tighten: set not null");
    // The drop-and-recreate of a trigger.
    expect(flagged("drop trigger if exists trg_app_group_roles_bind_org")).toContain(
      "contract: drop",
    );
    // 0005's backfill.
    expect(flagged("update app_group_roles gr set organization_id")).toContain("tighten: update");
    // 0007's unique index.
    expect(flagged("create unique index if not exists idx_app_roles_global_key")).toContain(
      "tighten: unique index",
    );
  });

  it("splits it at top-level semicolons only", () => {
    // Function bodies hold dozens of `;` inside dollar quotes; each is one statement.
    const bind = statements.filter((s) =>
      s.text.startsWith("create or replace function app_group_roles_bind_org()"),
    );
    expect(bind).toHaveLength(1);
    expect(bind[0]!.text.endsWith("$$")).toBe(true);
    expect(statements.every((s) => !s.text.startsWith("end") && !s.text.startsWith("$$"))).toBe(
      true,
    );
  });
});

describe("splitStatements", () => {
  it("ignores ; in strings, identifiers, comments and dollar quotes, and keeps line numbers", () => {
    const sql = [
      "-- first; not a statement",
      "insert into t (a) values ('x;y'); /* ; */ select \"a;b\" from t;",
      "",
      "-- unrelated",
      "",
      "-- compat: expand — the attached marker for the function below",
      "create or replace function f() returns int language sql as $body$ select 1; $body$;",
      "select $1, foo$bar from t",
    ].join("\n");
    const statements = splitStatements(sql);
    expect(statements.map((s) => [s.line, s.text])).toEqual([
      [2, "insert into t (a) values ('x;y')"],
      [2, 'select "a;b" from t'],
      [7, "create or replace function f() returns int language sql as $body$ select 1; $body$"],
      [8, "select $1, foo$bar from t"],
    ]);
    expect(statements[0]!.leading).toEqual(["-- first; not a statement"]);
    expect(statements[1]!.leading).toEqual([]);
    expect(statements[2]!.leading).toEqual([
      "-- compat: expand — the attached marker for the function below",
    ]);
  });

  it("drops empty statements and survives unterminated quotes and comments", () => {
    expect(splitStatements(";;  ;\n")).toEqual([]);
    expect(splitStatements("select 1 /* never closed").map((s) => s.text)).toEqual(["select 1"]);
    expect(splitStatements("do $$ begin").map((s) => s.text)).toEqual(["do $$ begin"]);
    expect(splitStatements("select /* a /* nested */ b */ 2;").map((s) => s.text)).toEqual([
      "select 2",
    ]);
  });
});

describe("findCompatViolations: the rules", () => {
  const MARK = (kind: string) =>
    `-- compat: ${kind} — a reason long enough to say something real\n`;

  it.each([
    ["vacuum app_users", "forbidden: VACUUM"],
    ["begin", "forbidden: transaction control"],
    ["commit", "forbidden: transaction control"],
    ["alter type app_status add value 'x'", "forbidden: ALTER TYPE … ADD VALUE"],
    ["alter system set work_mem = '1GB'", "forbidden: ALTER SYSTEM"],
    ["create database other", "forbidden: CREATE/DROP DATABASE"],
    ["alter table t add column c int", "idempotency: add column without if not exists"],
    ["create unique index i on t (c)", "idempotency: create index without if not exists"],
    ["create schema s", "idempotency: create schema without if not exists"],
    [
      "create function f() returns int language sql as $$ select 1 $$",
      "idempotency: create function without or replace",
    ],
    ["alter table t rename column a to b", "contract: rename"],
    ["alter table t alter column c type bigint", "contract: column type change"],
    ["alter table t alter column c set data type bigint", "contract: column type change"],
    ["alter table t alter column c drop default", "contract: drop"],
    ["truncate app_outbox", "contract: truncate"],
    ["revoke select on t from public", "contract: revoke"],
    [
      "alter table t add check (c > 0) not valid",
      "tighten: unnamed constraint added without not valid",
    ],
    ["alter table t add constraint k unique (c)", "tighten: constraint added without not valid"],
    ["delete from t where c is null", "tighten: delete"],
  ])("%s → %s", (sql, rule) => {
    expect(rules(`${sql};`)).toContain(rule);
  });

  it("passes what is additive and idempotent", () => {
    const sql = [
      "create table if not exists t (id int primary key, c int not null)",
      "alter table t add column if not exists d int",
      "alter table t add constraint t_c_check check (c > 0) not valid",
      "alter table t add constraint t_fk foreign key (id, c) references u (id, c) not valid",
      "alter table t validate constraint t_c_check",
      "create index if not exists i on t (c)",
      "create schema if not exists s",
      "create or replace function f() returns int language sql as $$ select 1 $$",
      "grant select on t to r",
      "insert into t (id, c) values (1, 1) on conflict do nothing",
      "do $$ begin if not exists (select 1) then raise notice 'begin; end'; end if; end $$",
    ]
      .map((statement) => `${statement};`)
      .join("\n");
    expect(findCompatViolations(sql)).toEqual([]);
  });

  it.each([
    // `alter table` may leave out COLUMN in DROP and ALTER … TYPE, as in ADD.
    ["alter table app_users drop legacy_name", "contract: drop"],
    ["alter table app_users drop if exists legacy_name cascade", "contract: drop"],
    ["alter table app_users alter legacy_name type bigint", "contract: column type change"],
    ["alter table app_users alter legacy_name set data type text", "contract: column type change"],
    ["do $$ begin execute 'alter table app_users drop legacy_name'; end $$", "contract: drop"],
    // Every other drop removes something too: an identity, an expression, any object.
    ["alter table t alter column c drop identity if exists", "contract: drop"],
    ["alter table t alter c drop expression", "contract: drop"],
    ["drop domain if exists app_email", "contract: drop"],
    ["drop rule if exists r on t", "contract: drop"],
  ])("%s → %s, without the COLUMN keyword or the object kind in a list", (sql, rule) => {
    expect(rules(`${sql};`)).toEqual([rule]);
  });

  it("does not read `drop not null`, which only relaxes, as a drop", () => {
    expect(rules("alter table t alter column c drop not null;")).toEqual([]);
    expect(rules("alter table t alter c drop not null;")).toEqual([]);
    expect(rules("alter table t alter c drop not null, drop d;")).toEqual(["contract: drop"]);
  });

  it("reads `add` without COLUMN as a column", () => {
    expect(rules("alter table t add c int not null;")).toEqual([
      "idempotency: add column without if not exists",
      "tighten: not null column added without a default",
    ]);
    expect(rules("alter table t add if not exists c int default 0 not null;")).toEqual([]);
  });

  it("judges each clause of a multi-action alter table on its own", () => {
    expect(
      rules(
        "alter table t add column if not exists a int default 0 not null, add column if not exists b int not null;",
      ),
    ).toEqual(["tighten: not null column added without a default"]);
  });

  it("applies every rule inside a do body, but not begin/end as transaction control", () => {
    expect(rules("do $$ begin update t set c = 1; end $$;")).toEqual(["tighten: update"]);
    expect(rules("do $$ begin commit; end $$;")).toEqual(["forbidden: transaction control"]);
    expect(rules("do $$ begin execute 'create table x (a int)'; end $$;")).toEqual([
      "idempotency: create table without if not exists",
    ]);
  });

  it("waives by marker: contract covers both, expand only tighten, never the rest", () => {
    const drop = "alter table t drop column if exists c;";
    const tighten = "alter table t alter column c set not null;";
    expect(rules(MARK("contract") + drop)).toEqual([]);
    expect(rules(MARK("expand") + drop)).toEqual(["contract: drop"]);
    expect(rules(MARK("expand") + tighten)).toEqual([]);
    expect(rules(MARK("contract") + tighten)).toEqual([]);
    expect(rules(`${MARK("expand")}-- and more\n${MARK("contract")}${drop}`)).toEqual([]);
    expect(rules(MARK("contract") + "vacuum t;")).toEqual(["forbidden: VACUUM"]);
    expect(rules(MARK("contract") + "create table t (a int);")).toEqual([
      "idempotency: create table without if not exists",
    ]);
  });

  it("accepts the marker's separators and case, and only directly above the statement", () => {
    const drop = "alter table t drop column if exists c;";
    for (const sep of ["—", "--", "-", ":"]) {
      expect(
        rules(`-- COMPAT: Contract ${sep} the last reader went in release 2.1.0\n${drop}`),
      ).toEqual([]);
    }
    expect(rules(`${MARK("contract")}\n${drop}`)).toEqual(["contract: drop"]);
    expect(rules(`-- compat: contract — too short\n${drop}`)).toEqual(["contract: drop"]);
    expect(rules(`-- compat: remove — the last reader went in release 2.1.0\n${drop}`)).toEqual([
      "contract: drop",
    ]);
  });
});
