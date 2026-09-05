import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { migrationChecksum, reconcileLedgerChecksum } from "@/db/migrations/migration-plan";

/**
 * Review #86 — applied migrations are frozen, and the runner now proves it
 * against the `app_schema_migrations.checksum` ledger column. This suite is
 * the CI half of that guarantee: the sha256 of every APPLIED core file is
 * pinned here, so an edit to a frozen file fails CI immediately — before a
 * runner in any environment ever sees the mismatch.
 *
 * Updating a pin is a deliberate act (comment-only edits are the only
 * legitimate reason; DDL never changes in an applied file). Every database
 * that already applied the file then needs its ledger row updated on purpose
 * — the runner's mismatch error prints the exact statement.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");

/** id → sha256 of the LF-normalised file content. */
const FROZEN: ReadonlyArray<[id: string, sha256: string]> = [
  ["0001-initial-schema.sql", "ece7473606e5e26dbdf8e9a1d3c4bf853d7cd9392585cfcfad3f192ccf45d19d"],
  [
    "0002-admin-groups-permissions.sql",
    "6746eda2e2ceebc573a1634f28e2760ef05cbb5f700a3544e90a5869533f2e20",
  ],
  [
    "0003-outbox-delivery-payload.sql",
    "0f6b04c1be2335f964b9006b45a37b9c1090b7894d0746628fc89aad33b46128",
  ],
  [
    "0004-integrity-constraints.sql",
    "6d0ea097c6cd3d62361e8bb168722b2bd3c53ad7bde9d220b5fa601d0e600871",
  ],
];

describe("migrationChecksum", () => {
  it("is the sha256 of the content, independent of CRLF vs LF line endings", () => {
    const lf = "select 1;\nselect 2;\n";
    const crlf = "select 1;\r\nselect 2;\r\n";
    expect(migrationChecksum(lf)).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationChecksum(crlf)).toBe(migrationChecksum(lf));
    // …but any real content change is a different hash.
    expect(migrationChecksum("select 1;\nselect 3;\n")).not.toBe(migrationChecksum(lf));
  });
});

describe("frozen core migrations keep their pinned sha256 (review #86)", () => {
  it.each(FROZEN)("%s", (id, expected) => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, id), "utf8");
    expect(
      migrationChecksum(sql),
      `${id} changed after being applied. Frozen files are never edited; if this was a deliberate comment-only fix, update the pin here AND the ledger row in every migrated database.`,
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
