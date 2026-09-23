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
 * `emailVerificationWaived`, meaning "`emailVerified` is true WITHOUT proof of
 * mailbox access". It is:
 *   - `input: false` — a client cannot set it through the sign-up body (Better
 *     Auth replaces any client-supplied value with the default), so only
 *     server-side code writes it;
 *   - set by the sign-up hook for a policy waiver, AND by admin/machine-API
 *     creation unless the creator has cross-org reach (F-03,
 *     `createBetterAuthUser`): an org admin's say-so is not mailbox proof, and
 *     an org admin could otherwise plant a pre-verified identity for anyone's
 *     address;
 *   - `defaultValue: false` for every other path (invitation-proven sign-ups,
 *     OAuth, seeds), whose `emailVerified` is genuine;
 *   - cleared by a completed password reset, which DOES prove the mailbox
 *     (the link was delivered there) and replaces any planted password.
 *
 * F-03 — Better Auth links a social sign-in into an existing account whose
 * `emailVerified` is true (`requireLocalEmailVerified`). A marked account is
 * therefore refused provider linking (implicit, and the OAuth-redirect
 * explicit link) by
 * `refuseLinkIntoUnprovenAccount` below: otherwise whoever registered or
 * planted the address — and still holds its password — would share the
 * account the real owner signs into with Google or Microsoft.
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

/**
 * The `validateUserInfo` rejection for a provider link into an account whose
 * email has no mailbox proof. Deliberately Better Auth's own code for a
 * refused implicit link, so the user lands on the same error as every other
 * refusal of that kind.
 */
export const UNPROVEN_EMAIL_LINK_REJECTION = {
  error: "account_not_linked",
  errorDescription:
    "Reset your password to confirm this email address, then sign in with this provider. If you did not create an account with this address, contact your administrator.",
} as const;

/**
 * F-03 decision, pure: refuse linking a provider account into `localUser`
 * when its email carries no mailbox proof. A missing local user also refuses
 * (fail closed — there is nothing to link into).
 */
export function refuseLinkIntoUnprovenAccount(
  localUser: unknown,
): typeof UNPROVEN_EMAIL_LINK_REJECTION | undefined {
  if (!localUser || isEmailVerificationWaived(localUser)) {
    return UNPROVEN_EMAIL_LINK_REJECTION;
  }
  return undefined;
}

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;

/**
 * F-03 — the `user.validateUserInfo` gate `src/lib/auth.ts` installs. Better
 * Auth runs it (fail-closed: a throw rejects) immediately before linking a
 * provider account to an EXISTING user: implicitly (a social sign-in, id-token
 * sign-in or one-tap whose verified email matches) and on the OAuth-redirect
 * leg of an explicit linkSocial. (linkSocial with an id token links only the
 * signed-in holder's own identity, which is not a takeover.) Every other
 * action passes. Exported so the behavioural test drives the real function
 * inside a real Better Auth instance.
 */
export const validateUserInfoForLinking: ValidateUserInfo = async ({ user, source }, ctx) => {
  if (source.action !== "link-account") {
    return;
  }
  const localUser =
    typeof user.id === "string" ? await ctx.context.internalAdapter.findUserById(user.id) : null;
  return refuseLinkIntoUnprovenAccount(localUser);
};
