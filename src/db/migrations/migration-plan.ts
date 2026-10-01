import { createHash } from "node:crypto";

/**
 * Pure migration-planning helpers — deliberately side-effect-free (no fs, no
 * db) so the ordering + locale-inclusion + ledger-checksum logic is
 * unit-testable without a database. The runner (`run-migrations.ts`) supplies
 * the raw directory listings and the flag; this module decides WHAT to apply
 * and in WHAT order, how a ledgered checksum is reconciled, and how a
 * consolidated core file is recognised in a database that applied the files
 * it folds in.
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
 *              already-migrated database recognises them and skips; a
 *              consolidation replaces files under a NEW id and names the ids
 *              it folds, {@link CONSOLIDATED_CORE_MIGRATIONS}).
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

/**
 * The CORE migrations this build's code depends on, in ledger-id form. The
 * readiness probe (`GET /api/health/ready`) checks every id here against
 * `app_schema_migrations` and reports `schema_behind` (503) when one is
 * missing, so a build that was promoted ahead of its migration — the exact
 * failure mode of 0004 on a Vercel git-integration deploy, where nothing runs
 * `db:app:migrate` before the new code goes live (review #43 landing gate) —
 * is visible with an unauthenticated curl instead of surfacing as 500s on the
 * first real request that reads the new column.
 *
 * A literal list rather than a runtime `readdir`: the migrations directory is
 * not part of the traced serverless/standalone bundle, and the list must
 * describe what THIS build expects, not whatever happens to be on disk.
 * `tests/unit/migration-plan.test.ts` pins it to the actual core `*.sql`
 * files, so adding the next core file (0003) without extending this list fails CI.
 *
 * A consolidated id is satisfied by its folded ids too
 * ({@link missingCoreMigrations}), so a database migrated before the
 * consolidation is ready for this build before any runner has recorded it.
 */
export const REQUIRED_CORE_MIGRATIONS: readonly string[] = [
  "0001-initial-schema.sql",
  "0002-release.sql",
];

/** One core file folded into a consolidated one, as databases ledgered it. */
export interface FoldedMigration {
  /** Its ledger id: the bare filename it had before the consolidation. */
  readonly id: string;
  /** Its {@link migrationChecksum}, as every database that applied it recorded it. */
  readonly checksum: string;
}

export interface ConsolidatedMigration {
  /**
   * The last commit that still has the folded files individually. A database
   * that applied only some of them is brought up to date from there first.
   */
  readonly lastCommitWithFiles: string;
  /** The folded files, in the order they were applied and appear in the file. */
  readonly folds: readonly FoldedMigration[];
}

/**
 * Core files that replace several earlier ones (MIG, 2026-09-30), by ledger
 * id. `0002-release.sql` is the seven files 0002…0008 concatenated verbatim,
 * each between `-- ===== BEGIN folded <id> =====` / `-- ===== END folded <id>
 * =====` banners, so a new database applies two core files.
 *
 * Why a map and not a plain squash: the ledger checksums every applied file
 * (review #86) and the readiness probe requires every id in
 * {@link REQUIRED_CORE_MIGRATIONS} (review #43). A new id alone would make a
 * database migrated before the consolidation re-apply the seven files (0007's
 * provider-token scrub included) and report `schema_behind` until then. With
 * this map the runner RECORDS the consolidated id there instead of applying it
 * ({@link planConsolidatedMigrations}), and readiness counts the folded ids as
 * the consolidated one. The legacy ledger rows are kept: they are history, the
 * runner ignores ids it has no file for, and a build from before the
 * consolidation, after a rollback, still finds them.
 *
 * Each checksum is the one production's ledger holds (read 2026-09-30), and
 * tests/unit/migration-checksums.test.ts proves that each banner-delimited
 * section of the consolidated file still hashes to it.
 */
export const CONSOLIDATED_CORE_MIGRATIONS: Readonly<Record<string, ConsolidatedMigration>> = {
  "0002-release.sql": {
    lastCommitWithFiles: "79b4803",
    folds: [
      {
        id: "0002-admin-groups-permissions.sql",
        checksum: "783862abb174ea42909c0df3a81e714bf5ead7a846867ae73f56784b3a1ee2cf",
      },
      {
        id: "0003-outbox-delivery-payload.sql",
        checksum: "fdd26f801f88bc4be710d37de33b96021c14089062736848279803d427db4957",
      },
      {
        id: "0004-oauth-client-secret-rotated-at.sql",
        checksum: "73f26c633f21ed2e1062002f47746aeaa45be49cb34f8989812c90442b968e30",
      },
      {
        id: "0005-integrity-constraints.sql",
        checksum: "ac34b3d715be75c70ed4629a69ad84e127851e0a24c44dbedf721c3bac2ff8f4",
      },
      {
        id: "0006-rate-limit-buckets.sql",
        checksum: "9b8eb96e149bf1fa4f3ae632c33237786775ede08da864910fc0b2641b237f40",
      },
      {
        id: "0007-uniqueness-search-indexes-token-scrub.sql",
        checksum: "83cfadc52081321bbf06cf05d74480a482824e5d3e733e81956d6c5b70a16e19",
      },
      {
        id: "0008-user-data-export-erasure.sql",
        checksum: "a30fde495d3062758e59d84ee613d7c11a08535ac3414ce85d1d0a010a0aae50",
      },
    ],
  },
};

/** What the runner does about one consolidated id, before it applies anything. */
export type ConsolidationStep =
  /** Ledgered under its own id: the ordinary checksum reconciliation covers it. */
  | { id: string; action: "ledgered" }
  /**
   * Every folded id is ledgered: write the consolidated id's ledger row, run
   * none of the file. `unverified` lists folded ids whose row has no checksum
   * (ledgered before review #86), accepted without comparison.
   */
  | { id: string; action: "record"; unverified: string[] }
  /** No folded id is ledgered (a database that never had them): apply the file as usual. */
  | { id: string; action: "apply" };

/**
 * Decides, for every consolidated id, what the runner does with `ledger` (the
 * ledger's id → checksum map), MIG:
 *
 *   - the consolidated id is ledgered → `ledgered`;
 *   - absent, every folded id ledgered → `record`. Each stored checksum must
 *     equal its pin: a different one means this database applied another
 *     version of that file than the one folded in, so recording the
 *     consolidated id would claim a schema it may not have. That throws, with
 *     the id and both hashes. A NULL checksum is accepted and reported in
 *     `unverified`;
 *   - absent, only SOME folded ids ledgered → throws, naming the missing ids.
 *     The file cannot be applied in part and applying it whole would re-run
 *     the folded files already applied, so the database is brought up to date
 *     from {@link ConsolidatedMigration.lastCommitWithFiles} first;
 *   - absent, no folded id ledgered → `apply` (a new database).
 *
 * Pure, so every verdict is unit-tested; the runner calls it before it writes
 * anything, so a refusal leaves the database as it found it.
 */
export function planConsolidatedMigrations(
  ledger: ReadonlyMap<string, string | null>,
  consolidated: Readonly<Record<string, ConsolidatedMigration>> = CONSOLIDATED_CORE_MIGRATIONS,
): ConsolidationStep[] {
  return Object.entries(consolidated).map(([id, { lastCommitWithFiles, folds }]) => {
    if (ledger.has(id)) return { id, action: "ledgered" };
    const missing = folds.filter((fold) => !ledger.has(fold.id)).map((fold) => fold.id);
    if (missing.length === folds.length) return { id, action: "apply" };
    if (missing.length > 0) {
      throw new Error(
        `[migrate] "${id}" consolidates ${folds.map((fold) => fold.id).join(", ")}, and this ` +
          `database has applied only some of them (missing: ${missing.join(", ")}). Nothing was ` +
          `applied. First run pnpm db:app:migrate from commit ${lastCommitWithFiles}, the last ` +
          `with the individual files, then run it again from this build, which records "${id}".`,
      );
    }
    const unverified: string[] = [];
    for (const fold of folds) {
      const stored = ledger.get(fold.id) ?? null;
      if (stored === null) {
        unverified.push(fold.id);
      } else if (stored !== fold.checksum) {
        throw new Error(
          `[migrate] cannot record "${id}": the ledger has ${stored} for "${fold.id}", but the ` +
            `${fold.id} section of "${id}" hashes to ${fold.checksum}. This database applied a ` +
            `different ${fold.id} than the one folded in, so its schema may not be what "${id}" ` +
            `creates. Nothing was applied or recorded. Compare the database with that section; ` +
            `only once it matches, correct the row on purpose: update app_schema_migrations set ` +
            `checksum = '${fold.checksum}' where id = '${fold.id}'.`,
        );
      }
    }
    return { id, action: "record", unverified };
  });
}

/**
 * Every ledger id {@link missingCoreMigrations} can use: the required ids,
 * then the folded ids that stand in for a consolidated one. The readiness
 * probe asks the ledger for exactly these (MIG). Asked for the required ids
 * alone it would never see a pre-consolidation database's folded rows, and
 * would call that database behind.
 */
export const CORE_MIGRATION_LEDGER_IDS: readonly string[] = [
  ...REQUIRED_CORE_MIGRATIONS,
  ...REQUIRED_CORE_MIGRATIONS.flatMap(
    (id) => CONSOLIDATED_CORE_MIGRATIONS[id]?.folds.map((fold) => fold.id) ?? [],
  ),
];

/**
 * Ids from {@link REQUIRED_CORE_MIGRATIONS} that are absent from `applied`
 * (the ledger's `id` column), in apply order. Empty means the schema is at
 * least as new as this build needs. A consolidated id counts as present when
 * it is ledgered OR every id it folds is (MIG): a database migrated before
 * the consolidation carries the same schema under the legacy ids, and is ready
 * before any runner has recorded the consolidated id. A database with only
 * some of them is behind, and the consolidated id is what it lacks.
 */
export function missingCoreMigrations(applied: Iterable<string>): string[] {
  const have = new Set(applied);
  return REQUIRED_CORE_MIGRATIONS.filter((id) => {
    if (have.has(id)) return false;
    const folds = CONSOLIDATED_CORE_MIGRATIONS[id]?.folds;
    return !(folds !== undefined && folds.every((fold) => have.has(fold.id)));
  });
}
