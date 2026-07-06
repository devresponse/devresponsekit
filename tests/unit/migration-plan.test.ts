import { describe, expect, it } from "vitest";
import {
  ALWAYS_APPLIED_LOCALE,
  planMigrations,
  shouldIncludeLocales,
} from "@/db/migrations/migration-plan";

/**
 * Unit coverage for the pure migration planner. The runner (`run-migrations.ts`)
 * is a thin fs+db shell around these two functions, so pinning the ordering +
 * locale-inclusion + ledger-id rules here is the regression guard for the
 * "always-on English base + optional localized files" layout.
 */
// Real core is now the single consolidated `0001-initial-schema.sql`; the
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
