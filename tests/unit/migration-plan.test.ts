import { readdirSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALWAYS_APPLIED_LOCALE,
  CONSOLIDATED_CORE_MIGRATIONS,
  CORE_MIGRATION_LEDGER_IDS,
  REQUIRED_CORE_MIGRATIONS,
  missingCoreMigrations,
  planConsolidatedMigrations,
  planMigrations,
  shouldIncludeLocales,
} from "@/db/migrations/migration-plan";

/**
 * Unit coverage for the pure migration planner. The runner (`run-migrations.ts`)
 * is a thin fs+db shell around these two functions, so pinning the ordering +
 * locale-inclusion + ledger-id rules here is the regression guard for the
 * "always-on English base + optional localized files" layout.
 */
// Real core is `0001-initial-schema.sql` + `0002-release.sql` (MIG); the
// `0010-…` entry is a hypothetical future forward migration, kept here so the
// core-sort path stays covered. Deliberately out of order.
const CORE = [
  "0010-example-forward.sql",
  "0001-initial-schema.sql",
  "better-auth-schema.sql", // owned by Better Auth — must be skipped
  "locales", // the subdirectory entry returned by readdir — not a .sql
  "run-migrations.ts", // the runner itself — not a .sql
  "migration-plan.ts",
];
// Deliberately out of order — the planner must sort them. Includes the
// always-on English base (`0000-…`) alongside two localized files.
const LOCALES = [
  "0002-email-templates-es.sql",
  "0001-email-templates-fr.sql",
  "0000-email-templates-en.sql",
];

describe("shouldIncludeLocales", () => {
  it("includes locales by default (unset/empty)", () => {
    expect(shouldIncludeLocales(undefined)).toBe(true);
    expect(shouldIncludeLocales("")).toBe(true);
    expect(shouldIncludeLocales("  ")).toBe(true);
  });

  it("includes for affirmative / unrecognized values", () => {
    for (const v of ["1", "true", "yes", "on", "anything"]) {
      expect(shouldIncludeLocales(v)).toBe(true);
    }
  });

  it("excludes only for explicit off values (any case)", () => {
    for (const v of ["0", "false", "no", "off", "FALSE", "Off", " no "]) {
      expect(shouldIncludeLocales(v)).toBe(false);
    }
  });
});

describe("planMigrations", () => {
  it("orders core (sorted) then locales (sorted), skipping better-auth + non-sql", () => {
    const plan = planMigrations(CORE, LOCALES, true);
    expect(plan.map((m) => m.id)).toEqual([
      "0001-initial-schema.sql",
      "0010-example-forward.sql",
      "locales/0000-email-templates-en.sql",
      "locales/0001-email-templates-fr.sql",
      "locales/0002-email-templates-es.sql",
    ]);
  });

  it("tags subdir + bare filename so the runner reads the right path", () => {
    const plan = planMigrations(CORE, LOCALES, true);
    const core = plan.find((m) => m.id === "0001-initial-schema.sql")!;
    expect(core.subdir).toBe("");
    expect(core.file).toBe("0001-initial-schema.sql");
    const locale = plan.find((m) => m.id === "locales/0001-email-templates-fr.sql")!;
    expect(locale.subdir).toBe("locales");
    expect(locale.file).toBe("0001-email-templates-fr.sql");
  });

  it("keeps ONLY the always-on English base when locales are excluded", () => {
    const plan = planMigrations(CORE, LOCALES, false);
    expect(plan.map((m) => m.id)).toEqual([
      "0001-initial-schema.sql",
      "0010-example-forward.sql",
      "locales/0000-email-templates-en.sql",
    ]);
    // The English base (the fallback every locale resolves to) still lands…
    expect(plan.some((m) => m.file === ALWAYS_APPLIED_LOCALE)).toBe(true);
    // …but the localized files are skipped.
    expect(plan.some((m) => m.id === "locales/0001-email-templates-fr.sql")).toBe(false);
    expect(plan.some((m) => m.id === "locales/0002-email-templates-es.sql")).toBe(false);
  });

  it("always applies the English base in BOTH modes", () => {
    for (const include of [true, false]) {
      const plan = planMigrations(CORE, LOCALES, include);
      const enBase = plan.filter((m) => m.file === ALWAYS_APPLIED_LOCALE);
      expect(enBase).toHaveLength(1);
      expect(enBase[0]!.id).toBe("locales/0000-email-templates-en.sql");
      expect(enBase[0]!.subdir).toBe("locales");
    }
  });

  it("never emits a Better-Auth-owned file as a core migration", () => {
    const plan = planMigrations(CORE, LOCALES, true);
    expect(plan.some((m) => m.file.startsWith("better-auth"))).toBe(false);
  });
});

const BASELINE = "0001-initial-schema.sql";
const RELEASE = "0002-release.sql";
const FOLDS = CONSOLIDATED_CORE_MIGRATIONS[RELEASE]!.folds;
const LEGACY_IDS = FOLDS.map((fold) => fold.id);
const EN_BASE = "locales/0000-email-templates-en.sql";

/** The ledger of a database migrated one file at a time before MIG: 0001…0008 under their pins. */
function legacyLedger(): Map<string, string | null> {
  return new Map<string, string | null>([
    [BASELINE, "c".repeat(64)],
    ...FOLDS.map((fold): [string, string] => [fold.id, fold.checksum]),
    [EN_BASE, "d".repeat(64)],
  ]);
}

describe("REQUIRED_CORE_MIGRATIONS (readiness gate, review #43 landing gate)", () => {
  it("equals the core *.sql files actually in src/db/migrations, in apply order", () => {
    // The readiness probe can only catch a build promoted ahead of its
    // migration if the list names EVERY core file this build ships. Pin it
    // to the real directory so adding the next core file (0003) without extending the list fails
    // here rather than silently passing readiness on a stale schema.
    const dir = path.resolve(__dirname, "../../src/db/migrations");
    const onDisk = planMigrations(readdirSync(dir), [], false)
      .filter((m) => m.subdir === "")
      .map((m) => m.id);
    expect([...REQUIRED_CORE_MIGRATIONS]).toEqual(onDisk);
  });

  it("is the frozen baseline and the consolidated release (MIG), never a Better-Auth file", () => {
    expect([...REQUIRED_CORE_MIGRATIONS]).toEqual([BASELINE, RELEASE]);
    expect(REQUIRED_CORE_MIGRATIONS.some((id) => id.startsWith("better-auth"))).toBe(false);
  });
});

describe("CONSOLIDATED_CORE_MIGRATIONS (MIG)", () => {
  it("folds 0002…0008 into 0002-release.sql, the last commit with the files being 79b4803", () => {
    expect(Object.keys(CONSOLIDATED_CORE_MIGRATIONS)).toEqual([RELEASE]);
    expect(CONSOLIDATED_CORE_MIGRATIONS[RELEASE]!.lastCommitWithFiles).toBe("79b4803");
    expect(LEGACY_IDS.map((id) => id.slice(0, 5))).toEqual([
      "0002-",
      "0003-",
      "0004-",
      "0005-",
      "0006-",
      "0007-",
      "0008-",
    ]);
  });

  it("consolidates only required files, and no folded file is still on disk or required", () => {
    const onDisk = readdirSync(path.resolve(__dirname, "../../src/db/migrations"));
    for (const [id, { folds }] of Object.entries(CONSOLIDATED_CORE_MIGRATIONS)) {
      expect(REQUIRED_CORE_MIGRATIONS).toContain(id);
      expect(new Set(folds.map((fold) => fold.id)).size).toBe(folds.length);
      for (const fold of folds) {
        expect(onDisk).not.toContain(fold.id);
        expect(REQUIRED_CORE_MIGRATIONS).not.toContain(fold.id);
        expect(fold.checksum).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("planConsolidatedMigrations (MIG)", () => {
  it("leaves a consolidated id that is already ledgered to the ordinary checksum path", () => {
    const ledger = legacyLedger();
    ledger.set(RELEASE, "e".repeat(64));
    expect(planConsolidatedMigrations(ledger)).toEqual([{ id: RELEASE, action: "ledgered" }]);
    // A database created after the consolidation has no legacy rows at all.
    const fresh = new Map([
      [BASELINE, "c".repeat(64)],
      [RELEASE, null],
    ]);
    expect(planConsolidatedMigrations(fresh)).toEqual([{ id: RELEASE, action: "ledgered" }]);
  });

  it("records the consolidated id when every folded id is ledgered under its pin", () => {
    expect(planConsolidatedMigrations(legacyLedger())).toEqual([
      { id: RELEASE, action: "record", unverified: [] },
    ]);
  });

  it("records despite a NULL legacy checksum (ledgered before review #86), and reports it", () => {
    const ledger = legacyLedger();
    ledger.set("0003-outbox-delivery-payload.sql", null);
    ledger.set("0007-uniqueness-search-indexes-token-scrub.sql", null);
    expect(planConsolidatedMigrations(ledger)).toEqual([
      {
        id: RELEASE,
        action: "record",
        unverified: [
          "0003-outbox-delivery-payload.sql",
          "0007-uniqueness-search-indexes-token-scrub.sql",
        ],
      },
    ]);
  });

  it("refuses a partial legacy ledger, naming the missing ids and the commit to migrate from", () => {
    const ledger = legacyLedger();
    for (const id of LEGACY_IDS.slice(4)) ledger.delete(id); // at 0005
    const refusal = () => planConsolidatedMigrations(ledger);
    expect(refusal).toThrow(
      /only some of them \(missing: 0006-rate-limit-buckets\.sql, 0007-uniqueness-search-indexes-token-scrub\.sql, 0008-user-data-export-erasure\.sql\)/,
    );
    expect(refusal).toThrow(/Nothing was applied/);
    expect(refusal).toThrow(/pnpm db:app:migrate from commit 79b4803/);
  });

  it("refuses a folded id ledgered under another checksum, naming it and BOTH hashes", () => {
    const ledger = legacyLedger();
    ledger.set("0005-integrity-constraints.sql", "f".repeat(64));
    const pinned = FOLDS.find((fold) => fold.id === "0005-integrity-constraints.sql")!.checksum;
    const refusal = () => planConsolidatedMigrations(ledger);
    expect(refusal).toThrow(new RegExp(`f{64} for "0005-integrity-constraints\\.sql".*${pinned}`));
    expect(refusal).toThrow(/Nothing was applied or recorded/);
  });

  it("applies the consolidated file where no folded id is ledgered (a new database)", () => {
    expect(planConsolidatedMigrations(new Map())).toEqual([{ id: RELEASE, action: "apply" }]);
    const baselineOnly = new Map([[BASELINE, "c".repeat(64)]]);
    expect(planConsolidatedMigrations(baselineOnly)).toEqual([{ id: RELEASE, action: "apply" }]);
  });

  it("applies with none, records with all, refuses with any other set of folded ids (property)", () => {
    fc.assert(
      fc.property(
        fc.subarray(LEGACY_IDS),
        fc.subarray([EN_BASE, "locales/0001-email-templates-fr.sql", "0099-unknown.sql"]),
        (present, unrelated) => {
          const ledger = new Map<string, string | null>([[BASELINE, null]]);
          for (const id of unrelated) ledger.set(id, null);
          for (const fold of FOLDS)
            if (present.includes(fold.id)) ledger.set(fold.id, fold.checksum);
          if (present.length === 0) {
            expect(planConsolidatedMigrations(ledger)).toEqual([{ id: RELEASE, action: "apply" }]);
          } else if (present.length === FOLDS.length) {
            expect(planConsolidatedMigrations(ledger)).toEqual([
              { id: RELEASE, action: "record", unverified: [] },
            ]);
          } else {
            expect(() => planConsolidatedMigrations(ledger)).toThrow(/only some of them/);
          }
        },
      ),
    );
  });

  it("takes any consolidation map, naming that map's commit", () => {
    const map = {
      "0009-next.sql": {
        lastCommitWithFiles: "abc1234",
        folds: [
          { id: "0003-a.sql", checksum: "1".repeat(64) },
          { id: "0004-b.sql", checksum: "2".repeat(64) },
        ],
      },
    };
    const partial = new Map([["0003-a.sql", "1".repeat(64)]]);
    expect(() => planConsolidatedMigrations(partial, map)).toThrow(
      /"0009-next\.sql" consolidates 0003-a\.sql, 0004-b\.sql.*\(missing: 0004-b\.sql\).*commit abc1234/s,
    );
    partial.set("0004-b.sql", "2".repeat(64));
    expect(planConsolidatedMigrations(partial, map)).toEqual([
      { id: "0009-next.sql", action: "record", unverified: [] },
    ]);
  });
});

describe("CORE_MIGRATION_LEDGER_IDS (what readiness asks the ledger for, MIG)", () => {
  it("is the required ids followed by every id the release folds", () => {
    expect([...CORE_MIGRATION_LEDGER_IDS]).toEqual([BASELINE, RELEASE, ...LEGACY_IDS]);
  });
});

describe("missingCoreMigrations", () => {
  it("is empty when the ledger holds every required id (extra ledger rows are fine)", () => {
    const ledger = [...REQUIRED_CORE_MIGRATIONS, EN_BASE];
    expect(missingCoreMigrations(ledger)).toEqual([]);
  });

  it("is empty for a database migrated before the consolidation: 0001…0008, no 0002-release.sql (MIG)", () => {
    expect(missingCoreMigrations(legacyLedger().keys())).toEqual([]);
  });

  it("names the consolidated id when only some of its folded ids are ledgered (MIG)", () => {
    expect(missingCoreMigrations([BASELINE, ...LEGACY_IDS.slice(0, 4)])).toEqual([RELEASE]);
  });

  it("returns the absent ids in apply order", () => {
    expect(missingCoreMigrations([RELEASE])).toEqual([BASELINE]);
    expect(missingCoreMigrations([BASELINE])).toEqual([RELEASE]);
  });

  it("reports everything missing for an empty ledger (never-migrated database)", () => {
    expect(missingCoreMigrations([])).toEqual([...REQUIRED_CORE_MIGRATIONS]);
  });

  it("counts the release present exactly when it or every id it folds is ledgered (property)", () => {
    fc.assert(
      fc.property(fc.subarray(LEGACY_IDS), fc.boolean(), (present, releaseLedgered) => {
        const ledger = [BASELINE, ...present, ...(releaseLedgered ? [RELEASE] : [])];
        const ready = releaseLedgered || present.length === LEGACY_IDS.length;
        expect(missingCoreMigrations(ledger)).toEqual(ready ? [] : [RELEASE]);
        // Readiness asks the ledger for every id this verdict can depend on.
        for (const id of ledger) expect(CORE_MIGRATION_LEDGER_IDS).toContain(id);
      }),
    );
  });
});
