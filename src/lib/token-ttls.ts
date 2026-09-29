/**
 * How long the one-time credential in each token-bearing email stays valid
 * (F-103).
 *
 * Two places need each value: the code that MINTS the credential, and the
 * outbox drain, which fails a queued row whose link has already died instead
 * of delivering it (review #90, `TOKEN_TTL_MS_BY_TEMPLATE` in
 * `email/outbox-worker.server.ts`). They were written twice and kept in step
 * by a comment. A shorter reset TTL in `auth.ts` would have had the drain
 * deliver links dead for up to the difference, and a longer invitation TTL
 * would have had it fail live invitations as `token_expired`, with every test
 * green. Both sides now import these.
 *
 * No imports, so `auth.ts`, `invitations.server.ts` and the drain's cron path
 * (which must not pull the invitation module in) can all read it.
 */

/**
 * A password-reset link. `auth.ts` passes it to Better Auth as
 * `emailAndPassword.resetPasswordTokenExpiresIn`, in seconds. One hour, Better
 * Auth's own default.
 */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60_000;

/**
 * An email-verification link. `auth.ts` passes it to Better Auth as
 * `emailVerification.expiresIn`, in seconds. One hour, Better Auth's own
 * default.
 */
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 60 * 60_000;

/**
 * An organization invitation, counted from its (re)issue. The invitation
 * email and the admin's invite dialog state it in every locale ("expires in 7
 * days"), and tests/unit/email-templates.test.ts fails when that copy and this
 * value disagree.
 */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60_000;
