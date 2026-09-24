import { betterAuth, type BetterAuthOptions, type GenericEndpointContext } from "better-auth";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { isSupportedLocale } from "@/config/i18n-config";
import { db, pgPool } from "@/db/database";
import {
  ADMIN_PLUGIN_OPTIONS,
  AUTH_DISABLED_PATHS,
  rejectClosedAuthEndpoints,
} from "@/lib/auth-admin-surface";
import { authResponseFloor } from "@/lib/auth-response-floor";
import { endBorrowedSessionsAfterOwnSweep } from "@/lib/auth-session-sweep";
import { ssoSession } from "@/lib/auth-sso-session";
import { getProvisioningProvider } from "@/lib/auth-provisioning-provider";
import { boundedUserName, resetEmailGreetingName, userNameGuard } from "@/lib/auth-user-name";
import {
  EMAIL_VERIFICATION_WAIVED_FIELD,
  EMAIL_VERIFICATION_WAIVED_USER_FIELD,
  isEmailVerificationWaived,
  validateUserInfoForLinking,
} from "@/lib/auth-verification-waiver";
import { CLIENT_IP_HEADER } from "@/lib/client-ip";
import { getServerEnv } from "@/lib/env";
import { ORG_SIGNUP_HINT_COOKIE, readCookieValue } from "@/lib/scoped-auth";
import { SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social-providers";
import { getTrustedOrigins } from "@/lib/trusted-origins";

/**
 * Better Auth server instance.
 *
 * Uses Better Auth's built-in Kysely-backed PostgreSQL integration. We
 * pass the shared `pgPool` directly via the `database` option, so auth
 * storage and app storage share one connection pool (and one Kysely-
 * based abstraction) without introducing Prisma or Drizzle.
 *
 * Note: account linking, session lifetime, and social providers are
 * configured here. All env access goes through `getServerEnv()` so a
 * misconfigured deployment fails at boot instead of registering broken
 * providers (the Node boot hook parses the schema before the first request,
 * F-26) — a social provider is only enabled when BOTH its client id and
 * secret are present.
 */
const env = getServerEnv();

const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  };
}
if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
  socialProviders.microsoft = {
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    // Multi-tenant Entra ID work/school accounts.
    tenantId: "organizations",
    prompt: "select_account",
  };
}
if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  };
}

/**
 * The social providers actually registered above — those with BOTH a client
 * id and secret present — in canonical display order. The sign-in and sign-up
 * pages read this so the UI only offers a provider whose OAuth flow can
 * actually complete; a button for an unconfigured provider would fail on
 * click. Derived from `socialProviders` so it can never drift from what Better
 * Auth received.
 */
export const enabledSocialProviders: SocialProvider[] = SOCIAL_PROVIDERS.filter(
  (provider) => provider in socialProviders,
);

export const auth = betterAuth({
  database: pgPool,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  // Shared with the administrator origin guard; configured via
  // NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL / ADMIN_TRUSTED_ORIGINS.
  trustedOrigins: getTrustedOrigins(),

  // Better Auth rate-limits sensitive endpoints in production mode
  // (e.g. /sign-in/email at 3 req / 10 s per IP). Browser test suites
  // run against `next start` and sign in far faster than that from one
  // IP, so CI disables the limiter via this test-only env escape hatch.
  //
  // Review #199: its default store is per-process memory, so on Vercel the
  // sign-in / password-reset budgets were per lambda — the same gap as the
  // app's own pre-auth floors (#98). `storage: "database"` keeps the counters
  // in Better Auth's `rateLimit` table (key, count, lastRequest), created by
  // `pnpm db:auth:migrate` and pinned in better-auth-schema.sql, so every
  // instance shares one budget per IP + path. Trade-off: each limited auth
  // request now costs a read plus a conditional increment against Postgres
  // (Better Auth's atomic `consume`) instead of a Map lookup — on the
  // endpoints that were about to hash a password anyway. `storage` is set
  // unconditionally so the generated schema snapshot is the same with the
  // limiter on or off; `enabled: false` still switches the check off
  // entirely (no DB access), so AUTH_RATE_LIMIT_DISABLED means what it did.
  // LANDING ORDER: Better Auth does not catch storage errors, so the table
  // must exist BEFORE this build serves sign-ins — run `pnpm db:auth:migrate`
  // against production first (docs/deployment.md §2). Better Auth's own schema
  // check refuses every auth call while it is missing, and F-26's readiness
  // probe reports that as `schema_behind` (auth-schema-check.server.ts).
  rateLimit: {
    storage: "database",
    ...(env.AUTH_RATE_LIMIT_DISABLED ? { enabled: false } : {}),
  },

  // Review 2026-09-04 #2: a verification the sign-up policy WAIVED is recorded
  // as a distinct, server-only user field so it is never mistaken for a
  // mailbox proof (`decideInitialStatus` refuses domain auto-approval for
  // it). `input: false` makes Better Auth replace any client-supplied value
  // with the default; server code sets it — the `user.create.before` hook below
  // for a policy waiver, and admin/machine-API creation without cross-org reach
  // (F-03, `createBetterAuthUser`) — and a password reset clears it.
  // Rationale, the read helper and the linking gate live in
  // `auth-verification-waiver.ts`.
  user: {
    additionalFields: {
      [EMAIL_VERIFICATION_WAIVED_FIELD]: EMAIL_VERIFICATION_WAIVED_USER_FIELD,
    },
    // F-03 — no provider link into an account without mailbox proof. Better
    // Auth runs this gate (fail-closed: a throw rejects) immediately before it
    // links a provider account to an EXISTING user — implicitly (a social
    // sign-in whose verified email matches) and on the OAuth-redirect leg of an
    // explicit linkSocial. The
    // local account's `emailVerified` is true for a policy waiver or an
    // org-admin-created identity without anyone having proved the mailbox, so
    // linking would hand the real owner an account whose password someone
    // else set. Proving the mailbox (a password reset) clears the marker and
    // lifts the refusal. See `auth-verification-waiver.ts`.
    validateUserInfo: validateUserInfoForLinking,
  },

  emailAndPassword: {
    enabled: true,
    // AUTH-4: block sign-in until the email address is verified. New email/
    // password sign-ups receive a verification link (see the `emailVerification`
    // block below); OAuth identities carry the provider's own emailVerified
    // assertion and are unaffected. Seed fixtures are marked verified by the
    // seed script.
    // Per-org signup policy (0007): this global flag stays ON as the fail-closed
    // baseline; an org that waives verification gets its sign-ups pre-verified
    // by the `user.create.before` hook below, which satisfies this check.
    requireEmailVerification: true,
    // F-20: with `requireEmailVerification` on, a sign-up for an address that
    // already has an account returns 200 with a synthetic user instead of an
    // error, so the answer must match a real sign-up's. Better Auth builds
    // that user from the schema, and the admin plugin's `role` has no schema
    // default: its `user.create.before` hook stamps it on real rows only. So
    // by default a new address came back with `role: "user"` and an existing
    // one with `role: null`, in every organization and in one request. This
    // builds the synthetic user with the fields a new row gets. Better Auth
    // orders the keys by its schema either way. Pinned against a real sign-up
    // through `auth.handler` in
    // tests/security/auth-email-enumeration-timing.test.ts.
    customSyntheticUser: ({ coreFields, additionalFields, id }) => ({
      ...coreFields,
      role: ADMIN_PLUGIN_OPTIONS.defaultRole,
      banned: false,
      banReason: null,
      banExpires: null,
      ...additionalFields,
      id,
    }),
    // AUTH-2: revoke ALL of the user's sessions on a successful password
    // reset. A reset is the canonical "I think my account is compromised"
    // action, so it must also evict any attacker session — otherwise the
    // reset leaves the attacker signed in, defeating its purpose. (The
    // self-service change-password form already passes revokeOtherSessions.)
    // Better Auth honors this flag at runtime (deletes the user's sessions
    // after the reset) but does not yet expose it in its options type, so
    // the block is asserted to the option type.
    revokeSessionsOnPasswordReset: true,
    // F-03: a completed reset PROVES the mailbox (the link was delivered
    // there) and replaces whatever password was set before, so the address is
    // no longer unproven — clear the marker that refuses provider linking.
    // Best-effort: failing to clear leaves the account MORE restricted, never
    // less, so it must not fail the reset the user just completed.
    onPasswordReset: async ({ user }, request) => {
      try {
        await pgPool.query(
          `update "user" set "${EMAIL_VERIFICATION_WAIVED_FIELD}" = false where "id" = $1 and "${EMAIL_VERIFICATION_WAIVED_FIELD}" is true`,
          [user.id],
        );
      } catch (error) {
        const { logServerError } = await import("@/lib/observability/logger.server");
        logServerError("could not clear the unproven-email marker after a password reset", {
          err: error,
        });
      }
      // F-08: `revokeSessionsOnPasswordReset` (run by Better Auth right after
      // this hook) deletes the user's sessions by `userId`, which misses every
      // session they opened AS SOMEONE ELSE — those carry the target's id and
      // name this user only in `impersonatedBy`. A reset is the "my account is
      // compromised" action, so those end too. Its own try/catch: best-effort
      // like the marker above (the password has already changed and throwing
      // would also skip the vendor's session sweep), and bounded regardless by
      // the one-hour impersonation cap `getCurrentSession` enforces.
      try {
        const { revokeSessionsImpersonatedBy } =
          await import("@/lib/impersonation-sessions.server");
        await revokeSessionsImpersonatedBy(user.id);
      } catch (error) {
        const { logServerError } = await import("@/lib/observability/logger.server");
        logServerError("could not end impersonation sessions after a password reset", {
          err: error,
          betterAuthUserId: user.id,
        });
      }
      // F-10: end the account's own sessions NOW, before its credentials are
      // revoked below. Better Auth deletes them only after this hook returns,
      // so until then a stolen cookie still authenticates, and a key it mints
      // while the credentials are being revoked would survive. With the
      // sessions gone first, such a request is refused by the issuance fence
      // (`issuance-fence.server.ts`). Better Auth's own sweep then finds
      // nothing. Own try/catch: if this fails, the credentials are still
      // revoked and the vendor's sweep still runs after the hook.
      try {
        const { revokeOwnSessionsOf } = await import("@/lib/impersonation-sessions.server");
        await revokeOwnSessionsOf(user.id);
      } catch (error) {
        const { logServerError } = await import("@/lib/observability/logger.server");
        logServerError("could not end the account's sessions before revoking its credentials", {
          err: error,
          betterAuthUserId: user.id,
        });
      }
      // F-10: sessions are not the only way in. An API key or OAuth client
      // authenticates on its own, and one minted with a stolen cookie
      // (`POST /api/v1/me/api-keys`) would outlive the reset that evicted the
      // thief's session. So every bearer credential that authenticates AS this
      // account is revoked too, which also ends the JWTs minted from it.
      // Credentials the user minted for other principals are left alone (see
      // `credential-eviction.server.ts`). Own try/catch, like the steps above.
      try {
        const { revokeBearerCredentialsOf } =
          await import("@/lib/api-auth/credential-eviction.server");
        await revokeBearerCredentialsOf({
          betterAuthUserId: user.id,
          trigger: "password_reset",
          actorBetterAuthUserId: user.id,
          request,
        });
      } catch (error) {
        const { logServerError } = await import("@/lib/observability/logger.server");
        logServerError("could not revoke bearer credentials after a password reset", {
          err: error,
          betterAuthUserId: user.id,
        });
      }
    },
    // Outbox-first delivery (specs.md §35): the email is rendered and
    // recorded in `app_outbox` even when no provider is configured, so
    // the forgot-password flow and the administrator "send reset email"
    // action are observable in every environment. Lazy import keeps the
    // email module out of the auth chain for tooling that only needs
    // the instance shape.
    //
    // F-20: the send runs AFTER the response (`deferEmailSend`). This
    // callback runs only when the account exists, so awaiting the send made a
    // real address answer 200-800 ms slower than an unknown one. The
    // administrator's "send reset email" reports the same thing as before:
    // Better Auth's `runInBackgroundOrAwait` already caught and logged a
    // failed send, so that action never saw delivery errors. The row now
    // lands just after its response.
    //
    // F-21: the greeting uses the name only once the mailbox is proven;
    // until then the name is whatever the account's creator typed, so the
    // address stands in (`resetEmailGreetingName`).
    sendResetPassword: async ({ user, url }) => {
      const { deferEmailSend } = await import("@/lib/email/defer-send.server");
      deferEmailSend({
        to: user.email,
        templateKey: "password_reset",
        variables: { name: resetEmailGreetingName(user), resetUrl: url },
        relatedBetterAuthUserId: user.id,
      });
    },
  } as NonNullable<BetterAuthOptions["emailAndPassword"]>,

  // Email verification (AUTH-4). Better Auth sends the verification link on
  // sign-up and, together with `requireEmailVerification` above, blocks sign-in
  // until the address is confirmed. Delivery is outbox-first (specs.md §35),
  // mirroring `sendResetPassword`; the lazy import keeps the email module out of
  // the auth chain for tooling that only needs the instance shape. `url` is the
  // Better Auth verification link, carrying the sign-up `callbackURL` as its
  // post-verification destination.
  //
  // `autoSignInAfterVerification: false` — clicking the link confirms the
  // address but does NOT create a session; the link's `callbackURL` points at
  // the localized "email verified" confirmation page (verify-email/confirmed),
  // which then offers an explicit "proceed to login" step. This keeps
  // verification and sign-in as distinct, legible steps instead of dropping a
  // freshly-verified user straight onto a secure page.
  //
  // F-20: the send is deferred past the response, like `sendResetPassword`.
  // Sign-up calls this only for a NEW address, and `/send-verification-email`
  // only for an unverified one. The deferral lives inside the callback because
  // `/send-verification-email` calls it with a plain await, which Better
  // Auth's `advanced.backgroundTasks` option would not have deferred. The rest
  // of the sign-up gap (creating and provisioning the user) is bounded by
  // `authResponseFloor` below.
  //
  // F-21: the email greets its recipient by ADDRESS, never by `user.name`.
  // Sign-up takes any address and any name, so the name was the caller's own
  // text in a signed email to a stranger (a phishing lure, repeatable through
  // `/send-verification-email`), and the recipient has proven nothing yet.
  // The template is unchanged; only the value of `{{name}}` is.
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    sendVerificationEmail: async ({ user, url }) => {
      // Per-org signup policy (0007): the `user.create.before` hook below
      // pre-verifies sign-ups whose organization waives verification, but
      // `sendOnSignUp` fires unconditionally — skip the pointless (and
      // confusing) verification email for an already-verified address.
      if (user.emailVerified) {
        return;
      }
      const { deferEmailSend } = await import("@/lib/email/defer-send.server");
      deferEmailSend({
        to: user.email,
        templateKey: "email_verification",
        variables: { name: user.email, verifyUrl: url },
        relatedBetterAuthUserId: user.id,
      });
    },
  },

  socialProviders,

  account: {
    accountLinking: {
      enabled: true,
      // Link accounts ONLY when the incoming provider profile asserts a
      // VERIFIED email matching the local account (specs.md §2 "Account
      // linking" / never-do list "Do not link accounts by unverified email").
      //
      // `trustedProviders` must stay EMPTY: listing a provider does not
      // restrict linking to it — it EXEMPTS that provider from the incoming
      // profile's `emailVerified` requirement (better-auth 1.6.23,
      // oauth2/link-account.mjs and api/routes/callback.mjs both waive the
      // check for trusted providers). With Microsoft configured multi-tenant
      // (`tenantId: "organizations"`), trusting it would let any Entra tenant
      // admin mint a user with an arbitrary unverified `email` attribute and
      // implicitly link into a matching verified local account — the "nOAuth"
      // account takeover. Google/GitHub sign-ins still link fine because those
      // providers report `emailVerified: true` for verified addresses; Entra
      // sign-ins link only when the token carries a verified-email signal
      // (e.g. the `email_verified` / verified-primary-email optional claims).
      // The LOCAL account's email must also be verified
      // (`requireLocalEmailVerified` defaults to true).
      trustedProviders: [],
      allowDifferentEmails: false,
    },
  },

  session: {
    // 8-hour rolling session, refreshed every 15 minutes of activity.
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 15,
  },

  advanced: {
    // Client IP for the built-in limiter (sign-in 3/10 s, reset 3/60 s) and
    // `session.ipAddress`: read ONLY the header `src/proxy.ts` derives with
    // the app's CLIENT_IP_SOURCE / TRUSTED_PROXY_COUNT model (F-17) and
    // always overwrites (review #35).
    // Better Auth's default `x-forwarded-for` read trusts a single-value
    // header only, so multi-hop chains collapsed into one deployment-wide
    // `no-trusted-ip` bucket and a bare client-supplied value was trusted.
    // The header holds a validated, port-stripped address (F-16); Better Auth
    // masks IPv6 to its default /64 `ipv6Subnet`, the grouping the app's own
    // limiter keys use, so `session.ipAddress` holds that /64 for IPv6.
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },

    // Shared-session (Option C) support: with COOKIE_DOMAIN set, the session
    // cookie is issued on the parent domain (e.g. `.devresponse.com`) so
    // co-trusted satellites sharing this deployment's `auth` schema + secret
    // validate the same session with zero redirects. Unset (the default), the
    // cookie stays host-only and per-app isolation is preserved — see the env
    // schema docstring and docs/integration-satellite-apps.md §5. Set, it
    // reaches EVERY host under the domain, A/B handoff satellites included,
    // whose servers then see this session on each request (F-24, §1.1).
    ...(env.COOKIE_DOMAIN
      ? { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
      : {}),
  },

  databaseHooks: {
    // AUTH-5: provision the app_users row at SIGN-UP (email/password), so a
    // self-registered account is visible in the admin Users list immediately —
    // even before it verifies its email. With `requireEmailVerification` a new
    // user gets NO session until they verify, so the `session.create` hook below
    // would never run and the account would be a "ghost" (present in Better
    // Auth, absent from `app_users`). This restores the pre-AUTH-4 behaviour.
    user: {
      create: {
        // F-21: every new user's name is bounded here, whoever creates it:
        // sign-up, the admin wrappers, an OAuth sign-in. `boundedUserName`
        // sanitizes and truncates and never refuses, so a provider's
        // 5000-character or control-character display name cannot break the
        // sign-in. A name the caller typed was already refused or
        // canonicalized by `userNameGuard` (sign-up) or the route's zod schema
        // (admin, API), so for those this changes nothing.
        // Then the sign-up verification waiver (`selfSignupVerification`
        // below), which only ever applies to `/sign-up/email`.
        before: async (user, context) => ({
          data: { ...boundedUserName(user), ...(await selfSignupVerification(user, context)) },
        }),
        after: async (user, context) => {
          if (!context) {
            return;
          }
          // Provision only the email/password self-registration endpoint:
          //   - OAuth (`/callback/*`) gets a session immediately → the session
          //     hook below covers it (unchanged).
          //   - Admin / machine-API creation (`/admin/create-user`) provisions
          //     `app_users` itself (POST /api/administrator/users, /api/v1/users).
          //   - Seeds hit `/sign-up/email` too but provision themselves and
          //     suppress this hook (see auth-signup-provisioning).
          // `provisionUserFromAuth` is idempotent, so the session hook
          // re-running after the user later verifies + signs in is a no-op.
          const { shouldProvisionSelfSignup } = await import("@/lib/auth-signup-provisioning");
          if (!shouldProvisionSelfSignup(context)) {
            return;
          }
          const { provisionUserFromAuth } = await import("@/lib/user-provisioning.server");
          try {
            await provisionUserFromAuth({
              betterAuthUserId: user.id,
              email: user.email,
              emailVerified: user.emailVerified,
              emailVerificationWaived: isEmailVerificationWaived(user),
              displayName: user.name,
              provider: getProvisioningProvider(context),
              preferredLocale: getPreferredLocale(context),
              invitationToken: getInvitationToken(context),
              organizationHint: getSignupOrganizationHint(context),
            });
          } catch (error) {
            // Best-effort: a provisioning hiccup must never fail the sign-up
            // itself (the Better Auth user + verification email already exist).
            // The idempotent session hook re-provisions on the first sign-in.
            const { logServerError } = await import("@/lib/observability/logger.server");
            logServerError("sign-up app-user provisioning failed", {
              err: error,
              betterAuthUserId: user.id,
            });
          }
        },
      },
      // F-21: the same bound on every UPDATE that sets a name: `/update-user`
      // (the profile route's cookie branch), `internalAdapter.updateUser` (the
      // profile route's bearer branch, the admin display-name mirror) and an
      // OAuth sign-in that refreshes the stored profile. A write without a
      // name (ban, role, `emailVerified`) passes untouched.
      update: {
        before: async (data) => {
          const bounded = boundedUserName(data);
          return bounded.name === undefined ? undefined : { data: bounded };
        },
      },
    },
    session: {
      create: {
        after: async (session, context) => {
          if (!context) {
            return;
          }

          // Impersonation creates a session for the TARGET via the admin
          // plugin's `impersonateUser`, which stamps `impersonatedBy` on the
          // new session row. That is NOT a login by the target, so this hook
          // must skip both effects below: (1) recording a login attributed to
          // a user who never signed in — polluting the daily-logins metric and
          // the auth audit trail used to review impersonation itself — and
          // (2) re-evaluating (and possibly auto-activating) a pending target
          // as a side effect of an admin merely impersonating them.
          // Impersonation is audited separately by the impersonate route. Field
          // name mirrors getImpersonatorId (accept camel/snake for plugin
          // version drift). (audit #15)
          const impersonated = session as {
            impersonatedBy?: unknown;
            impersonated_by?: unknown;
          };
          if (impersonated.impersonatedBy ?? impersonated.impersonated_by) {
            return;
          }

          const authUser = await context.context.internalAdapter.findUserById(session.userId);
          if (!authUser) {
            return;
          }

          // Record the login (every session creation is one login; refreshes
          // don't fire this hook) for the "daily logins" dashboard metrics.
          // Best-effort and lazily imported — it never blocks or breaks
          // sign-in. Runs for ALL logins, so it must precede the
          // existing-user early return below.
          const { recordSessionLogin } = await import("@/lib/auth-login-audit.server");
          await recordSessionLogin(
            authUser.id,
            context.request ? { headers: context.request.headers } : undefined,
          );

          const existing = await db
            .selectFrom("app_users")
            .select(["id", "status"])
            .where("better_auth_user_id", "=", authUser.id)
            .executeTakeFirst();

          if (existing) {
            // Per-org signup policy (0007): a still-pending account may now
            // qualify for activation — its org switched to `auto_active`, or
            // the address is now verified and matches an auto-approve domain
            // (a user who just confirmed their email re-signs-in here, since
            // verification no longer auto-creates a session).
            // Best-effort and fail-closed: on any error the user simply stays
            // pending and sign-in itself is never blocked.
            if (existing.status === "pending_approval") {
              try {
                const { reevaluatePendingActivation } =
                  await import("@/lib/user-provisioning.server");
                await reevaluatePendingActivation({
                  betterAuthUserId: authUser.id,
                  email: authUser.email,
                  emailVerified: authUser.emailVerified,
                  emailVerificationWaived: isEmailVerificationWaived(authUser),
                  provider: getProvisioningProvider(context),
                });
              } catch (error) {
                const { logServerError } = await import("@/lib/observability/logger.server");
                logServerError("pending-activation re-evaluation failed", {
                  err: error,
                  betterAuthUserId: authUser.id,
                });
              }
            }
            return;
          }

          const { provisionUserFromAuth } = await import("@/lib/user-provisioning.server");

          // This new-user branch is the SOCIAL sign-up path (email/password is
          // provisioned earlier in `user.create.after`, so it is already an
          // existing row by here). OAuth carries no sign-up body, so an
          // organization-scoped social sign-up hands its hint across the round
          // trip via the `org_signup_hint` cookie the proxy set on the scoped
          // page. Placement only — provisioning still applies the org's policy.
          await provisionUserFromAuth({
            betterAuthUserId: authUser.id,
            email: authUser.email,
            emailVerified: authUser.emailVerified,
            emailVerificationWaived: isEmailVerificationWaived(authUser),
            displayName: authUser.name,
            provider: getProvisioningProvider(context),
            preferredLocale: getPreferredLocale(context),
            organizationHint: readCookieValue(
              context.request?.headers.get("cookie"),
              ORG_SIGNUP_HINT_COOKIE,
            ),
          });
        },
      },
    },
  },

  // F-06: vendor endpoints the app never calls over HTTP (provider-token
  // readers, account linking, the password oracle, raw user/session writes)
  // answer 404 for everyone. Server-side `auth.api.*` calls are unaffected —
  // Better Auth checks this list in the HTTP router only. The list and the
  // reason for every entry live in `auth-admin-surface.ts`.
  disabledPaths: [...AUTH_DISABLED_PATHS],

  // Review 2026-09-04 #3: the admin plugin's raw HTTP surface
  // (`/api/auth/admin/*`) is closed. The app only ever reaches the plugin via
  // server-side `auth.api.*` calls (headers, never `request`), which this
  // hook lets through; real HTTP requests to `/admin/*` get 404. The same hook
  // confines an IMPERSONATED session to `/get-session` and `/sign-out`
  // (IMP-3, deny-by-default since F-06). Policy and rationale live in
  // `auth-admin-surface.ts`.
  //
  // F-10: after a successful "sign out my other sessions" (the password form's
  // `revokeOtherSessions`, `/revoke-other-sessions`), the single `after` hook
  // also ends the sessions the user opened as someone else, which Better
  // Auth's by-`userId` sweep never reaches. See `auth-session-sweep.ts`.
  hooks: { before: rejectClosedAuthEndpoints, after: endBorrowedSessionsAfterOwnSweep },

  // The nextCookies plugin makes Better Auth set cookies via Next.js
  // server actions and route handlers correctly — it MUST stay last.
  plugins: [
    // Plugin options (incl. the `allowImpersonatingAdmins` decision) are
    // shared with the security test that exercises the real plugin — see
    // `auth-admin-surface.ts` for the rationale.
    admin(ADMIN_PLUGIN_OPTIONS),
    ssoSession(),
    // F-21: `/sign-up/email` and `/update-user` refuse a name that breaks the
    // rule in `user-name.ts` with a 400 (`INVALID_NAME`), for a new and an
    // existing address alike, and store an accepted one in its canonical
    // spelling. The database hooks above bound every other writer. Its 400
    // skips the response floor below (a before-hook throw skips every after
    // hook, whatever the order), which is safe: it depends only on the name.
    userNameGuard(),
    // F-20: sign-up, password-reset and resend-verification responses over
    // HTTP take at least a fixed minimum time, so the extra database work an
    // existing (or a new) account causes does not show in response time. The
    // paths, the size and the reasons are in `auth-response-floor.ts`.
    authResponseFloor(),
    nextCookies(),
  ],
});

/** Convenience type for the resolved session shape. */
export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * The sign-up verification waiver: the fields the `user.create.before` hook
 * above adds to a new user, on top of its bounded name (F-21). Moved out of
 * the hook so no early return can skip the name bound.
 *
 * Per-org signup policy (0007): when the organization that will
 * receive this sign-up waives email verification, pre-verify the
 * identity AT CREATION. The global `requireEmailVerification: true`
 * stays on (fail-closed) and passes naturally for these users; the
 * client form then signs them in immediately (sign-up itself never
 * starts a session while `requireEmailVerification` is set — see
 * better-auth's sign-up route, which decides from static options).
 * Scope: genuine email/password self-registrations only —
 * `shouldProvisionSelfSignup` excludes OAuth callbacks (verification
 * state belongs to the provider), admin/machine creation (which sets
 * `emailVerified` explicitly), and suppressed seed runs.
 *
 * Review 2026-09-04 #2 — two invariants this upholds:
 *   1. "The organization that will receive this sign-up" is resolved
 *      with the SAME precedence the `after` hook's provisioning uses
 *      (organization hint → provider metadata → email-domain routing
 *      → default), so the org whose policy waives verification is
 *      always the org the account lands in. Without the hint, a lax
 *      default org could waive verification for an account that
 *      `organizationHint` then placed in a strict org.
 *   2. The waiver is stamped as `emailVerified: true` PLUS the
 *      distinct `emailVerificationWaived: true` marker, so downstream
 *      activation logic (domain auto-approval, sign-in re-evaluation)
 *      can never mistake a policy waiver for a mailbox proof.
 */
async function selfSignupVerification(
  user: { email: string },
  context: GenericEndpointContext | null | undefined,
): Promise<Record<string, unknown> | undefined> {
  const { shouldProvisionSelfSignup } = await import("@/lib/auth-signup-provisioning");
  if (!shouldProvisionSelfSignup(context)) {
    return undefined;
  }
  // Invitation-backed sign-up (0008): presenting a live token for
  // THIS email proves mailbox access — the token was delivered to
  // that mailbox — so it carries the same weight as clicking a
  // verification link. Pre-verify regardless of the org's
  // verification policy. Any lookup failure falls through to the
  // policy path below (fail closed to the normal flow).
  const invitationToken = getInvitationToken(context);
  if (invitationToken) {
    try {
      const { findValidInvitationByToken } = await import("@/lib/invitations.server");
      const invitation = await findValidInvitationByToken(invitationToken);
      if (invitation && invitation.email === user.email.trim().toLowerCase()) {
        return { emailVerified: true };
      }
    } catch (error) {
      const { logServerError } = await import("@/lib/observability/logger.server");
      logServerError("invitation lookup failed in sign-up hook", { err: error });
    }
  }
  const { resolveSignupPolicy } = await import("@/lib/auth-policy.server");
  const policy = await resolveSignupPolicy(
    {
      provider: "email",
      email: user.email,
      emailVerified: false,
    },
    // Same hint, same channel, same precedence as the `after` hook's
    // `provisionUserFromAuth` call — the two must resolve one org.
    { organizationHint: getSignupOrganizationHint(context) },
  );
  if (policy.requireEmailVerification) {
    return undefined;
  }
  return { emailVerified: true, [EMAIL_VERIFICATION_WAIVED_FIELD]: true };
}

/**
 * Extracts the invitation secret riding a sign-up request body (0008). The
 * extra field flows through better-auth's sign-up schema (which accepts a
 * record of additional fields) into `context.body`, same as `callbackURL`.
 */
function getInvitationToken(
  context: GenericEndpointContext | null | undefined,
): string | undefined {
  const token =
    context?.body && typeof context.body === "object" && "invitationToken" in context.body
      ? (context.body as Record<string, unknown>).invitationToken
      : undefined;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * Extracts the organization-scoped sign-up hint riding a sign-up request body
 * (`/sign-in/<org>`, `?org=<slug>`). Same channel as `invitationToken`: an
 * extra field flowing through better-auth's sign-up schema into `context.body`.
 * Placement only — provisioning still applies the target org's signup policy.
 */
function getSignupOrganizationHint(
  context: GenericEndpointContext | null | undefined,
): string | undefined {
  const hint =
    context?.body && typeof context.body === "object" && "organizationHint" in context.body
      ? (context.body as Record<string, unknown>).organizationHint
      : undefined;
  return typeof hint === "string" && hint.length > 0 ? hint : undefined;
}

function getPreferredLocale(context: GenericEndpointContext): string | undefined {
  const callbackUrl =
    context.body && typeof context.body === "object" && "callbackURL" in context.body
      ? context.body.callbackURL
      : undefined;
  const referer = context.request?.headers.get("referer") ?? undefined;

  for (const candidate of [callbackUrl, referer]) {
    if (typeof candidate !== "string") {
      continue;
    }

    const locale = extractLocale(candidate);
    if (locale) {
      return locale;
    }
  }

  return undefined;
}

function extractLocale(candidate: string): string | undefined {
  // `candidate` comes from a request body / Referer header, so a
  // malformed URL must not throw inside the session-create hook.
  let path: string;
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    try {
      path = new URL(candidate).pathname;
    } catch {
      return undefined;
    }
  } else {
    path = candidate;
  }
  const locale = path.split("/").filter(Boolean)[0];

  return locale && isSupportedLocale(locale) ? locale : undefined;
}
