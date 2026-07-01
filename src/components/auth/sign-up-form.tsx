import { useTranslations } from "next-intl";
import { EmailPasswordSignUpForm } from "@/components/auth/email-password-sign-up-form";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { SupportedLocale } from "@/config/i18n-config";

export interface SignUpFormProps {
  locale: SupportedLocale;
  returnTo: string;
}

/**
 * SignUpForm
 *
 * Mirror of `SignInForm` but for self-registration. Email verification is
 * required (AUTH-4): after sign-up the user is sent to `/verify-email` to
 * confirm their address; once verified they land in the app and the
 * provisioning service places non-seed users into `pending_approval`.
 */
export function SignUpForm({ locale, returnTo }: SignUpFormProps) {
  const t = useTranslations("auth");

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("signUpTitle")}</CardTitle>
        <CardDescription>{t("noAccount")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <EmailPasswordSignUpForm
          verifyEmailHref={`/${locale}/verify-email`}
          postVerifyHref={`/${locale}/app`}
        />
        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs uppercase">{t("or")}</span>
          <Separator className="flex-1" />
        </div>
        <SocialLoginButtons returnTo={returnTo} />
        <div className="text-sm">
          <LocaleLink
            href="/sign-in"
            locale={locale}
            className="underline-offset-2 hover:underline"
          >
            {t("haveAccount")}
          </LocaleLink>
        </div>
      </CardContent>
    </Card>
  );
}
