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
 * Content checksum recorded in the `app_schema_migrations.checksum` ledger
 * column (review #86). Line endings are normalised to `\n` first so a CRLF
 * checkout (Windows without `.gitattributes` honoured) and CI's LF checkout
 * hash the same file — otherwise one database migrated from two machines
 * would report a false mismatch.
 */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
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
 *     hashes rather than proceed.
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
      `file on disk hashes to ${actual}. Applied migrations are frozen — restore the file, ` +
      `or, if the edit was deliberate and comment-only, update the ledger row on purpose ` +
      `(update app_schema_migrations set checksum = '${actual}' where id = '${id}').`,
  );
}
