import { describe, expect, it } from "vitest";
import { planMigrations, shouldIncludeLocales } from "@/db/migrations/migration-plan";

/**
 * Unit coverage for the pure migration planner. The runner (`run-migrations.ts`)
 * is a thin fs+db shell around these two functions, so pinning the ordering +
 * locale-inclusion + ledger-id rules here is the regression guard for the
 * "English-only core, optional locale" reorganization.
 */
const CORE = [
  "0002-sso-nonce-expires-index.sql",
  "0001-initial-schema.sql",
  "better-auth-schema.sql", // owned by Better Auth — must be skipped
  "locales", // the subdirectory entry returned by readdir — not a .sql
  "run-migrations.ts", // the runner itself — not a .sql
  "migration-plan.ts",
];
const LOCALES = ["0002-email-templates-pt.sql", "0001-email-templates-fr-es-uk.sql"];

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
      "0002-sso-nonce-expires-index.sql",
      "locales/0001-email-templates-fr-es-uk.sql",
      "locales/0002-email-templates-pt.sql",
    ]);
  });

  it("tags subdir + bare filename so the runner reads the right path", () => {
    const plan = planMigrations(CORE, LOCALES, true);
    const core = plan.find((m) => m.id === "0001-initial-schema.sql")!;
    expect(core.subdir).toBe("");
    expect(core.file).toBe("0001-initial-schema.sql");
    const locale = plan.find((m) => m.id === "locales/0001-email-templates-fr-es-uk.sql")!;
    expect(locale.subdir).toBe("locales");
    expect(locale.file).toBe("0001-email-templates-fr-es-uk.sql");
  });

  it("drops the locale pass entirely when excluded (English-only install)", () => {
    const plan = planMigrations(CORE, LOCALES, false);
    expect(plan.map((m) => m.id)).toEqual([
      "0001-initial-schema.sql",
      "0002-sso-nonce-expires-index.sql",
    ]);
    expect(plan.some((m) => m.subdir === "locales")).toBe(false);
  });

  it("never emits a Better-Auth-owned file as a core migration", () => {
    const plan = planMigrations(CORE, LOCALES, true);
    expect(plan.some((m) => m.file.startsWith("better-auth"))).toBe(false);
  });
});
