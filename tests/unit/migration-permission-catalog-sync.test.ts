import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSION_CATALOG,
  SUPERADMIN_PERMISSION,
} from "@/lib/admin/permissions";

/**
 * Drift guard between the CORE migrations' baseline `app_permissions` seed and
 * `ADMIN_PERMISSION_CATALOG` (the runtime / seed-script source of truth).
 *
 * `0001-initial-schema.sql` promises its catalog "MUST stay in sync" with the
 * TypeScript catalog, but nothing enforced it — the `admin.groups.*` keys were
 * added to the catalog without a matching migration row, leaving a
 * migrated-but-not-seeded database with no group-admin permissions (fixed by
 * `0002-admin-groups-permissions.sql`). This test parses every seeded
 * (key, description) tuple out of the top-level core migration files and diffs
 * the union against the catalog in BOTH directions, so a new catalog entry
 * without a forward migration — or a migration-only key the runtime doesn't
 * know — fails CI. 0001 is frozen, so new keys belong in a new `NNNN-*.sql`.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, "../../src/db/migrations");

/** (key, description) rows seeded into `app_permissions` across all core files. */
function collectSeededPermissions(): Map<string, string> {
  const coreFiles = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => !name.startsWith("better-auth"))
    .sort();
  expect(coreFiles.length).toBeGreaterThan(0);

  const seeded = new Map<string, string>();
  const statementRe =
    /insert into app_permissions\s*\(key,\s*description\)\s*values([\s\S]*?)on conflict\s*\(key\)\s*do nothing/gi;
  const tupleRe = /\(\s*'((?:[^']|'')+)'\s*,\s*'((?:[^']|'')+)'\s*\)/g;
  const unescape = (sqlLiteral: string) => sqlLiteral.replace(/''/g, "'");

  for (const file of coreFiles) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of sql.matchAll(statementRe)) {
      for (const tuple of statement[1]!.matchAll(tupleRe)) {
        const key = unescape(tuple[1]!);
        // A key re-seeded by a later migration would silently no-op at
        // runtime (`on conflict do nothing`) — flag the redundancy here.
        expect(seeded.has(key), `duplicate seed for '${key}' in ${file}`).toBe(false);
        seeded.set(key, unescape(tuple[2]!));
      }
    }
  }
  return seeded;
}

describe("core migrations ↔ ADMIN_PERMISSION_CATALOG sync", () => {
  const seeded = collectSeededPermissions();

  it("parses a plausible seed (guards against the SQL shape drifting past the regex)", () => {
    // 35 catalog keys + the superuser marker; a rewrite of the insert
    // syntax that this parser no longer matches shows up as a collapse here.
    expect(seeded.size).toBeGreaterThanOrEqual(ADMIN_PERMISSION_CATALOG.length + 1);
  });

  it("seeds every catalog entry with the exact catalog description", () => {
    const missing = ADMIN_PERMISSION_CATALOG.filter((p) => !seeded.has(p.key)).map((p) => p.key);
    expect(missing, "catalog keys with no migration seed — add a new NNNN-*.sql").toEqual([]);
    for (const { key, description } of ADMIN_PERMISSION_CATALOG) {
      expect(seeded.get(key), `description drift for '${key}'`).toBe(description);
    }
  });

  it("seeds no admin.* key the catalog does not define", () => {
    const catalogKeys = new Set(ADMIN_PERMISSION_CATALOG.map((p) => p.key));
    const unknown = [...seeded.keys()].filter(
      (key) => key.startsWith("admin.") && !catalogKeys.has(key),
    );
    expect(unknown, "migration-seeded admin.* keys unknown to the runtime catalog").toEqual([]);
  });

  it("seeds the superuser marker", () => {
    expect(seeded.has(SUPERADMIN_PERMISSION)).toBe(true);
  });
});
