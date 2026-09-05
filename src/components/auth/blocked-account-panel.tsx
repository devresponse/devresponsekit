import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface BlockedAccountPanelProps {
  /** Locale for the embedded `SignOutButton`'s post-logout redirect. */
  locale: string;
  className?: string;
}

/**
 * BlockedAccountPanel
 *
 * Server-compatible panel rendered by the localized `/blocked` page when
 * the user's application status is `blocked`, `suspended`, or
 * `deactivated`. Shows only the generic translated description — never
 * admin-only operational details such as who blocked the account or
 * why — to avoid leaking moderation context to end users.
 *
 * Includes a `SignOutButton` so the user can clear their local session
 * (sign-out is local-only per spec §21) and try again under a different
 * account if applicable.
 */
export function BlockedAccountPanel({ locale, className }: BlockedAccountPanelProps) {
  const t = useTranslations("auth");
  return (
    <Card className={`w-full ${className ?? ""}`.trim()}>
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
  );
}
