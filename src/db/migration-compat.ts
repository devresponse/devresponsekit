import { normalizeMigrationSql } from "./migrations/migration-plan";

/**
 * The expand/contract guard on new core migrations (DEP1).
 *
 * Every argument for the production schema gate's safety rests on one rule:
 * a migration leaves working the build that is live while it runs, any
 * production deployment an Instant Rollback could restore, and every
 * satellite on the shared database at its deployed version (docs/deployment.md
 * §5, "Compatibility: expand, then contract"). Old code runs on the new schema
 * during the build, after a failed build and after a rollback. This module
 * reads a migration file statement by statement and reports what breaks the
 * rule unless the author says why it does not. The unit test
 * tests/unit/migration-compat-guard.test.ts applies it to every core file
 * from 0003 on.
 *
 * Four classes, by what may waive them:
 *
 * - FORBIDDEN, never: statements that cannot run inside the runner's per-file
 *   transaction (`CONCURRENTLY`, `VACUUM`, transaction control, `ALTER TYPE …
 *   ADD VALUE`, `ALTER SYSTEM`, `CREATE`/`DROP DATABASE`).
 * - IDEMPOTENCY, never: a `create table` / `add column` / `create index` /
 *   `create schema` without `if not exists`, a `create function` without `or
 *   replace`. A re-run after a partial apply must be a no-op.
 * - CONTRACT, waived by a `contract` marker: any `drop` but `drop not null`,
 *   renames, column type changes (with or without the optional COLUMN
 *   keyword), `truncate`, `revoke`. These remove what older code still uses.
 * - TIGHTEN or DATA, waived by an `expand` or `contract` marker: `set not
 *   null`, an added `not null` column with no default, a new constraint not
 *   added `not valid`, a unique index, `update`, `delete`. These can make an
 *   older writer's statement fail (23502, 23505, 23514) or change its data.
 *
 * The marker is a `--` line directly above the statement:
 *
 *     -- compat: contract — <why the live build, rolled-back builds and
 *     --   satellites are unaffected, and the release that removed the last reader>
 *
 * Inside a `do` block every rule applies anywhere in the body, string
 * literals included, so `execute format('drop table %I', …)` is caught.
 * Pure (no fs): the test feeds it the files.
 */

/** One statement of a migration file. */
export interface SqlStatement {
  /** The contiguous `--` lines directly above it, trimmed. */
  leading: string[];
  /** `normalizeMigrationSql(statement).toLowerCase()`, without the `;`. */
  text: string;
  /** The 1-based line its first token is on. */
  line: number;
}

/** The comment lines directly above a statement: the run of `--` lines that ends on its line. */
function leadingComments(prefix: string): string[] {
  const lines = prefix.split("\n");
  // The last piece is the statement's own line, up to its first token.
  lines.pop();
  const leading: string[] = [];
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k]!.trim();
    if (!line.startsWith("--")) break;
    leading.unshift(line);
  }
  return leading;
}

/**
 * Splits a migration at its top-level `;`, the way Postgres would: not inside
 * a single-quoted string, a double-quoted identifier, a dollar-quoted body
 * (`$$`, `$tag$`) or a comment. Empty statements are dropped.
 */
export function splitStatements(sql: string): SqlStatement[] {
  const src = sql.replace(/\r\n/g, "\n");
  const n = src.length;
  const statements: SqlStatement[] = [];
  let segmentStart = 0;
  let first = -1;
  let i = 0;

  const flush = (end: number) => {
    if (first !== -1) {
      const text = normalizeMigrationSql(src.slice(first, end)).toLowerCase();
      if (text) {
        statements.push({
          leading: leadingComments(src.slice(segmentStart, first)),
          text,
          line: src.slice(0, first).split("\n").length,
        });
      }
    }
    first = -1;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "-" && next === "-") {
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === ";") {
      flush(i);
      i++;
      segmentStart = i;
      continue;
    }
    if (first === -1) first = i;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "$" && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64))?.[0];
      if (tag) {
        const close = src.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    i++;
  }
  flush(n);
  return statements;
}

export type CompatRule = "forbidden" | "idempotency" | "contract" | "tighten";

export interface CompatViolation {
  line: number;
  rule: CompatRule;
  /** What the statement does, in words. */
  what: string;
  /** The start of the normalised statement, to find it by. */
  statement: string;
}

interface Pattern {
  rule: CompatRule;
  what: string;
  /** Tested against the statement's normalised text. `^` is its start (dropped inside a `do` body). */
  pattern: RegExp;
}

const PATTERNS: readonly Pattern[] = [
  // FORBIDDEN: none of these can run inside the runner's per-file transaction.
  { rule: "forbidden", what: "CONCURRENTLY", pattern: /\bconcurrently\b/ },
  { rule: "forbidden", what: "VACUUM", pattern: /^vacuum\b/ },
  {
    rule: "forbidden",
    what: "transaction control",
    pattern: /^(?:begin|commit|rollback|start\s+transaction|end)\b/,
  },
  {
    rule: "forbidden",
    what: "ALTER TYPE … ADD VALUE",
    pattern: /\balter\s+type\s+\S+\s+add\s+value\b/,
  },
  { rule: "forbidden", what: "ALTER SYSTEM", pattern: /\balter\s+system\b/ },
  { rule: "forbidden", what: "CREATE/DROP DATABASE", pattern: /\b(?:create|drop)\s+database\b/ },
  // IDEMPOTENCY: a re-run after a partial apply must be a no-op.
  {
    rule: "idempotency",
    what: "create table without if not exists",
    pattern: /^create\s+table\s+(?!if\s+not\s+exists\b)/,
  },
  {
    rule: "idempotency",
    what: "add column without if not exists",
    pattern: /\badd\s+column\s+(?!if\s+not\s+exists\b)/,
  },
  {
    rule: "idempotency",
    what: "create index without if not exists",
    pattern: /^create\s+(?:unique\s+)?index\s+(?!if\s+not\s+exists\b)/,
  },
  {
    rule: "idempotency",
    what: "create schema without if not exists",
    pattern: /^create\s+schema\s+(?!if\s+not\s+exists\b)/,
  },
  {
    rule: "idempotency",
    what: "create function without or replace",
    pattern: /^create\s+function\b/,
  },
  // CONTRACT: removes or changes what older code may still use. `alter table`
  // may leave out COLUMN (`drop [column] [if exists] c`, `alter [column] c
  // [set data] type`), so neither rule needs the keyword. Every `drop` removes
  // something (an object, a column, a constraint, a default, an identity)
  // except `drop not null`, which only relaxes.
  { rule: "contract", what: "drop", pattern: /\bdrop\b(?!\s+not\s+null\b)/ },
  { rule: "contract", what: "rename", pattern: /\brename\b/ },
  {
    rule: "contract",
    what: "column type change",
    pattern: /\balter\s+(?:column\s+)?\S+\s+(?:set\s+data\s+)?type\b/,
  },
  { rule: "contract", what: "truncate", pattern: /^truncate\b/ },
  { rule: "contract", what: "revoke", pattern: /^revoke\b/ },
  // TIGHTEN or DATA: can fail an older writer's statement, or change its rows.
  { rule: "tighten", what: "set not null", pattern: /\bset\s+not\s+null\b/ },
  {
    rule: "tighten",
    what: "unnamed constraint added without not valid",
    pattern: /\badd\s+(?:check|unique|foreign\s+key|primary\s+key)\b/,
  },
  { rule: "tighten", what: "unique index", pattern: /^create\s+unique\s+index\b/ },
  { rule: "tighten", what: "update", pattern: /^update\b/ },
  { rule: "tighten", what: "delete", pattern: /^delete\s+from\b/ },
];

/**
 * Inside a `do` body `begin` and `end` delimit the plpgsql block, so only the
 * transaction control that would end the runner's transaction counts there.
 */
const DO_BODY_TRANSACTION_CONTROL = /\b(?:commit|rollback|start\s+transaction)\b/;

/** A pattern as it applies to the whole of a `do` body: anchored at a word, not the start. */
function unanchored(pattern: RegExp): RegExp {
  return pattern.source.startsWith("^") ? new RegExp(`\\b${pattern.source.slice(1)}`) : pattern;
}

/**
 * The text's clauses: split at `,` and `;` outside parentheses, so each
 * `add column …` / `add constraint …` action of an `alter table` is judged on
 * its own words.
 */
function clauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if ((c === "," || c === ";") && depth === 0) {
      out.push(text.slice(start, k));
      start = k + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** Clause-level TIGHTEN rules: what an added column or constraint says about itself. */
function clauseViolations(text: string): string[] {
  const found: string[] = [];
  for (const clause of clauses(text)) {
    if (
      /\badd\s+column\b/.test(clause) &&
      /\bnot\s+null\b/.test(clause) &&
      !/\bdefault\b/.test(clause)
    ) {
      found.push("not null column added without a default");
    }
    if (
      /\badd\s+constraint\s+\S+\s+(?:check|unique|foreign\s+key|primary\s+key|exclude)\b/.test(
        clause,
      ) &&
      !/\bnot\s+valid\b/.test(clause)
    ) {
      found.push("constraint added without not valid");
    }
  }
  return found;
}

/**
 * `alter table t add c int` is `add column` with the keyword left out, and
 * `add if not exists c int` likewise; spelled out, so neither slips past the
 * column rules.
 */
function withColumnKeyword(text: string): string {
  if (!/\balter\s+table\b/.test(text)) return text;
  return text.replace(
    /\badd\s+(?!(?:column|constraint|check|unique|foreign|primary|exclude|value|attribute)\b)/g,
    "add column ",
  );
}

const MARKER = /^--\s*compat:\s*(expand|contract)\s*(?:—|--?|:)\s*(.{20,})$/i;

/** The strongest marker among the lines above a statement: `contract` covers `expand`. */
function markerOf(leading: readonly string[]): "expand" | "contract" | null {
  let found: "expand" | "contract" | null = null;
  for (const line of leading) {
    const kind = MARKER.exec(line)?.[1]?.toLowerCase();
    if (kind === "contract") return "contract";
    if (kind === "expand") found = "expand";
  }
  return found;
}

function waived(rule: CompatRule, marker: "expand" | "contract" | null): boolean {
  if (rule === "contract") return marker === "contract";
  if (rule === "tighten") return marker !== null;
  return false;
}

/** Every statement of `sql` that breaks the expand/contract rule without a marker that covers it. */
export function findCompatViolations(sql: string): CompatViolation[] {
  const violations: CompatViolation[] = [];
  for (const statement of splitStatements(sql)) {
    const text = withColumnKeyword(statement.text);
    const isDo = /^do\b/.test(text);
    const marker = markerOf(statement.leading);
    const report = (rule: CompatRule, what: string) => {
      if (waived(rule, marker)) return;
      violations.push({ line: statement.line, rule, what, statement: text.slice(0, 120) });
    };
    for (const { rule, what, pattern } of PATTERNS) {
      const applied =
        isDo && what === "transaction control"
          ? DO_BODY_TRANSACTION_CONTROL
          : isDo
            ? unanchored(pattern)
            : pattern;
      if (applied.test(text)) report(rule, what);
    }
    for (const what of clauseViolations(text)) report("tighten", what);
  }
  return violations;
}

/** Core files before this number are frozen and predate the rule. */
export const FIRST_GUARDED_MIGRATION = 3;
const CORE_MIGRATION_FILE = /^(\d{4})-[a-z0-9-]+\.sql$/;
const FROZEN_CORE_MIGRATIONS = new Set(["0001-initial-schema.sql", "0002-release.sql"]);

/**
 * The files the guard applies to, from a listing of `src/db/migrations/`:
 * numbered core files from {@link FIRST_GUARDED_MIGRATION} on. Not the frozen
 * `0001-initial-schema.sql` and `0002-release.sql`, not
 * `better-auth-schema.sql` (Better Auth's own DDL), and not `locales/` (data
 * rows only, listed as a directory here).
 */
export function compatGuardTargets(entries: readonly string[]): string[] {
  return entries
    .filter((name) => {
      const match = CORE_MIGRATION_FILE.exec(name);
      return (
        match !== null &&
        Number(match[1]) >= FIRST_GUARDED_MIGRATION &&
        !FROZEN_CORE_MIGRATIONS.has(name)
      );
    })
    .sort();
}
