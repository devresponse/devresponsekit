import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Migration-authoring lint: a system-catalog lookup inside a migration must be
 * SCHEMA-SCOPED (source review 2026-09-04, #88).
 *
 * `0001-initial-schema.sql` looks a CHECK constraint up by
 * `pg_class.relname` alone. This application supports several installs in ONE
 * database (`DB_SCHEMA`), so an unscoped `relname` / `table_name` filter can
 * match a namesake table in a SIBLING schema: `select … into` silently takes
 * an arbitrary row, and the `alter table … drop constraint <that name>` that
 * follows can abort the whole migration.
 *
 * `0001` is FROZEN — applied to production and checksum-pinned — so the
 * occurrence there cannot be edited, and a later migration cannot repair it
 * either (0001 has already run by then). It is recorded below as an explicit,
 * documented exception; every OTHER migration, present and future, must scope
 * its catalog lookups:
 *
 *   - `pg_constraint`  → `conrelid = '<table>'::regclass` (0005 does this)
 *   - `pg_class` / `pg_index` → join `pg_namespace` and filter `nspname`,
 *     or resolve the relation through `::regclass` / `tg_relid`
 *   - `information_schema.*` → `table_schema = current_schema()`
 *
 * `::regclass` and `current_schema()` both resolve through the connection's
 * `search_path`, which the runner pins to `DB_SCHEMA` — so they always mean
 * "the install being migrated".
 *
 * This test fails if a new migration ships an unscoped lookup, and it fails
 * just as loudly if someone adds a file to the exception list.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");

/**
 * The ONLY file allowed to carry an unscoped catalog lookup: the frozen
 * baseline, at ONE site — the `signup_approval_mode` CHECK swap
 * (`select con.conname … where rel.relname = 'app_organization_auth_settings'`,
 * the site #88 names). It sits inside an `if cname is not null` guard, and
 * Postgres names an inline CHECK identically in every schema, so a sibling
 * install yields the same name — the exposure is a failed migration on a fresh
 * multi-schema install, never a wrong-schema DDL. It is fixable only by
 * rewriting a frozen, production-applied, checksum-pinned file, which this
 * repo does not do. (The audit-tombstone FK swap higher up in the same file
 * looks similar but IS scoped: `confrelid = 'app_organizations'::regclass`
 * ties it to this schema's table.)
 */
const FROZEN_EXCEPTIONS = new Map<string, number>([["0001-initial-schema.sql", 1]]);

/** Relations whose rows are per-schema and therefore need a schema filter. */
const CATALOG_REFERENCE =
  /\b(?:from|join)\s+(?:pg_catalog\.)?(pg_constraint|pg_class|pg_index|pg_indexes|pg_tables|information_schema\.[a-z_]+)\b/i;

/** Tokens that scope a lookup to the schema being migrated. */
const SCOPING_TOKENS = [
  /::regclass/i,
  /\bnspname\b/i,
  /\brelnamespace\b/i,
  /\bconnamespace\b/i,
  /\btable_schema\s*=\s*current_schema\(\)/i,
  /\bschemaname\s*=\s*current_schema\(\)/i,
  /\btg_relid\b/i,
];

/**
 * Splits SQL into `;`-delimited units. Dollar-quoted bodies (`$$ … $$`) are
 * split too — deliberately: each inner statement is linted on its own, so a
 * scoped lookup in one branch of a `do $$ … $$` block cannot vouch for an
 * unscoped one in another.
 */
function units(sql: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let line = 1;
  let start = 1;
  let buf = "";
  for (const ch of sql) {
    if (ch === ";") {
      out.push({ text: buf, line: start });
      buf = "";
      start = line;
      continue;
    }
    buf += ch;
    if (ch === "\n") line++;
    if (buf.trim() === "") start = line;
  }
  if (buf.trim() !== "") out.push({ text: buf, line: start });
  return out;
}

/** Strips `--` line comments so a comment can never satisfy the lint. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function unscopedLookups(file: string): Array<{ line: number; snippet: string }> {
  const sql = stripComments(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  return units(sql)
    .filter((unit) => CATALOG_REFERENCE.test(unit.text))
    .filter((unit) => !SCOPING_TOKENS.some((token) => token.test(unit.text)))
    .map((unit) => ({
      line: unit.line,
      snippet: unit.text.replace(/\s+/g, " ").trim().slice(0, 200),
    }));
}

/** Every migration this runner applies: core `NNNN-*.sql` plus the locale files. */
const CORE = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}-.*\.sql$/.test(f))
  .sort();
const LOCALES = readdirSync(path.join(MIGRATIONS_DIR, "locales"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => path.join("locales", f))
  .sort();

describe("migration authoring: system-catalog lookups are schema-scoped (#88)", () => {
  it("lints the whole applied migration set", () => {
    expect(CORE[0]).toBe("0001-initial-schema.sql");
    expect(CORE.length).toBeGreaterThanOrEqual(6);
    expect(LOCALES.length).toBeGreaterThan(0);
  });

  it.each([...CORE, ...LOCALES])("%s scopes every catalog lookup", (file) => {
    const allowed = FROZEN_EXCEPTIONS.get(path.basename(file)) ?? 0;
    const found = unscopedLookups(file);
    const detail = found.map((f) => `  line ${f.line}: ${f.snippet}`).join("\n");
    expect(
      found.length,
      `${file} has ${found.length} unscoped system-catalog lookup(s) (allowed: ${allowed}).\n` +
        `Scope by conrelid = '<table>'::regclass, a pg_namespace/nspname join, or ` +
        `table_schema = current_schema() — see the header of this test (#88).\n${detail}`,
    ).toBe(allowed);
  });

  it("grants the frozen exception to 0001 only, and only for its one known site", () => {
    expect([...FROZEN_EXCEPTIONS.keys()]).toEqual(["0001-initial-schema.sql"]);
    // Pin the site so a SECOND unscoped lookup can never be smuggled into the
    // baseline under the existing allowance.
    const found = unscopedLookups("0001-initial-schema.sql");
    expect(found).toHaveLength(1);
    expect(found[0]!.snippet.toLowerCase()).toContain(
      "rel.relname = 'app_organization_auth_settings'",
    );
  });

  it("0005 shows the required pattern for a CHECK-constraint probe", () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, "0005-integrity-constraints.sql"), "utf8");
    expect(sql).toContain("conrelid = 'app_organizations'::regclass");
  });
});
