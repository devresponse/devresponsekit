/**
 * Suppression flag for the sign-up auto-provisioning database hook
 * (`databaseHooks.user.create.after` in `src/lib/auth.ts`, AUTH-5).
 *
 * Trusted server-side seeding creates Better Auth users via
 * `auth.api.signUpEmail` — which hits the SAME `/sign-up/email` endpoint a real
 * self-registration does — and then provisions the `app_users` row +
 * memberships itself, in the specific org(s) the fixture requires. If the hook
 * also ran, a dev-fixture user (who belongs to org-a/b/c) would additionally be
 * given a spurious `default`-org membership. The seed's `main()` therefore sets
 * this flag before its `signUpEmail` loop so the hook stands down.
 *
 * A module-level boolean is sufficient: the seed runs single-threaded in one
 * process and the process exits when it finishes. It is never set in the
 * running application, so genuine self-registrations are always provisioned.
 */
let suppressed = false;

export function setSignupProvisioningSuppressed(value: boolean): void {
  suppressed = value;
}

export function isSignupProvisioningSuppressed(): boolean {
  return suppressed;
}

/**
 * Whether a Better Auth `user.create` event should be auto-provisioned into
 * `app_users` by the sign-up hook (AUTH-5). True only for the email/password
 * self-registration endpoint (`/sign-up/email`) AND when provisioning is not
 * suppressed (seeding). Excludes OAuth (`/callback/*` — the session hook covers
 * it once a session exists) and admin / machine-API creation
 * (`/admin/create-user` — which provisions `app_users` itself).
 */
export function shouldProvisionSelfSignup(
  context: { path?: string | null } | null | undefined,
): boolean {
  if (!context || suppressed) {
    return false;
  }
  return (context.path ?? "").includes("/sign-up/email");
}
