"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export interface SignOutButtonProps {
  locale: string;
}

/**
 * SignOutButton
 *
 * Performs Better Auth local-only sign-out for the current subdomain
 * and redirects to the localized `/logged-out` page. Other subdomain
 * sessions are intentionally untouched per §21.
 */
export function SignOutButton({ locale }: SignOutButtonProps) {
  const t = useTranslations("common");
  return (
    <Button
      type="button"
      variant="outline"
      onClick={async () => {
        await authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              window.location.href = `/${locale}/logged-out`;
            },
          },
        });
      }}
    >
      {t("signOut")}
    </Button>
  );
}
