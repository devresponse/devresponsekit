import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * BlockedAccountPanel
 *
 * Server Component panel shown when the application user record exists
 * but the account status forbids secure access (`blocked`, `suspended`,
 * or `deactivated`). Rendered by `(auth)/blocked/page.tsx`.
 *
 * Security: must NOT reveal admin-only operational details such as who
 * blocked the account or the internal reason. Only the generic translated
 * description is shown, matching the threat model in §3.6.
 *
 * i18n: all copy comes from the `auth` message namespace.
 */
export function BlockedAccountPanel({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("blockedTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTitle>{t("blockedTitle")}</AlertTitle>
            <AlertDescription>{t("blockedDescription")}</AlertDescription>
          </Alert>
          {/* Provide a local sign-out so the user can attempt re-auth with a different account. */}
          <SignOutButton locale={locale} />
        </CardContent>
      </Card>
    </main>
  );
}
