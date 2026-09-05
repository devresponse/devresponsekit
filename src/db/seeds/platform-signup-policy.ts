/**
 * Platform sign-up default applied by the baseline seed (`seed-local.ts`).
 *
 * The 0001 migration inserts the platform-default policy row
 * (`app_organization_auth_settings` with `organization_id IS NULL`)
 * FAIL-CLOSED — verification required + administrator approval. This
 * deployment ships the friction-free "verify → active" flow as its default,
 * so the seed relaxes that row to `auto_active`.
 *
 * FIRST-RUN ONLY (review #17). `db:seed` is advertised as safe to re-run and
 * is step 3 of the production bootstrap, so the relaxation must never undo a
 * policy an administrator has since tightened. The admin API
 * (`upsertOrgAuthSettings`) stamps `updated_by` with the editor's Better Auth
 * user id on every write, while migrations and seeds leave it NULL — so
 * `updated_by IS NULL` means "never touched by an administrator" and is the
 * only state this seed is allowed to write. Everything else is left exactly
 * as configured and reported loudly.
 */

/** The relaxed default the seed installs on a never-administered platform row. */
export const SEEDED_PLATFORM_SIGNUP_POLICY = {
  requireEmailVerification: true,
  signupApprovalMode: "auto_active",
} as const;

export type PlatformSignupPolicySeedOutcome =
  /** Row was at the migration baseline (or another never-administered value); relaxed to the seeded default. */
  | "applied"
  /** Row already holds the seeded default and has never been administered — nothing written. */
  | "unchanged"
  /** An administrator has edited the row (`updated_by` set) — left exactly as configured. */
  | "admin_managed";

/** The slice of `pg.Pool` the seed step needs (keeps it testable with a stub). */
export interface PolicySeedQueryable {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

interface PlatformPolicyRow {
  require_email_verification: boolean;
  signup_approval_mode: string;
  updated_by: string | null;
}

/**
 * Relaxes the platform-default sign-up policy to `auto_active` — but ONLY when
 * the row has never been edited by an administrator. Idempotent: a re-run
 * against an already-seeded row writes nothing (and does not bump
 * `updated_at`); a re-run after an admin change leaves the admin's policy in
 * place and prints a loud notice.
 *
 * Throws when the platform-default row is missing: the 0001 migration always
 * creates it and the API never deletes it, so its absence means the seed is
 * running ahead of `db:app:migrate` — fail closed rather than silently
 * seeding nothing.
 */
export async function seedPlatformSignupPolicy(
  pool: PolicySeedQueryable,
  log: (message: string) => void = console.log,
): Promise<PlatformSignupPolicySeedOutcome> {
  const current = (
    await pool.query<PlatformPolicyRow>(
      `select require_email_verification, signup_approval_mode, updated_by
         from app_organization_auth_settings
        where organization_id is null`,
    )
  ).rows[0];

  if (!current) {
    throw new Error(
      "platform-default sign-up policy row is missing (app_organization_auth_settings where organization_id is null). " +
        "Run `pnpm db:app:migrate` before `pnpm db:seed`.",
    );
  }

  if (current.updated_by !== null) {
    log(
      "[seed] platform sign-up policy left as configured (admin-managed): " +
        `signup_approval_mode=${current.signup_approval_mode}, ` +
        `require_email_verification=${current.require_email_verification}. ` +
        "The seed only sets the default on a never-administered row; change it via Administrator → Platform sign-up defaults.",
    );
    return "admin_managed";
  }

  if (
    current.signup_approval_mode === SEEDED_PLATFORM_SIGNUP_POLICY.signupApprovalMode &&
    current.require_email_verification === SEEDED_PLATFORM_SIGNUP_POLICY.requireEmailVerification
  ) {
    log(
      `[seed] platform sign-up policy already at the seeded default (${SEEDED_PLATFORM_SIGNUP_POLICY.signupApprovalMode}); nothing to do`,
    );
    return "unchanged";
  }

  // `updated_by is null` is repeated in the WHERE as a belt-and-braces guard
  // so an administrator's write can never be clobbered even if the row
  // changed between the read above and this statement. `updated_by` stays
  // NULL: it is the administrator-edit marker, and the seed is not one.
  const result = await pool.query(
    `update app_organization_auth_settings
        set require_email_verification = $1,
            signup_approval_mode = $2,
            updated_at = now()
      where organization_id is null
        and updated_by is null`,
    [
      SEEDED_PLATFORM_SIGNUP_POLICY.requireEmailVerification,
      SEEDED_PLATFORM_SIGNUP_POLICY.signupApprovalMode,
    ],
  );

  if (!result.rowCount) {
    log("[seed] platform sign-up policy left as configured (admin-managed): edited concurrently");
    return "admin_managed";
  }

  log(
    `[seed] platform sign-up policy set to ${SEEDED_PLATFORM_SIGNUP_POLICY.signupApprovalMode} (first run: was ${current.signup_approval_mode})`,
  );
  return "applied";
}
