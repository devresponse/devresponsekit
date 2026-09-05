import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { db, pgPool } from "@/db/database";
import { upsertOrgAuthSettings } from "@/lib/admin/auth-settings.server";
import { seedPlatformSignupPolicy } from "@/db/seeds/platform-signup-policy";

/**
 * DB-BACKED integration tests for the baseline seed's platform sign-up policy
 * step (review #17) against the real `app_organization_auth_settings` SQL.
 *
 * Proves, in order, the full operator story:
 *
 *   1. FIRST RUN — the migration's fail-closed baseline (`admin_approval`,
 *      `updated_by IS NULL`) is relaxed to `auto_active`.
 *   2. RE-RUN, no admin change — nothing is written: the values AND
 *      `updated_at` are byte-identical afterwards (true idempotency).
 *   3. RE-RUN after an ADMINISTRATOR tightened the policy through the real
 *      admin write path (`upsertOrgAuthSettings`, which stamps `updated_by`)
 *      — the admin's `invite_only` policy survives, verification flag and
 *      the untouched `allowed_auth_methods` / `auto_approve_email_domains`
 *      included.
 *
 * The platform row is a singleton the suite cannot create or drop, so the
 * suite snapshots it up front and restores it in `afterAll` — the database
 * is left exactly as it was found, whatever state the local seed left it in.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts), excluded from `pnpm test`.
 */

type Snapshot = {
  require_email_verification: boolean;
  signup_approval_mode: string;
  allowed_auth_methods: string[] | null;
  auto_approve_email_domains: string[] | null;
  updated_by: string | null;
  updated_at: Date;
};

async function readPlatformRow(): Promise<Snapshot> {
  return (
    db
      .selectFrom("app_organization_auth_settings")
      .select([
        "require_email_verification",
        "signup_approval_mode",
        "allowed_auth_methods",
        "auto_approve_email_domains",
        "updated_by",
        "updated_at",
      ])
      .where("organization_id", "is", null)
      // `Generated<Timestamp>` doesn't unwrap to Date on select; pg returns a Date at runtime.
      .executeTakeFirstOrThrow() as unknown as Promise<Snapshot>
  );
}

async function writePlatformRow(row: Snapshot): Promise<void> {
  await db
    .updateTable("app_organization_auth_settings")
    .set({
      require_email_verification: row.require_email_verification,
      signup_approval_mode: row.signup_approval_mode,
      allowed_auth_methods: row.allowed_auth_methods,
      auto_approve_email_domains: row.auto_approve_email_domains,
      updated_by: row.updated_by,
      updated_at: sql`${row.updated_at.toISOString()}::timestamptz`,
    })
    .where("organization_id", "is", null)
    .execute();
}

/** Puts the platform row back to what 0001-initial-schema.sql inserts. */
async function resetToMigrationBaseline(): Promise<void> {
  await writePlatformRow({
    require_email_verification: true,
    signup_approval_mode: "admin_approval",
    allowed_auth_methods: null,
    auto_approve_email_domains: null,
    updated_by: null,
    updated_at: new Date("2020-01-01T00:00:00Z"),
  });
}

let original: Snapshot;
const logs: string[] = [];
const log = (m: string) => {
  logs.push(m);
};

beforeAll(async () => {
  original = await readPlatformRow();
});

afterAll(async () => {
  await writePlatformRow(original);
  await pgPool.end();
});

describe("seedPlatformSignupPolicy (DB-backed, review #17)", () => {
  it("first run: relaxes the migration's fail-closed baseline to auto_active", async () => {
    await resetToMigrationBaseline();
    logs.length = 0;

    await expect(seedPlatformSignupPolicy(pgPool, log)).resolves.toBe("applied");

    const row = await readPlatformRow();
    expect(row).toMatchObject({
      require_email_verification: true,
      signup_approval_mode: "auto_active",
      updated_by: null, // still "never administered" — the seed is not an admin edit
    });
    expect(logs.join("\n")).toContain("set to auto_active");
  });

  it("re-run without an admin change: idempotent, nothing written (updated_at untouched)", async () => {
    await resetToMigrationBaseline();
    await seedPlatformSignupPolicy(pgPool, () => {});
    const afterFirst = await readPlatformRow();
    logs.length = 0;

    await expect(seedPlatformSignupPolicy(pgPool, log)).resolves.toBe("unchanged");

    const afterSecond = await readPlatformRow();
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.updated_at.getTime()).toBe(afterFirst.updated_at.getTime());
    expect(logs.join("\n")).toContain("already at the seeded default");
  });

  it("re-run after an administrator tightened the policy: leaves it exactly as configured", async () => {
    await resetToMigrationBaseline();
    await seedPlatformSignupPolicy(pgPool, () => {});

    // The real admin write path: stamps updated_by with the editor's id.
    await upsertOrgAuthSettings(
      null,
      {
        requireEmailVerification: true,
        signupApprovalMode: "invite_only",
        allowedAuthMethods: ["email", "google"],
        autoApproveEmailDomains: ["example.test"],
      },
      "__dbtest_admin_user",
    );
    const asAdministered = await readPlatformRow();
    expect(asAdministered.updated_by).toBe("__dbtest_admin_user");
    logs.length = 0;

    await expect(seedPlatformSignupPolicy(pgPool, log)).resolves.toBe("admin_managed");

    expect(await readPlatformRow()).toEqual(asAdministered);
    expect(logs.join("\n")).toContain(
      "[seed] platform sign-up policy left as configured (admin-managed)",
    );
    expect(logs.join("\n")).toContain("signup_approval_mode=invite_only");
  });
});
