import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Blocked / suspended / deactivated landing page.
 *
 * Reached when the application user record exists but the status forbids
 * secure access. The page MUST NOT reveal admin-only operational details
 * such as "your account was banned by user X for reason Y" — only the
 * generic translated description is shown.
 */
export default async function BlockedPage({ params }: { params: Promise<{ locale: string }> }) {
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
          <CardTitle>{t("blockedTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTitle>{t("blockedTitle")}</AlertTitle>
            <AlertDescription>{t("blockedDescription")}</AlertDescription>
          </Alert>
          <SignOutButton locale={locale} />
        </CardContent>
      </Card>
    </main>
  );
}
