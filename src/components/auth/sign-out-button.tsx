"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export interface SignOutButtonProps {
  locale: string;
  /**
   * Where to land after sign-out. Defaults to the localized `/logged-out`
   * page; callers mid-flow (e.g. the invite-mismatch panel) pass a resume
   * target so signing out to switch accounts doesn't dead-end the user.
   */
  redirectTo?: string;
}

/**
 * SignOutButton
 *
 * Performs Better Auth local-only sign-out for the current subdomain and
 * redirects to `redirectTo` (default: the localized `/logged-out` page).
 * Other subdomain sessions are intentionally untouched per §21.
 */
export function SignOutButton({ locale, redirectTo }: SignOutButtonProps) {
  const t = useTranslations("common");
  const destination = redirectTo ?? `/${locale}/logged-out`;
  return (
    <Button
      type="button"
      variant="outline"
      onClick={async () => {
        await authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              window.location.href = destination;
            },
          },
        });
      }}
    >
      {t("signOut")}
    </Button>
  );
}
