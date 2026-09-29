import type { BetterAuthOptions } from "better-auth";
import type { MicrosoftOptions } from "better-auth/social-providers";

/**
 * F-150: the app uses Google, Microsoft and GitHub sign-in for IDENTITY only,
 * so it keeps none of the tokens those providers issue.
 *
 * Better Auth stores the provider's access token, refresh token and ID token
 * on the `account` row at every social sign-in and link, in plaintext
 * (`encryptOAuthTokens` is off), and nothing in the app reads them: the
 * endpoints that would (`/get-access-token`, `/refresh-token`,
 * `/account-info`, `/list-accounts`) are closed (`AUTH_DISABLED_PATHS`,
 * F-06). The rows outlived a soft delete, and a refused sign-in by a banned
 * user rewrote them first. So a database read (a leaked branch or backup, the
 * owner credential, an Option C satellite that shares this database) handed
 * over a live GitHub OAuth token for every GitHub user (they do not expire),
 * about an hour of Microsoft Graph access after each Microsoft sign-in, and
 * ID tokens carrying name, email and tenant claims. Migration 0007 clears the
 * tokens stored before this.
 */

type AccountHooks = NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["account"]>;

/**
 * The `account` columns that hold a provider token or describe one. The
 * expiry columns go with the tokens: without them they describe nothing.
 */
const PROVIDER_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
] as const;

const NO_PROVIDER_TOKENS = Object.fromEntries(PROVIDER_TOKEN_FIELDS.map((field) => [field, null]));

/**
 * `databaseHooks.account` for `src/lib/auth.ts`. Every write to the `account`
 * table goes through Better Auth's internal adapter and so through these
 * hooks: a new user's first social sign-in, an implicit or explicit link, and
 * the token refresh on every later sign-in (`updateAccountOnSignIn`). A hook
 * result is merged over the data being written, so returning the token
 * fields as `null` stores nothing. A credential (email/password) row carries
 * no token; its `password` is not touched.
 *
 * An update that writes ANY token field clears ALL of them, not only the ones
 * it carries: Better Auth leaves out a token the provider did not return, so
 * a Microsoft sign-in without `offline_access` would otherwise keep the
 * refresh token an older build stored. An update that carries no token (a
 * password change) is left as it was.
 */
export const discardProviderTokens: AccountHooks = {
  create: {
    before: async () => ({ data: { ...NO_PROVIDER_TOKENS } }),
  },
  update: {
    before: async (account) => {
      if (!PROVIDER_TOKEN_FIELDS.some((field) => field in account)) return;
      return { data: { ...NO_PROVIDER_TOKENS } };
    },
  },
};

/**
 * Spread into the Microsoft provider's options (F-150). Better Auth's default
 * Microsoft scopes add `offline_access`, which makes Entra issue a refresh
 * token, and `User.Read`, which the provider uses only to fetch the profile
 * photo from Microsoft Graph. Sign-in needs neither: the name, email and
 * account id come from the ID token that `openid profile email` yields. With
 * `User.Read` gone the photo request would fail on every sign-in, so it is
 * switched off too (the app never shows `user.image`).
 */
export const MICROSOFT_IDENTITY_ONLY: Pick<
  MicrosoftOptions,
  "disableDefaultScope" | "scope" | "disableProfilePhoto"
> = {
  disableDefaultScope: true,
  scope: ["openid", "profile", "email"],
  disableProfilePhoto: true,
};
