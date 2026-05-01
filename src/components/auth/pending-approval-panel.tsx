import { useTranslations } from "next-intl";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface PendingApprovalPanelProps {
  /** Locale for the embedded `SignOutButton`'s post-logout redirect. */
  locale: string;
  className?: string;
}

/**
 * PendingApprovalPanel
 *
 * Server-compatible panel rendered by the localized `/pending-approval`
 * page after a non-seed user signs in but before an administrator has
 * approved their account. MUST NOT render the secure shell or call any
 * secure menu APIs per spec §13.
 *
 * Includes a local `SignOutButton` so the user can drop their session
 * without waiting for the rolling timeout.
 */
export function PendingApprovalPanel({ locale, className }: PendingApprovalPanelProps) {
  const t = useTranslations("auth");
  return (
    <Card className={`w-full ${className ?? ""}`.trim()}>
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
  );
}
