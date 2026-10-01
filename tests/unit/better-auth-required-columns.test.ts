import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Better Auth's required columns, pinned (DEP1).
 *
 * The production schema gate lets the previous build keep serving after
 * `pnpm db:auth:migrate` has run, and an Instant Rollback puts an older build
 * on a newer schema. A better-auth upgrade that adds a column which is NOT
 * NULL with no default breaks both: every row an older build inserts into
 * that table fails with 23502 (not_null_violation) from the moment the column
 * exists until the new build is live, and again after any rollback. Better
 * Auth's own migrator refuses to add such a column to a populated table
 * (`unsafeChanges`), and the gate fails the build on that, so the upgrade
 * cannot ship at all until the column is handled.
 *
 * So the set is pinned exactly as `pnpm db:auth:generate` writes it today. A
 * snapshot that adds to it is the cue to apply docs/deployment.md §5
 * ("Compatibility: expand, then contract"): one release EARLIER, a kit
 * migration adds the column with a default (or a fill trigger), so every
 * build in the window can insert; only then the upgrade.
 */
const SNAPSHOT = readFileSync(
  path.join(process.cwd(), "src/db/migrations/better-auth-schema.sql"),
  "utf8",
);

/** Splits at commas outside parentheses: one entry per column or table constraint. */
function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < list.length; k++) {
    if (list[k] === "(") depth++;
    else if (list[k] === ")") depth--;
    else if (list[k] === "," && depth === 0) {
      out.push(list.slice(start, k).trim());
      start = k + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

/** `table.column` for every column the snapshot declares `not null` with no `default`. */
function requiredWithoutDefault(sql: string): string[] {
  const required: string[] = [];
  for (const match of sql.matchAll(/create table "([^"]+)" \((.*)\);/g)) {
    const [, table, body] = match;
    for (const column of topLevel(body!)) {
      const name = /^"([^"]+)"/.exec(column)?.[1];
      if (!name) continue;
      if (/\bnot null\b/i.test(column) && !/\bdefault\b/i.test(column)) {
        required.push(`${table}.${name}`);
      }
    }
  }
  return required.sort();
}

describe("Better Auth's required columns without a default (DEP1)", () => {
  it("reads the generated snapshot", () => {
    expect(SNAPSHOT).toMatch(/GENERATED, DO NOT EDIT BY HAND/);
    expect(
      requiredWithoutDefault(
        'create table "t" ("a" text not null, "b" text default \'x\' not null, "c" text);',
      ),
    ).toEqual(["t.a"]);
  });

  it("are exactly today's set", () => {
    expect(
      requiredWithoutDefault(SNAPSHOT),
      "better-auth-schema.sql now declares a different set of NOT NULL columns without a default. " +
        "A NEW one means every row an older build inserts into that table fails with 23502 " +
        "(not_null_violation) from the moment `pnpm db:auth:migrate` adds it until the new build is " +
        "live, and again after an Instant Rollback; Better Auth also refuses to add it to a populated " +
        "table, which fails the production schema gate. Follow docs/deployment.md §5 " +
        '("Compatibility: expand, then contract"): one release earlier, add the column with a default ' +
        "in a kit migration, then upgrade. Update this list only once that is done.",
    ).toEqual([
      "account.accountId",
      "account.id",
      "account.providerId",
      "account.updatedAt",
      "account.userId",
      "rateLimit.count",
      "rateLimit.id",
      "rateLimit.key",
      "rateLimit.lastRequest",
      "session.expiresAt",
      "session.id",
      "session.token",
      "session.updatedAt",
      "session.userId",
      "user.email",
      "user.emailVerified",
      "user.id",
      "user.name",
      "verification.expiresAt",
      "verification.id",
      "verification.identifier",
      "verification.value",
    ]);
  });
});
