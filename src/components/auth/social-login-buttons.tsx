"use client";

import { useTranslations } from "next-intl";
import { GithubIcon } from "@/components/icons/github-icon";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import type { SocialProvider } from "@/lib/social-providers";

/** `auth.*` translation key for each provider's button label. */
const PROVIDER_LABEL_KEY = {
  google: "signInWithGoogle",
  microsoft: "signInWithMicrosoft",
  github: "signInWithGitHub",
} as const satisfies Record<SocialProvider, string>;

export interface SocialLoginButtonsProps {
  /** Sanitized localized return path. Set by the parent server component. */
  returnTo: string;
  /**
   * Providers to render, in order — the set actually configured for this
   * deployment (`enabledSocialProviders`, derived server-side). Renders
   * nothing when empty so no button starts an OAuth flow that can't complete.
   */
  providers: readonly SocialProvider[];
}

/**
 * SocialLoginButtons
 *
 * Starts OAuth via Better Auth for each configured provider. The `callbackURL`
 * is a sanitized localized path produced server-side by `getSafeReturnTo`,
 * preventing open-redirect abuse from query strings.
 */
export function SocialLoginButtons({ returnTo, providers }: SocialLoginButtonsProps) {
  const t = useTranslations("auth");

  if (providers.length === 0) {
    return null;
  }

  async function signIn(provider: SocialProvider) {
    await authClient.signIn.social({
      provider,
      callbackURL: returnTo,
    });
  }

  return (
    <div className="grid gap-2">
      {providers.map((provider) => (
        <Button key={provider} type="button" variant="outline" onClick={() => signIn(provider)}>
          {provider === "github" ? <GithubIcon className="mr-2 h-4 w-4" /> : null}
          {t(PROVIDER_LABEL_KEY[provider])}
        </Button>
      ))}
    </div>
  );
}
