import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONSOLIDATED_CORE_MIGRATIONS } from "@/db/migrations/migration-plan";

/**
 * Core migrations as the tests that exercise ONE of them need them (MIG).
 *
 * Since the 2026-09-30 consolidation, 0002…0008 are no longer files: each is a
 * section of `0002-release.sql`, between a `-- ===== BEGIN folded <id> =====`
 * and a `-- ===== END folded <id> =====` line, holding exactly what the file
 * held. Every test that reads one of them goes through here, so a DB test
 * still applies the SQL its migration was ledgered under, and the checksum
 * test proves each section against its pin.
 */
export const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");

/** A core migration's ledger id and SQL: a file, or a section of a consolidated file. */
export interface CoreMigrationSql {
  id: string;
  sql: string;
}

const BANNER = /^-- ===== (BEGIN|END) folded (\S+\.sql) =====$/gm;

/** Reads a file under src/db/migrations. */
export function readMigrationFile(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * Splits a consolidated file into its folded sections, in file order. A
 * section is the text between its BEGIN line and its END line. Throws on an
 * unbalanced, nested or mismatched banner, so a damaged file cannot pass as
 * one with fewer sections.
 */
export function foldedSections(sql: string): CoreMigrationSql[] {
  const sections: CoreMigrationSql[] = [];
  let open: { id: string; start: number } | null = null;
  for (const match of sql.matchAll(BANNER)) {
    const kind = match[1]!;
    const id = match[2]!;
    if (kind === "BEGIN") {
      if (open) throw new Error(`BEGIN folded ${id} inside the open section ${open.id}`);
      open = { id, start: sql.indexOf("\n", match.index) + 1 };
    } else {
      if (!open || open.id !== id) {
        throw new Error(`END folded ${id} without its BEGIN (open: ${open?.id ?? "none"})`);
      }
      sections.push({ id, sql: sql.slice(open.start, match.index) });
      open = null;
    }
  }
  if (open) throw new Error(`BEGIN folded ${open.id} is never closed`);
  return sections;
}

/** The numbered core files on disk, in apply order. */
export function coreMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{4}-.*\.sql$/.test(file))
    .sort();
}

/**
 * Every core migration in apply order, each consolidated file replaced by its
 * folded sections: the sequence of SQL a database migrated one file at a
 * time received.
 */
export function coreMigrationSequence(): CoreMigrationSql[] {
  return coreMigrationFiles().flatMap((file) => {
    const sql = readMigrationFile(file);
    return CONSOLIDATED_CORE_MIGRATIONS[file] ? foldedSections(sql) : [{ id: file, sql }];
  });
}

/** The SQL of one core migration by ledger id, a folded one included. */
export function coreMigrationSql(id: string): string {
  const found = coreMigrationSequence().find((migration) => migration.id === id);
  if (!found) throw new Error(`no core migration or folded section named ${id}`);
  return found.sql;
}

/** The core migrations applied before `id`, in order (0001 first). */
export function coreMigrationsBefore(id: string): CoreMigrationSql[] {
  const sequence = coreMigrationSequence();
  const index = sequence.findIndex((migration) => migration.id === id);
  if (index === -1) throw new Error(`no core migration or folded section named ${id}`);
  return sequence.slice(0, index);
}
