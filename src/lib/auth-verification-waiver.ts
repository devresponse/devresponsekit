import type { BetterAuthOptions } from "better-auth";

type UserAdditionalField = NonNullable<
  NonNullable<BetterAuthOptions["user"]>["additionalFields"]
>[string];

/**
 * Policy-waived email verification marker (review 2026-09-04 #2).
 *
 * When an organization's sign-up policy waives email verification, the
 * `user.create.before` hook in `src/lib/auth.ts` stamps `emailVerified: true`
 * at creation so the global `requireEmailVerification` gate passes. That flag
 * is a WAIVER, not proof — nobody clicked a link delivered to the mailbox. The
 * activation rule for `autoApproveEmailDomains` (`decideInitialStatus`) trusts
 * `emailVerified` as mailbox proof, so the two must never be confused: a
 * waived flag that later meets a strict org (a hinted placement, a policy
 * edit between sign-up and the next sign-in) would otherwise ride
 * `anyone@acme.com` into an active membership.
 *
 * The waiver is therefore persisted as a DISTINCT Better Auth user field,
 * `emailVerificationWaived`, set only by the hook. It is:
 *   - `input: false` — a client cannot set it through the sign-up body (Better
 *     Auth replaces any client-supplied value with the default), so the
 *     marker's only writer is the server-side hook;
 *   - `defaultValue: false` — every other creation path (invitation-proven
 *     sign-ups, OAuth, admin/machine-API creation, seeds) records "not
 *     waived", which is the truth for them: their `emailVerified` is either
 *     genuine or explicitly chosen by an operator.
 *
 * Provisioning and sign-in re-evaluation read the marker back from the user
 * row and pass it to `decideInitialStatus`, which refuses domain auto-approval
 * for a waived flag. The column is added to the Better Auth `user` table by
 * `pnpm db:auth:migrate` (the vendor migrator adds missing columns) and is
 * part of the committed `better-auth-schema.sql` snapshot.
 */
export const EMAIL_VERIFICATION_WAIVED_FIELD = "emailVerificationWaived" as const;

/** Better Auth `user.additionalFields` entry for the marker. */
export const EMAIL_VERIFICATION_WAIVED_USER_FIELD = {
  type: "boolean",
  required: false,
  defaultValue: false,
  input: false,
} as const satisfies UserAdditionalField;

/**
 * Reads the marker off a Better Auth user object (hook payloads and
 * `internalAdapter.findUserById` both carry additional fields as extra keys).
 * Anything but a literal `true` — absent, null, a legacy row created before
 * the column existed — reads as "not waived", which is the conservative
 * answer only in combination with the `requireEmailVerification` backstop in
 * `decideInitialStatus`: a pre-marker waived flag can still only satisfy the
 * domain rule inside an org that requires verification, exactly as before.
 */
export function isEmailVerificationWaived(user: unknown): boolean {
  if (!user || typeof user !== "object") {
    return false;
  }
  return (user as Record<string, unknown>)[EMAIL_VERIFICATION_WAIVED_FIELD] === true;
}
