import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Pending approval landing page.
 *
 * Reached when a non-seed user has signed in but has not been approved
 * by an administrator. MUST NOT render the secure shell or fetch any
 * secure menus per §13. Includes a local sign-out button.
 */
export default async function PendingApprovalPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return <Body locale={safeLocale} />;
}

function Body({ locale }: { locale: string }) {
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
          <SignOutButton locale={locale} />
        </CardContent>
      </Card>
    </main>
  );
}
