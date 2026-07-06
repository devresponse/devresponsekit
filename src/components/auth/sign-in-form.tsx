import { useTranslations } from "next-intl";
import { EmailPasswordLoginForm } from "@/components/auth/email-password-login-form";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { SupportedLocale } from "@/config/i18n-config";
import type { SocialProvider } from "@/lib/social-providers";

export interface SignInFormProps {
  locale: SupportedLocale;
  returnTo: string;
  /** The configured social providers, from `enabledSocialProviders`. */
  socialProviders: readonly SocialProvider[];
}

/**
 * SignInForm
 *
 * Server Component that composes the sign-in card from translated content.
 * Email/password and the configured social providers render at the same time
 * per §14.1 (a provider only appears when its credentials are set). The
 * `returnTo` value is sanitized by the parent page.
 */
export function SignInForm({ locale, returnTo, socialProviders }: SignInFormProps) {
  const t = useTranslations("auth");

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>{t("haveAccount")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <EmailPasswordLoginForm returnTo={returnTo} />
        {socialProviders.length > 0 ? (
          <>
            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs uppercase">{t("or")}</span>
              <Separator className="flex-1" />
            </div>
            <SocialLoginButtons returnTo={returnTo} providers={socialProviders} />
          </>
        ) : null}
        <div className="flex justify-between text-sm">
          <LocaleLink
            href="/forgot-password"
            locale={locale}
            className="underline-offset-2 hover:underline"
          >
            {t("forgotPassword")}
          </LocaleLink>
          <LocaleLink
            href="/sign-up"
            locale={locale}
            className="underline-offset-2 hover:underline"
          >
            {t("createAccount")}
          </LocaleLink>
        </div>
      </CardContent>
    </Card>
  );
}
