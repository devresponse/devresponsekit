import {
  DEFAULT_ORGANIZATION_PROVIDER_KEY,
  INITIAL_DEFAULT_ORGANIZATION,
} from "@/lib/default-organization";

/**
 * Provider-organization input shape.
 *
 * Review #38 — this used to carry loosely-typed `profile` / `account` bags so
 * the resolver could read a Microsoft `tid` or a Google `hd` claim. Nothing
 * ever populated them: neither `provisionUserFromAuth` call site passed
 * either field, so both branches were unreachable and every social sign-up
 * resolved to `default`. The branches are GONE rather than wired up, because
 * wiring them would have been a silent policy change, not a fix: the caller
 * routes an unknown key by creating an organization whose slug IS the key
 * (`user-provisioning.server.ts`), so switching the claims on would have
 * repointed every existing Google Workspace / Entra sign-up out of `default`
 * and spawned GUID-slugged organizations from raw tenant ids.
 *
 * The supported ways to place a sign-up in a specific organization are all
 * admin-curated and already live: a live invitation (0008), an
 * organization-scoped sign-up hint (`/sign-in/<org>`), and the email-domain
 * mapping in `app_provider_organizations` (0007). Tenant-claim routing can be
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
   * The provider-derived organization key (GitHub: the verified email
   * domain), or the display label `default` when the sign-up falls back to
   * the default organization. That label is stored on the membership and
   * audit row only; it is NOT a slug and is never resolved back to an org
   * (F-40) — {@link routesToDefaultOrganization} says which case this is.
   */
  providerOrganizationKey: string;
  displayName: string;
  confidence: "medium" | "fallback";
  /**
   * True when no provider metadata placed the sign-up, so it belongs in THE
   * default organization, which callers resolve by `is_default`
   * (`getDefaultOrganization`). Before F-40 callers compared
   * `providerOrganizationKey` with `"default"` and then looked the org up by
   * that slug, so renaming the default org's slug made provisioning create a
   * second, adminless "Default Organization".
   */
  routesToDefaultOrganization: boolean;
}

/**
 * Resolves an application organization key from provider metadata.
 *
 * Threat / contract:
 *   - Falling back to the default organization is always safe: the org's own
 *     sign-up policy decides the initial status, and placement looks the org
 *     up by `is_default`, never by a slug (F-40).
 *   - GitHub uses email domain only when the email is verified, since
 *     GitHub does not surface organization data in the OAuth profile by
 *     default and we do not query its API.
 *   - Google and Microsoft resolve to `default`; see the input docstring
 *     (review #38) for why their tenant claims are deliberately not read.
 */
export function resolveProviderOrganization(
  input: ProviderOrganizationInput,
): ProviderOrganizationResolution {
  const emailDomain = input.email.split("@")[1]?.toLowerCase() ?? "unknown";

  if (input.provider === "github" && input.emailVerified) {
    return {
      provider: "github",
      providerOrganizationKey: emailDomain,
      displayName: emailDomain,
      confidence: "medium",
      routesToDefaultOrganization: false,
    };
  }

  return {
    provider: input.provider,
    providerOrganizationKey: DEFAULT_ORGANIZATION_PROVIDER_KEY,
    displayName: INITIAL_DEFAULT_ORGANIZATION.name,
    confidence: "fallback",
    routesToDefaultOrganization: true,
  };
}
