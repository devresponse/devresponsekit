import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * PendingApprovalPanel
 *
 * Server Component panel shown when a non-seed user has authenticated
 * but has not yet been approved by an administrator. Rendered by
 * `(auth)/pending-approval/page.tsx`.
 *
 * Per §3.5, pending users are redirected here instead of seeing the
 * secure shell. The page MUST NOT render secure navigation or fetch
 * secure menu APIs.
 *
 * i18n: all copy comes from the `auth` message namespace.
 */
export function PendingApprovalPanel({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("pendingApprovalTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>{t("pendingApprovalTitle")}</AlertTitle>
            <AlertDescription>{t("pendingApprovalDescription")}</AlertDescription>
          </Alert>
          {/* Allow the user to sign out and try a different account. */}
          <SignOutButton locale={locale} />
        </CardContent>
      </Card>
    </main>
  );
}
