import { useTranslations } from "next-intl";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface VerifyEmailPanelProps {
  /** Locale used to build the post-verification destination. */
  locale: string;
  className?: string;
}

/**
 * VerifyEmailPanel
 *
 * Rendered by the localized `/verify-email` page immediately after an
 * email/password sign-up. Better Auth has already emailed the verification
 * link (`sendOnSignUp`); this is the "check your inbox" landing, with a resend
 * affordance for a lost or expired link. Like `PendingApprovalPanel`, it MUST
 * NOT render the secure shell or call any secure menu APIs.
 *
 * The verification link, once clicked, verifies the address and (via
 * `autoSignInAfterVerification`) lands the user at `/{locale}/app`, which routes
 * them onward — a new user to pending-approval, an approved one to the shell.
 */
export function VerifyEmailPanel({ locale, className }: VerifyEmailPanelProps) {
  const t = useTranslations("auth");
  return (
    <Card className={`w-full ${className ?? ""}`.trim()}>
      <CardHeader>
        <CardTitle>{t("verifyEmailTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>{t("verifyEmailTitle")}</AlertTitle>
          <AlertDescription>{t("verifyEmailDescription")}</AlertDescription>
        </Alert>
        <p className="text-muted-foreground text-sm">{t("verifyEmailResendPrompt")}</p>
        <ResendVerificationForm callbackUrl={`/${locale}/app`} />
      </CardContent>
    </Card>
  );
}
