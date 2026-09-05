import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrationChecksum,
  normalizeMigrationSql,
  reconcileLedgerChecksum,
} from "@/db/migrations/migration-plan";

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
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");

/** id → sha256 of the normalised file content. */
const FROZEN: ReadonlyArray<[id: string, sha256: string]> = [
  ["0001-initial-schema.sql", "ced296b180c9b94e0e62e00929c3d43147ac8e7e8e20b2642c586ed0b112111b"],
  [
    "0002-admin-groups-permissions.sql",
    "783862abb174ea42909c0df3a81e714bf5ead7a846867ae73f56784b3a1ee2cf",
  ],
  [
    "0003-outbox-delivery-payload.sql",
    "fdd26f801f88bc4be710d37de33b96021c14089062736848279803d427db4957",
  ],
  [
    "0004-oauth-client-secret-rotated-at.sql",
    "73f26c633f21ed2e1062002f47746aeaa45be49cb34f8989812c90442b968e30",
  ],
  [
    "0005-integrity-constraints.sql",
    "ac34b3d715be75c70ed4629a69ad84e127851e0a24c44dbedf721c3bac2ff8f4",
  ],
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
