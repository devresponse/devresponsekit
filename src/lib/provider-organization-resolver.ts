import { DEFAULT_ORGANIZATION_PROVIDER_KEY } from "@/lib/default-organization";

/**
 * Provider-organization input shape.
 *
 * Review #38 — this used to carry loosely-typed `profile` / `account` bags so
 * the resolver could read a Microsoft `tid` or a Google `hd` claim. Nothing
 * ever populated them: neither `provisionUserFromAuth` call site passed
 * either field, so both branches were unreachable and every social sign-up
 * resolved to `default`. The branches are GONE rather than wired up, because
 * wiring them would have been a silent policy change, not a fix: the caller
 * then routed an unknown key by creating an organization whose slug WAS the
 * key (removed by F-52), so switching the claims on would have repointed
 * every existing Google Workspace / Entra sign-up out of `default` and
 * spawned GUID-slugged organizations from raw tenant ids.
 *
 * The supported ways to place a sign-up in a specific organization are all
 * admin-curated and already live: a live invitation, an
 * organization-scoped sign-up hint (`/sign-in/<org>`), and the email-domain
 * mapping in `app_provider_organizations`. Tenant-claim routing can be
 * reintroduced on top of that curated table — where an unmatched tenant id
 * resolves to nothing instead of creating an organization — if an operator
 * ever asks for it.
 */
export interface ProviderOrganizationInput {
  provider: "google" | "microsoft" | "github" | "email";
  email: string;
  emailVerified: boolean;
}

export interface ProviderOrganizationResolution {
  provider: string;
  /**
   * The display label `default`, stored on the membership and audit row of a
   * sign-up that falls back to the default organization. It is NOT a slug
   * and is never resolved back to an org: callers find THE default
   * organization by `is_default` (`getDefaultOrganization`, F-40).
   */
  providerOrganizationKey: string;
  /** Recorded on the audit row; no provider metadata places a sign-up (F-52). */
  confidence: "fallback";
  /**
   * True when the superadmin-curated email-domain binding
   * (`app_provider_organizations` with provider `email`, looked up by
   * `findEmailDomainOrganization`) may place this sign-up: every
   * email/password sign-up, and a GitHub sign-in whose address GitHub
   * verified (F-52). A sign-up it does not place lands in the default
   * organization.
   */
  routesByEmailDomain: boolean;
}

/**
 * Resolves what provider metadata contributes to placing a sign-up: never an
 * organization of its own, at most a match against the curated email-domain
 * binding.
 *
 * Threat / contract:
 *   - Falling back to the default organization is always safe: the org's own
 *     sign-up policy decides the initial status, and placement looks the org
 *     up by `is_default`, never by a slug (F-40).
 *   - GitHub (F-52): a verified address's domain used to be the organization
 *     SLUG. The sign-in joined whatever org had that slug, and created an
 *     active one when none did, so the first GitHub user with a verified
 *     gmail.com address founded a tenant every later one joined, verified
 *     addresses on throwaway subdomains minted one org each, and an acme.com
 *     user skipped the superadmin's acme.com binding for an org of their own.
 *     The address now only meets the binding an email/password sign-up
 *     meets, which a superadmin creates and which refuses consumer mailbox
 *     domains (F-04). An UNVERIFIED GitHub address meets nothing: GitHub has
 *     not proven it, and no verification step of ours runs for an OAuth
 *     sign-in (an email/password sign-up's is governed by the policy of the
 *     org the binding picks).
 *   - Google and Microsoft resolve to `default` and are not matched against
 *     the binding; see the input docstring (review #38) for why their tenant
 *     claims are deliberately not read.
 */
export function resolveProviderOrganization(
  input: ProviderOrganizationInput,
): ProviderOrganizationResolution {
  return {
    provider: input.provider,
    providerOrganizationKey: DEFAULT_ORGANIZATION_PROVIDER_KEY,
    confidence: "fallback",
    routesByEmailDomain:
      input.provider === "email" || (input.provider === "github" && input.emailVerified),
  };
}
