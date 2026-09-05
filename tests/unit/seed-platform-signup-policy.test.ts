import { describe, expect, it, vi } from "vitest";
import {
  SEEDED_PLATFORM_SIGNUP_POLICY,
  seedPlatformSignupPolicy,
  type PolicySeedQueryable,
} from "@/db/seeds/platform-signup-policy";

/**
 * Pins the FIRST-RUN-ONLY contract of the baseline seed's platform sign-up
 * policy step (review #17) against a stub pool:
 *
 *   - a never-administered row (`updated_by IS NULL`) is relaxed to the
 *     seeded default, and the UPDATE itself carries the `updated_by is null`
 *     guard;
 *   - an admin-managed row (`updated_by` set) is NEVER written, whatever it
 *     holds, and a loud "left as configured (admin-managed)" line is logged;
 *   - a row already at the seeded default is left alone (idempotent re-run);
 *   - a missing platform row fails closed instead of seeding nothing.
 *
 * The real-SQL behaviour (including `updated_at` staying put on a re-run) is
 * covered DB-backed in `tests/db/seed-platform-signup-policy.db.test.ts`.
 */

type Row = {
  require_email_verification: boolean;
  signup_approval_mode: string;
  updated_by: string | null;
};

function stubPool(row: Row | undefined, updateRowCount = 1) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool: PolicySeedQueryable = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (/^\s*select/i.test(text)) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/^\s*update/i.test(text)) {
        return { rows: [], rowCount: updateRowCount };
      }
      throw new Error(`unexpected statement: ${text}`);
    }) as PolicySeedQueryable["query"],
  };
  const updates = () => calls.filter((c) => /^\s*update/i.test(c.text));
  return { pool, calls, updates };
}

describe("seedPlatformSignupPolicy (review #17: first-run-only)", () => {
  it("relaxes the migration's fail-closed baseline on a never-administered row", async () => {
    const { pool, updates } = stubPool({
      require_email_verification: true,
      signup_approval_mode: "admin_approval",
      updated_by: null,
    });
    const log = vi.fn();

    await expect(seedPlatformSignupPolicy(pool, log)).resolves.toBe("applied");

    expect(updates()).toHaveLength(1);
    const [update] = updates();
    if (!update) throw new Error("expected the guarded UPDATE to be issued");
    expect(update.text).toMatch(/where organization_id is null\s+and updated_by is null/i);
    expect(update.text).not.toMatch(/updated_by\s*=/i); // the seed is not an administrator edit
    expect(update.values).toEqual([
      SEEDED_PLATFORM_SIGNUP_POLICY.requireEmailVerification,
      SEEDED_PLATFORM_SIGNUP_POLICY.signupApprovalMode,
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("set to auto_active"));
  });

  it.each([
    ["admin_approval", true],
    ["invite_only", true],
    ["auto_active", false],
  ] as const)(
    "leaves an admin-managed row untouched (%s, verification=%s) and logs loudly",
    async (mode, verify) => {
      const { pool, updates } = stubPool({
        require_email_verification: verify,
        signup_approval_mode: mode,
        updated_by: "ba_user_admin",
      });
      const log = vi.fn();

      await expect(seedPlatformSignupPolicy(pool, log)).resolves.toBe("admin_managed");

      expect(updates()).toHaveLength(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain(
        "[seed] platform sign-up policy left as configured (admin-managed)",
      );
      expect(log.mock.calls[0]?.[0]).toContain(`signup_approval_mode=${mode}`);
    },
  );

  it("is idempotent: a re-run against an already-seeded row writes nothing", async () => {
    const { pool, updates } = stubPool({
      require_email_verification: true,
      signup_approval_mode: "auto_active",
      updated_by: null,
    });
    const log = vi.fn();

    await expect(seedPlatformSignupPolicy(pool, log)).resolves.toBe("unchanged");

    expect(updates()).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already at the seeded default"));
  });

  it("treats a concurrently-administered row as admin-managed when the guarded UPDATE hits nothing", async () => {
    const { pool } = stubPool(
      {
        require_email_verification: true,
        signup_approval_mode: "admin_approval",
        updated_by: null,
      },
      0,
    );
    const log = vi.fn();

    await expect(seedPlatformSignupPolicy(pool, log)).resolves.toBe("admin_managed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("left as configured (admin-managed)"));
  });

  it("fails closed when the platform-default row is missing (seed ran before migrate)", async () => {
    const { pool, updates } = stubPool(undefined);

    await expect(seedPlatformSignupPolicy(pool, vi.fn())).rejects.toThrow(/db:app:migrate/);
    expect(updates()).toHaveLength(0);
  });
});
