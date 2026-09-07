import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { locales } from "@/config/i18n-config";
import { createUserSchema, preferredLocaleSchema } from "@/lib/validation/users";

/**
 * Review #71 / #80 — `preferredLocale` used to be `z.string().min(2).max(10)`
 * on the admin create/patch and the v1 create paths, so `POST /api/v1/users`
 * with `"fr-CA"`, `"klingon"` or `"xx"` stored an unsupported locale verbatim
 * in `app_users.preferred_locale` (a plain `text` column with no CHECK). The
 * self-service routes already refined against `isSupportedLocale`, so the two
 * halves of the app disagreed about what a locale is.
 *
 * These tests pin BOTH halves of the fix:
 *   1. the shared schema's behaviour — every supported locale in, everything
 *      else out; and
 *   2. the completeness guard — no write path may re-open the hole with its
 *      own inline `preferredLocale: z.string()`.
 */
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("preferredLocaleSchema (review #71/#80)", () => {
  it("accepts every locale the app actually ships", () => {
    for (const locale of locales) {
      expect(preferredLocaleSchema.safeParse(locale).success).toBe(true);
    }
  });

  it.each([
    "fr-CA", // a real BCP-47 tag we do not have a catalog for
    "xx",
    "klingon",
    "EN", // case matters: the catalog keys are lower-case
    "en ",
    "",
    "e",
  ])("rejects %j", (value) => {
    expect(preferredLocaleSchema.safeParse(value).success).toBe(false);
  });

  it("derives its answer from the i18n config, not a private list", () => {
    // A locale that is not in `locales` must fail; adding it there must be the
    // only thing needed to make it pass.
    const unknown = "zz";
    expect((locales as readonly string[]).includes(unknown)).toBe(false);
    expect(preferredLocaleSchema.safeParse(unknown).success).toBe(false);
  });
});

describe("createUserSchema carries the constraint (review #71/#80)", () => {
  const base = { email: "a@b.com", password: "password123" };

  it("accepts a supported locale", () => {
    expect(createUserSchema.safeParse({ ...base, preferredLocale: "ja" }).success).toBe(true);
  });

  it("rejects an unsupported locale", () => {
    expect(createUserSchema.safeParse({ ...base, preferredLocale: "fr-CA" }).success).toBe(false);
  });

  it("still allows omitting it (the DB default applies)", () => {
    expect(createUserSchema.safeParse(base).success).toBe(true);
  });
});

describe("no write path re-opens the hole (completeness guard)", () => {
  it("every zod `preferredLocale` field constrains to the supported locales", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split(/\r?\n/)) {
        if (!/preferredLocale:\s*z\./.test(line)) continue;
        // Accepted forms: the shared schema, or an inline refinement against
        // the same `isSupportedLocale` predicate (the account schema).
        if (/preferredLocaleSchema|isSupportedLocale/.test(line)) continue;
        offenders.push(`${file.replace(/\\/g, "/").split("/src/")[1]}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      "A `preferredLocale` write schema must use `preferredLocaleSchema` from " +
        "@/lib/validation/users (or refine against isSupportedLocale) so the " +
        "stored value can only ever be a locale the app ships (review #71/#80).",
    ).toEqual([]);
  });
});
