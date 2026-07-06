import { useTranslations } from "next-intl";
import { EmailPasswordSignUpForm } from "@/components/auth/email-password-sign-up-form";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { SupportedLocale } from "@/config/i18n-config";
import type { OrganizationRef } from "@/lib/org-lookup.server";
import { buildActiveOrgApplyPath } from "@/lib/scoped-auth";
import type { SocialProvider } from "@/lib/social-providers";

/** A LIVE invitation carried by `/sign-up?invite=<token>` (0008). */
export interface SignUpInvitation {
  token: string;
  email: string;
  organizationName: string;
}

export interface SignUpFormProps {
  locale: SupportedLocale;
  returnTo: string;
  invitation?: SignUpInvitation | null;
  /** The configured social providers, from `enabledSocialProviders`. */
  socialProviders: readonly SocialProvider[];
  /**
   * The organization this sign-up is scoped to (`/sign-up?org=<slug>`), carried
   * from a scoped sign-in's "create account" link. Brands the screen and
   * threads the identifier into the sign-up body as `organizationHint`, so the
   * new account is TARGETED at that org — still gated by the org's signup
   * policy. Ignored when an `invitation` is present (the invitation's org wins).
   */
  organization?: OrganizationRef | null;
}

/**
 * SignUpForm
 *
 * Mirror of `SignInForm` but for self-registration. Email verification is
 * required (AUTH-4): after sign-up the user is sent to `/verify-email` to
 * confirm their address; once verified they land in the app and the
 * provisioning service places non-seed users into `pending_approval`.
 *
 * With an `invitation` (0008) the email field is pre-filled and locked to
 * the invited address and the token rides the sign-up body — the account is
 * pre-verified (the token proves mailbox access) and lands active in the
 * inviting organization.
 *
 * With an `organization` (scoped sign-up, no invitation) the screen is branded
 * for that org and the identifier rides the sign-up body so the new account
 * targets it — subject to the org's signup policy.
 */
export function SignUpForm({
  locale,
  returnTo,
  invitation,
  socialProviders,
  organization,
}: SignUpFormProps) {
  const t = useTranslations("auth");

  // An invitation's org is authoritative, so org scoping only applies to a
  // non-invited sign-up.
  const scopedOrg = invitation ? null : organization;
  // Existing member choosing a social provider on the scoped screen lands with
  // that org active (membership-checked); a brand-new social user routes by
  // provider identity, since OAuth can't carry the sign-up-body hint.
  const socialCallback = scopedOrg ? buildActiveOrgApplyPath(scopedOrg.slug, returnTo) : returnTo;

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("signUpTitle")}</CardTitle>
        <CardDescription>
          {scopedOrg
            ? t("createAccountForOrganization", { organization: scopedOrg.name })
            : t("noAccount")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {invitation ? (
          <Alert>
            <AlertDescription>
              {t("inviteSignupBanner", { organization: invitation.organizationName })}
            </AlertDescription>
          </Alert>
        ) : null}
        <EmailPasswordSignUpForm
          verifyEmailHref={`/${locale}/verify-email`}
          postVerifyHref={`/${locale}/app`}
          invitationToken={invitation?.token}
          invitedEmail={invitation?.email}
          organizationHint={scopedOrg?.slug}
        />
        {/* Social login is hidden on an invited sign-up (0008): the OAuth
            path does NOT carry the invitation token, so a social sign-in
            would silently drop it and land the invitee in pending_approval
            instead of active in the inviting org. Invitations are email-
            address-scoped and the emailed token already proves the mailbox,
            so email/password is the intended path here. */}
        {invitation || socialProviders.length === 0 ? null : (
          <>
            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs uppercase">{t("or")}</span>
              <Separator className="flex-1" />
            </div>
            <SocialLoginButtons returnTo={socialCallback} providers={socialProviders} />
          </>
        )}
        <div className="text-sm">
          <LocaleLink
            href={scopedOrg ? { pathname: "/sign-in", query: { org: scopedOrg.slug } } : "/sign-in"}
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
