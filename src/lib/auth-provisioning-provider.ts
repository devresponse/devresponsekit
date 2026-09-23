import type { AuthMethod } from "@/lib/auth-policy.server";
import { SOCIAL_PROVIDERS, type SocialProvider } from "@/lib/social-providers";

/**
 * The slice of a Better Auth endpoint / database-hook context this module
 * reads. Structural, so the hooks' `GenericEndpointContext` and test doubles
 * both fit.
 */
export interface ProvisioningProviderContext {
  path?: string | null;
  params?: Record<string, unknown> | null;
  body?: unknown;
  request?: { url?: string } | null;
}

/** Better Auth's OAuth callback endpoint, as it appears in `context.path`. */
const OAUTH_CALLBACK_ROUTE = "/callback/:id";
/** Better Auth's social sign-in endpoint, which also serves ID-token sign-ins. */
const SOCIAL_SIGN_IN_ROUTE = "/sign-in/social";
/** A concrete callback URL segment: `/callback/<provider>`. */
const CONCRETE_CALLBACK_RE = /\/callback\/([^/?#]+)/;

function asSocialProvider(value: unknown): SocialProvider | null {
  return typeof value === "string" && (SOCIAL_PROVIDERS as readonly string[]).includes(value)
    ? (value as SocialProvider)
    : null;
}

function providerFromUrl(url: string | undefined): SocialProvider | null {
  if (!url) return null;
  try {
    return asSocialProvider(CONCRETE_CALLBACK_RE.exec(new URL(url).pathname)?.[1]);
  } catch {
    return null;
  }
}

/**
 * Which auth method produced a Better Auth context — the `provider` sign-up
 * provisioning places and activates by, and sign-in re-evaluation judges
 * (`decideInitialStatus`: an org's `allowedAuthMethods`, and email-domain
 * routing, which applies to `email` alone).
 *
 * Better Auth sets `context.path` to the endpoint's ROUTE PATTERN, not the
 * request URL: an OAuth callback arrives as `/callback/:id` with the provider
 * in `context.params.id` (confirmed against 1.7.5 by driving a real GitHub
 * callback through `auth.handler`). The previous matcher tested `context.path`
 * for the concrete `/callback/google` — which the pattern never contains — and,
 * because the pattern is truthy, never consulted the request URL, so EVERY
 * social sign-in was provisioned as `email`: an email-only org admitted Google
 * sign-ups, a Google-only org parked them as `auth_method_not_allowed`, and
 * they were routed by email domain.
 *
 * Resolution order:
 *   1. the callback route pattern → `params.id`;
 *   2. an ID-token social sign-in (`/sign-in/social` with a `provider` in the
 *      body), which creates its session without any callback;
 *   3. a concrete `/callback/<provider>` in the path or the request URL
 *      (defence in depth, should the vendor ever pass the concrete path);
 *   4. otherwise `email` — sign-up and sign-in with email/password.
 *
 * Only a configured social provider id is accepted from any of these, so a
 * forged or unknown id can never be mistaken for one.
 */
export function getProvisioningProvider(
  context: ProvisioningProviderContext | null | undefined,
): AuthMethod {
  const path = context?.path ?? "";

  if (path === OAUTH_CALLBACK_ROUTE) {
    const fromParams = asSocialProvider(context?.params?.id);
    if (fromParams) return fromParams;
  }

  if (path === SOCIAL_SIGN_IN_ROUTE) {
    const body = context?.body;
    const fromBody =
      body && typeof body === "object" && "provider" in body
        ? asSocialProvider((body as Record<string, unknown>).provider)
        : null;
    if (fromBody) return fromBody;
  }

  const fromPath = asSocialProvider(CONCRETE_CALLBACK_RE.exec(path)?.[1]);
  if (fromPath) return fromPath;

  return providerFromUrl(context?.request?.url) ?? "email";
}
