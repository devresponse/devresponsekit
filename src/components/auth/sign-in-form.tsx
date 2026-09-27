import { useTranslations } from "next-intl";
import { EmailPasswordLoginForm } from "@/components/auth/email-password-login-form";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { SupportedLocale } from "@/config/i18n-config";
import type { OrganizationRef } from "@/lib/org-lookup.server";
import { buildActiveOrgApplyPath } from "@/lib/scoped-auth";
import type { SocialProvider } from "@/lib/social-providers";

export interface SignInFormProps {
  locale: SupportedLocale;
  returnTo: string;
  /** The configured social providers, from `enabledSocialProviders`. */
  socialProviders: readonly SocialProvider[];
  /**
   * The organization this sign-in screen is scoped to (`/sign-in/<org>` or
   * `?org=<slug>`), or null for the plain shared screen. When set the screen is
   * branded for the org and — for an existing member — the active org is pinned
   * to it after login (via the apply-org callback, which covers email AND
   * social). The create-account link carries the scope so a new sign-up targets
   * the same org.
   */
  organization?: OrganizationRef | null;
  /**
   * The `?error=` code a refused social sign-in brought back (Better Auth's
   * `onAPIError.errorURL`, F-153), or null. Mapped to a translated message
   * here; the code itself and its `error_description` are never shown.
   */
  errorCode?: string | null;
}

/**
 * SignInForm
 *
 * Server Component that composes the sign-in card from translated content.
 * Email/password and the configured social providers render at the same time
 * per §14.1 (a provider only appears when its credentials are set). The
 * `returnTo` value is sanitized by the parent page.
 */
export function SignInForm({
  locale,
  returnTo,
  socialProviders,
  organization,
  errorCode,
}: SignInFormProps) {
  const t = useTranslations("auth");

  // Scoped sign-in: route the post-auth callback through the apply-org endpoint
  // so an existing member lands with this org active. The endpoint is
  // membership-checked, so a non-member simply falls through to `returnTo`.
  const callbackURL = organization
    ? buildActiveOrgApplyPath(organization.slug, returnTo)
    : returnTo;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("signInTitle")}</CardTitle>
        <CardDescription>
          {organization
            ? t("signInToOrganization", { organization: organization.name })
            : t("haveAccount")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {errorCode ? (
          // F-153: a banned account (BANNED_USER, a soft-deleted one included)
          // gets the blocked page's message, as the password form gives it;
          // any other refusal the generic one.
          <Alert variant="destructive">
            <AlertDescription>
              {errorCode === "BANNED_USER" ? t("blockedDescription") : t("unexpectedError")}
            </AlertDescription>
          </Alert>
        ) : null}
        <EmailPasswordLoginForm returnTo={callbackURL} />
        {socialProviders.length > 0 ? (
          <>
            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs uppercase">{t("or")}</span>
              <Separator className="flex-1" />
            </div>
            <SocialLoginButtons returnTo={callbackURL} providers={socialProviders} />
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
            href={
              organization
                ? { pathname: "/sign-up", query: { org: organization.slug } }
                : "/sign-up"
            }
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
