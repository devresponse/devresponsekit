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
 * Mirror of `SignInForm` but for self-registration. The provisioning
 * service places all non-seed users into `pending_approval`; the secure
 * layout will redirect newly registered users to `/pending-approval`
 * automatically — there is no special-case handling required here.
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
        <EmailPasswordSignUpForm returnTo={returnTo} />
        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs text-neutral-500 uppercase">{t("or")}</span>
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
