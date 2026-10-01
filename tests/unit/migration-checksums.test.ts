import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONSOLIDATED_CORE_MIGRATIONS,
  migrationChecksum,
  normalizeMigrationSql,
  reconcileLedgerChecksum,
} from "@/db/migrations/migration-plan";
import { foldedSections } from "../helpers/core-migrations";

/**
 * Review #86 — applied migrations are frozen, and the runner now proves it
 * against the `app_schema_migrations.checksum` ledger column. This suite is
 * the CI half of that guarantee: the sha256 of every numbered core file is
 * pinned here, so a functional edit to a frozen file fails CI immediately —
 * before a runner in any environment ever sees the mismatch.
 *
 * The hash is of the NORMALISED file (`normalizeMigrationSql`: comments
 * stripped, whitespace collapsed, string literals verbatim), so the
 * comment-only edits this repo deliberately makes to frozen files (the July
 * comment audit, review #403) do not move a pin. A pin therefore changes only
 * when what the file DOES changes — for an already-applied file that is a
 * bug, never a bookkeeping update. Regenerate a pin with
 * `node -e` over `migrationChecksum` only for a file that has not been
 * applied anywhere yet.
 *
 * MIG: `0002-release.sql` folds the seven files 0002…0008 that production
 * ledgered one by one. Their pins live with the consolidation map in
 * migration-plan.ts (`CONSOLIDATED_CORE_MIGRATIONS`), because the runner checks
 * a legacy ledger against them; here each banner-delimited section of the file
 * is hashed and must equal its pin, which proves every folded section does
 * exactly what its file did where it was applied.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");

/** id → sha256 of the normalised file content. */
const FROZEN: ReadonlyArray<[id: string, sha256: string]> = [
  ["0001-initial-schema.sql", "ced296b180c9b94e0e62e00929c3d43147ac8e7e8e20b2642c586ed0b112111b"],
  ["0002-release.sql", "0bf69a18f0c06e2ce3135e2cbab9819b08a58c72be53b8a1c0b60f9dd65ad05b"],
];

describe("normalizeMigrationSql", () => {
  it("drops `--` line comments and block comments, collapses whitespace, normalises CRLF", () => {
    const messy =
      "-- header\r\n/* block\r\n comment */\r\ncreate   table\tt (\r\n  id int -- trailing\r\n);\r\n";
    expect(normalizeMigrationSql(messy)).toBe("create table t ( id int );");
  });

  it("keeps single-quoted strings and double-quoted identifiers VERBATIM (a `--` or spacing inside is data)", () => {
    const sql = `insert into "t--x" values ('<!-- a  b -->', 'it''s -- not a comment');`;
    expect(normalizeMigrationSql(sql)).toBe(sql);
    expect(normalizeMigrationSql(`select  '  two  spaces  ';`)).toBe(`select '  two  spaces  ';`);
  });

  it("applies the same rules inside dollar-quoted bodies (a plpgsql comment is still a comment)", () => {
    const a =
      "create function f() returns int language plpgsql as $$\nbegin\n  -- why\n  return 1;\nend $$;";
    const b = "create function f() returns int language plpgsql as $$ begin return 1; end $$;";
    expect(normalizeMigrationSql(a)).toBe(normalizeMigrationSql(b));
  });
});

describe("migrationChecksum", () => {
  it("is the sha256 of the normalised content — comment/whitespace edits do not move it", () => {
    const lf = "select 1;\nselect 2;\n";
    const crlf = "select 1;\r\nselect 2;\r\n";
    const commented = "-- a new comment\nselect 1;\n\n\n   select   2;\n";
    expect(migrationChecksum(lf)).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum(crlf)).toBe(migrationChecksum(lf));
    expect(migrationChecksum(commented)).toBe(migrationChecksum(lf));
  });

  it("changes on any functional edit, including one character inside a literal", () => {
    const base = "insert into t values ('a');\n";
    expect(migrationChecksum("insert into t values ('b');\n")).not.toBe(migrationChecksum(base));
    expect(migrationChecksum("insert into t values ('a ');\n")).not.toBe(migrationChecksum(base));
    expect(migrationChecksum("insert into u values ('a');\n")).not.toBe(migrationChecksum(base));
  });
});

describe("frozen core migrations keep their pinned sha256 (review #86)", () => {
  it("pins EVERY numbered core file in src/db/migrations — a new file must be added here", () => {
    // Completeness guard: without it a new `NNNN-*.sql` ships unpinned while
    // the header above claims every numbered file is covered. Sorted on both
    // sides so the assertion also catches a duplicated prefix (two branches
    // both claiming the next number — 0004 happened) as a visible diff rather
    // than a silently unpinned sibling.
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}-.*\.sql$/.test(f))
      .sort();
    expect(onDisk).toEqual(FROZEN.map(([id]) => id).sort());
  });

  it.each(FROZEN)("%s", (id, expected) => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, id), "utf8");
    expect(
      migrationChecksum(sql),
      `${id} changed after being applied — and not just a comment, the hash ignores those. Frozen files are never edited; put the change in a new migration.`,
    ).toBe(expected);
  });
});

describe("0002-release.sql folds 0002…0008 verbatim (MIG)", () => {
  const RELEASE = "0002-release.sql";
  const sql = readFileSync(path.join(MIGRATIONS_DIR, RELEASE), "utf8");
  const { folds } = CONSOLIDATED_CORE_MIGRATIONS[RELEASE]!;
  const sections = foldedSections(sql);

  it("has exactly one section per folded id, in the order they were applied", () => {
    expect(sections.map((section) => section.id)).toEqual(folds.map((fold) => fold.id));
    expect(folds.map((fold) => fold.id)).toEqual([
      "0002-admin-groups-permissions.sql",
      "0003-outbox-delivery-payload.sql",
      "0004-oauth-client-secret-rotated-at.sql",
      "0005-integrity-constraints.sql",
      "0006-rate-limit-buckets.sql",
      "0007-uniqueness-search-indexes-token-scrub.sql",
      "0008-user-data-export-erasure.sql",
    ]);
  });

  it.each(folds.map((fold) => [fold.id, fold.checksum] as const))(
    "the %s section hashes to the checksum production ledgered for that file",
    (id, pinned) => {
      const section = sections.find((candidate) => candidate.id === id)!;
      // Each folded file opened with a comment naming itself.
      expect(section.sql.startsWith(`-- ${id}\n`)).toBe(true);
      expect(
        migrationChecksum(section.sql),
        `the ${id} section of ${RELEASE} no longer does what ${id} did. Every database migrated before the consolidation has it under this checksum; restore the section.`,
      ).toBe(pinned);
    },
  );

  it("carries nothing executable outside its sections, so the section pins cover the whole file", () => {
    let outside = sql;
    for (const section of sections) outside = outside.replace(section.sql, "");
    expect(normalizeMigrationSql(outside)).toBe("");
    // So the file's own pin is its sections' normalised SQL, in order.
    expect(migrationChecksum(sql)).toBe(
      migrationChecksum(sections.map((section) => section.sql).join("\n")),
    );
  });
});

describe("foldedSections", () => {
  const folded = (id: string, body: string) =>
    `-- ===== BEGIN folded ${id} =====\n${body}-- ===== END folded ${id} =====\n`;

  it("returns each section's text between its banners, byte for byte", () => {
    const sql = `-- header\n\n${folded("0002-a.sql", "select 1;\n")}\n${folded("0003-b.sql", "-- b\nselect 2;\n")}`;
    expect(foldedSections(sql)).toEqual([
      { id: "0002-a.sql", sql: "select 1;\n" },
      { id: "0003-b.sql", sql: "-- b\nselect 2;\n" },
    ]);
  });

  it("ignores a banner that does not start its line (the file's header quotes the format)", () => {
    expect(foldedSections("--   -- ===== BEGIN folded 0002-a.sql =====\n")).toEqual([]);
  });

  it.each([
    ["an unclosed section", "-- ===== BEGIN folded 0002-a.sql =====\nselect 1;\n"],
    ["an END without its BEGIN", "select 1;\n-- ===== END folded 0002-a.sql =====\n"],
    [
      "a mismatched END",
      "-- ===== BEGIN folded 0002-a.sql =====\nselect 1;\n-- ===== END folded 0003-b.sql =====\n",
    ],
    [
      "a nested BEGIN",
      "-- ===== BEGIN folded 0002-a.sql =====\n-- ===== BEGIN folded 0003-b.sql =====\n",
    ],
  ])("throws on %s", (_label, sql) => {
    expect(() => foldedSections(sql)).toThrow(/folded/);
  });
});

describe("reconcileLedgerChecksum", () => {
  const actual = "a".repeat(64);

  it("backfills a row ledgered before the column existed", () => {
    expect(reconcileLedgerChecksum("0001-initial-schema.sql", null, actual)).toBe("backfill");
  });

  it("matches an equal hash", () => {
    expect(reconcileLedgerChecksum("0001-initial-schema.sql", actual, actual)).toBe("match");
  });

  it("fails loudly on a mismatch, naming the id and BOTH hashes", () => {
    const stored = "b".repeat(64);
    expect(() => reconcileLedgerChecksum("0001-initial-schema.sql", stored, actual)).toThrow(
      /0001-initial-schema\.sql.*b{64}.*a{64}/s,
    );
  });
});
