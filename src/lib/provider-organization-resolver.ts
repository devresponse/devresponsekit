/**
 * Provider-organization input shape.
 *
 * `profile` and `account` are loosely typed because each identity provider
 * returns a different shape (Google `hd`, Microsoft `tid`, GitHub varies).
 * Down-stream code uses safe accessors instead of casting.
 */
export interface ProviderOrganizationInput {
  provider: "google" | "microsoft" | "github" | "email";
  email: string;
  emailVerified: boolean;
  profile?: Record<string, unknown>;
  account?: Record<string, unknown>;
}

export interface ProviderOrganizationResolution {
  provider: string;
  providerOrganizationKey: string;
  displayName: string;
  confidence: "high" | "medium" | "fallback";
}

/**
 * Resolves an application organization key from provider metadata.
 *
 * Threat / contract:
 *   - Returning `default` is always safe; downstream membership creation
 *     keeps the user in `pending_approval` until an admin approves them.
 *   - Provider-specific keys are only accepted when present and trimmed.
 *   - GitHub uses email domain only when the email is verified, since
 *     GitHub does not surface organization data in the OAuth profile by
 *     default and we do not query its API.
 */
export function resolveProviderOrganization(
  input: ProviderOrganizationInput,
): ProviderOrganizationResolution {
  const emailDomain = input.email.split("@")[1]?.toLowerCase() ?? "unknown";

  if (input.provider === "microsoft") {
    const tenantId =
      readString(input.profile?.["tid"]) ??
      readString(input.account?.["tenantId"]) ??
      readString(input.account?.["tid"]);

    if (tenantId) {
      return {
        provider: "microsoft",
        providerOrganizationKey: tenantId,
        displayName: `Microsoft Entra tenant ${tenantId}`,
        confidence: "high",
      };
    }
  }

  if (input.provider === "google") {
    const hostedDomain = readString(input.profile?.["hd"]);
    if (hostedDomain) {
      return {
        provider: "google",
        providerOrganizationKey: hostedDomain.toLowerCase(),
        displayName: hostedDomain.toLowerCase(),
        confidence: "high",
      };
    }
  }

  if (input.provider === "github" && input.emailVerified) {
    return {
      provider: "github",
      providerOrganizationKey: emailDomain,
      displayName: emailDomain,
      confidence: "medium",
    };
  }

  return {
    provider: input.provider,
    providerOrganizationKey: "default",
    displayName: "Default Organization",
    confidence: "fallback",
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
