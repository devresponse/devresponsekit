import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface EmailVerifiedPanelProps {
  /** Locale used to build the sign-in link. */
  locale: string;
  className?: string;
}

/**
 * EmailVerifiedPanel
 *
 * Rendered by `/verify-email/confirmed` — where the email-verification link
 * lands now that `autoSignInAfterVerification` is off (see auth.ts). Clicking
 * the link confirmed the address WITHOUT creating a session, so this is a
 * public confirmation screen: it tells the user their email is verified and
 * offers an explicit "proceed to login" step. Like the other pre-auth panels
 * it MUST NOT render the secure shell or call any secure menu APIs.
 */
export function EmailVerifiedPanel({ locale, className }: EmailVerifiedPanelProps) {
  const t = useTranslations("auth");
  return (
    <Card className={`w-full ${className ?? ""}`.trim()}>
      <CardHeader>
        <CardTitle>{t("emailVerifiedTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>{t("emailVerifiedTitle")}</AlertTitle>
          <AlertDescription>{t("emailVerifiedDescription")}</AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <LocaleLink locale={locale} href="/sign-in">
            {t("proceedToLogin")}
          </LocaleLink>
        </Button>
      </CardContent>
    </Card>
  );
}
