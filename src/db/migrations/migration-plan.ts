/**
 * Pure migration-planning helpers — deliberately side-effect-free (no fs, no
 * db) so the ordering + locale-inclusion logic is unit-testable without a
 * database. The runner (`run-migrations.ts`) supplies the raw directory
 * listings and the flag; this module decides WHAT to apply and in WHAT order.
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
 * Builds the ordered apply-list: CORE migrations first (top-level `*.sql`,
 * excluding the Better-Auth-owned `better-auth*` files, lexical), then the
 * LOCALE migrations (`locales/*.sql`, lexical) — UNLESS `includeLocales` is
 * false, in which case the locale pass is skipped entirely.
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

  if (!includeLocales) return core;

  const locales: PlannedMigration[] = localeEntries
    .filter(isSql)
    .slice()
    .sort()
    .map((file) => ({ id: `locales/${file}`, subdir: "locales", file }));

  return [...core, ...locales];
}
