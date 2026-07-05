import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, pgPool } from "@/db/database";
import { getAuthPolicyForOrg } from "@/lib/auth-policy.server";

/**
 * DB-BACKED integration tests for migration 0007
 * (`app_organization_auth_settings` — per-org signup policy).
 *
 * Proves the pieces the mocked unit tests can't reach:
 *
 *   1. The migration seeded EXACTLY ONE platform-default row, and its values
 *      reproduce the pre-0007 hardcoded workflow (verification required +
 *      admin approval) — the "no behavior change on upgrade" guarantee.
 *   2. The partial unique index rejects a second platform-default row.
 *   3. The CHECK constraints reject unknown approval modes and auth methods.
 *   4. A policy row cascades away with its owning organization (it must
 *      never block org deletion the way in-use roles/keys do — see 0005).
 *   5. `getAuthPolicyForOrg` resolves org row → platform default against the
 *      real SQL, including array handling and read-time domain normalization.
 *
 * Driven by `pnpm test:db` (vitest.db.config.ts), excluded from `pnpm test`.
 * All fixtures use a `__dbtest_` prefix and self-clean, leaving no residue.
 */
const PREFIX = "__dbtest_authpolicy_";

async function cleanup(): Promise<void> {
  // Policy rows are ON DELETE CASCADE — removing the fixture orgs is enough.
  await db.deleteFrom("app_organizations").where("slug", "like", `${PREFIX}%`).execute();
}

async function newOrg(slug: string): Promise<string> {
  const row = await db
    .insertInto("app_organizations")
    .values({ slug: `${PREFIX}${slug}`, name: `DBTest ${slug}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pgPool.end();
});

describe("app_organization_auth_settings (DB-backed, 0007)", () => {
  it("seeds exactly one platform-default row reproducing the pre-0007 workflow", async () => {
    const rows = await db
      .selectFrom("app_organization_auth_settings")
      .select(["require_email_verification", "signup_approval_mode"])
      .where("organization_id", "is", null)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      require_email_verification: true,
      signup_approval_mode: "admin_approval",
    });
  });

  it("rejects a second platform-default row (partial unique index)", async () => {
    await expect(
      db
        .insertInto("app_organization_auth_settings")
        .values({
          organization_id: null,
          require_email_verification: false,
          signup_approval_mode: "auto_active",
        })
        .execute(),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("enforces the approval-mode and auth-method CHECK constraints", async () => {
    const orgId = await newOrg("check");

    await expect(
      db
        .insertInto("app_organization_auth_settings")
        .values({
          organization_id: orgId,
          require_email_verification: true,
          signup_approval_mode: "nonsense",
        })
        .execute(),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      db
        .insertInto("app_organization_auth_settings")
        .values({
          organization_id: orgId,
          require_email_verification: true,
          signup_approval_mode: "admin_approval",
          allowed_auth_methods: ["carrier-pigeon"],
        })
        .execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("resolves org row over platform default and cascades away with the org", async () => {
    const orgId = await newOrg("resolve");

    // No row yet → the platform default governs (source platform_default).
    const inherited = await getAuthPolicyForOrg(orgId);
    expect(inherited.source).toBe("platform_default");
    expect(inherited.requireEmailVerification).toBe(true);
    expect(inherited.signupApprovalMode).toBe("admin_approval");

    await db
      .insertInto("app_organization_auth_settings")
      .values({
        organization_id: orgId,
        require_email_verification: false,
        signup_approval_mode: "auto_active",
        allowed_auth_methods: ["email", "google"],
        // Stored raw; the resolver normalizes (trim + lowercase) at read time.
        auto_approve_email_domains: [" Acme.COM"],
      })
      .execute();

    const own = await getAuthPolicyForOrg(orgId);
    expect(own).toMatchObject({
      source: "organization",
      requireEmailVerification: false,
      signupApprovalMode: "auto_active",
      allowedAuthMethods: ["email", "google"],
      autoApproveEmailDomains: ["acme.com"],
    });

    // Deleting the org must take the policy row with it (never a FK 500).
    await db.deleteFrom("app_organizations").where("id", "=", orgId).execute();
    const orphaned = await db
      .selectFrom("app_organization_auth_settings")
      .select(["id"])
      .where("organization_id", "=", orgId)
      .executeTakeFirst();
    expect(orphaned).toBeUndefined();
  });
});
