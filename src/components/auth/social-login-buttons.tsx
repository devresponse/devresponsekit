"use client";

import { useTranslations } from "next-intl";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export interface SocialLoginButtonsProps {
  /** Sanitized localized return path. Set by the parent server component. */
  returnTo: string;
}

/**
 * SocialLoginButtons
 *
 * Starts OAuth via Better Auth for Google, Microsoft, and GitHub. The
 * `callbackURL` is a sanitized localized path produced server-side by
 * `getSafeReturnTo`, preventing open-redirect abuse from query strings.
 */
export function SocialLoginButtons({ returnTo }: SocialLoginButtonsProps) {
  const t = useTranslations("auth");

  async function signIn(provider: "google" | "microsoft" | "github") {
    await authClient.signIn.social({
      provider,
      callbackURL: returnTo,
    });
  }

  return (
    <div className="grid gap-2">
      <Button type="button" variant="outline" onClick={() => signIn("google")}>
        {t("signInWithGoogle")}
      </Button>
      <Button type="button" variant="outline" onClick={() => signIn("microsoft")}>
        {t("signInWithMicrosoft")}
      </Button>
      <Button type="button" variant="outline" onClick={() => signIn("github")}>
        <Github className="mr-2 h-4 w-4" aria-hidden="true" />
        {t("signInWithGitHub")}
      </Button>
    </div>
  );
}
