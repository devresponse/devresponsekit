import { createHash } from "node:crypto";

/**
 * Pure migration-planning helpers — deliberately side-effect-free (no fs, no
 * db) so the ordering + locale-inclusion + ledger-checksum logic is
 * unit-testable without a database. The runner (`run-migrations.ts`) supplies
 * the raw directory listings and the flag; this module decides WHAT to apply
 * and in WHAT order, and how a ledgered checksum is reconciled.
 */

export interface PlannedMigration {
  /** Id recorded in `app_schema_migrations` (the de-dup key). */
  id: string;
  /** Subdirectory under the migrations dir to read the file from. */
  subdir: "" | "locales";
  /** Bare filename. */
  file: string;
}

/**
 * Parses the `DB_MIGRATE_LOCALES` flag. Localized migrations are **included by
 * default**; only an explicit off value (`0` / `false` / `no` / `off`, any
 * case) excludes them. Mirrors the flag-parsing style of
 * `SEARCH_PATH_VIA_OPTIONS` in `schema-config.ts`.
 */
export function shouldIncludeLocales(raw: string | undefined): boolean {
  return !/^(0|false|no|off)$/i.test((raw ?? "").trim());
}

/**
 * The one file under `locales/` that is ALWAYS applied, even when
 * `includeLocales` is false: the English BASE email templates. English is the
 * fallback every locale resolves to (`resolveTemplate` returns the `en` row
 * when a localized row is absent), so even an English-only install
 * (`DB_MIGRATE_LOCALES` off) needs it. It lives under `locales/` so every email
 * template — en included — sits with its locale, but it is never truly optional.
 */
export const ALWAYS_APPLIED_LOCALE = "0000-email-templates-en.sql";

/**
 * Builds the ordered apply-list: CORE migrations first (top-level `*.sql`,
 * excluding the Better-Auth-owned `better-auth*` files, lexical), then the
 * LOCALE migrations (`locales/*.sql`, lexical). When `includeLocales` is false
 * the localized files are skipped — EXCEPT the always-on English base
 * ({@link ALWAYS_APPLIED_LOCALE}), which is applied in EVERY install.
 *
 * Ledger ids:
 *   - core   → the bare filename (STABLE — core files are never renamed, so an
 *              already-migrated database recognises them and skips).
 *   - locale → `locales/<file>` (path-prefixed, so a locale id is
 *              self-describing in the ledger and can never collide with a core
 *              filename).
 *
 * Locale migrations only INSERT … ON CONFLICT DO NOTHING rows that depend on
 * the core schema, so applying every core file before any locale file is
 * always safe.
 */
export function planMigrations(
  coreEntries: readonly string[],
  localeEntries: readonly string[],
  includeLocales: boolean,
): PlannedMigration[] {
  const isSql = (name: string) => name.endsWith(".sql");

  const core: PlannedMigration[] = coreEntries
    .filter(isSql)
    .filter((name) => !name.startsWith("better-auth"))
    .slice()
    .sort()
    .map((file) => ({ id: file, subdir: "", file }));

  // The English base is applied in every install; the other locale files only
  // when locales are included. `0000-…` sorts first, so the en fallback lands
  // before any localized row.
  const locales: PlannedMigration[] = localeEntries
    .filter(isSql)
    .filter((file) => includeLocales || file === ALWAYS_APPLIED_LOCALE)
    .slice()
    .sort()
    .map((file) => ({ id: `locales/${file}`, subdir: "locales", file }));

  return [...core, ...locales];
}

/**
 * Reduces a migration file to the form that is hashed (review #86): `--` line
 * comments and `/* … *\/` block comments are dropped and every run of
 * whitespace outside a literal collapses to one space. Single-quoted strings
 * and double-quoted identifiers are kept VERBATIM (a `--` inside an email
 * template's HTML is data, not a comment). Dollar-quoted bodies (`$$`,
 * `$tag$`) are NOT literals here: a comment inside a plpgsql body is still a
 * comment and its layout still layout, so the same rules apply inside them.
 * Backslashes are not special (the files use standard_conforming_strings, no
 * `E''` literals).
 *
 * Why normalise at all: the repo DELIBERATELY edits comments in frozen files
 * (the July comment audit, review #403's sweep) and every such edit would
 * otherwise invalidate the ledger row in every migrated database and the CI
 * pin. Comments and layout have no effect on what a migration does, so they
 * are not part of its identity; any DDL/DML change — one character inside a
 * literal included — still produces a different hash.
 */
export function normalizeMigrationSql(sql: string): string {
  const src = sql.replace(/\r\n/g, "\n");
  let out = "";
  let i = 0;
  const n = src.length;
  let pendingSpace = false;
  const emit = (s: string) => {
    if (pendingSpace && out.length > 0) out += " ";
    pendingSpace = false;
    out += s;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    // Line comment → drop to end of line (the newline itself is whitespace).
    if (c === "-" && next === "-") {
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    // Block comment (PostgreSQL nests them) → drop entirely.
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
    // Single-quoted string ('' is an escaped quote) / double-quoted identifier
    // ("" likewise) → copied verbatim, whitespace and all.
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
      emit(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      pendingSpace = true;
      i++;
      continue;
    }
    emit(c);
    i++;
  }
  return out;
}

/**
 * Content checksum recorded in the `app_schema_migrations.checksum` ledger
 * column (review #86): sha256 of {@link normalizeMigrationSql}'s output, so a
 * CRLF checkout, a re-flowed comment or a re-indented block hash the same as
 * CI's copy, while any change to what the file DOES is a different hash.
 * The same function produces the pins in tests/unit/migration-checksums.test.ts.
 */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(normalizeMigrationSql(sql), "utf8").digest("hex");
}

export type LedgerChecksumVerdict = "match" | "backfill";

/**
 * Reconciles the ledgered checksum of an ALREADY-APPLIED migration with the
 * hash of the file on disk (review #86).
 *
 *   - `null` stored (a row written before the column existed) → `backfill`:
 *     the runner records the current hash and logs that it did.
 *   - equal → `match`.
 *   - different → throws. A frozen file edited after being applied silently
 *     diverges environments (an existing database skips it, a fresh one gets
 *     the edited DDL), so the runner MUST fail loudly with the id and both
 *     hashes rather than proceed. Because the hash ignores comments and
 *     whitespace ({@link normalizeMigrationSql}), a mismatch always means a
 *     functional change, never a re-flowed comment.
 */
export function reconcileLedgerChecksum(
  id: string,
  stored: string | null,
  actual: string,
): LedgerChecksumVerdict {
  if (stored === null) return "backfill";
  if (stored === actual) return "match";
  throw new Error(
    `[migrate] checksum mismatch for applied migration "${id}": ledger has ${stored}, ` +
      `file on disk hashes to ${actual}. Applied migrations are frozen — restore the file. ` +
      `(Comments and whitespace are not hashed, so this is a change to what the file DOES; ` +
      `only if that change is deliberate and already applied by hand, update the ledger row ` +
      `on purpose: update app_schema_migrations set checksum = '${actual}' where id = '${id}'.)`,
  );
}
