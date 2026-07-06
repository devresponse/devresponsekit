/**
 * Social OAuth providers this app can offer, in canonical display order.
 *
 * Pure data with no runtime dependencies, so it is safe to import from BOTH
 * the server auth config (`src/lib/auth.ts`, which decides which providers are
 * actually enabled from the environment) and the client `SocialLoginButtons`
 * (which renders them). Sharing one definition is what keeps the enabled set
 * and the rendered set from drifting.
 */
export const SOCIAL_PROVIDERS = ["google", "microsoft", "github"] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];
