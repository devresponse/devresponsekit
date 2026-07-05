import { useTranslations } from "next-intl";
import { InviteAcceptForm } from "@/components/auth/invite-accept-form";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SupportedLocale } from "@/config/i18n-config";

/**
 * Server-compatible panels for the localized `/invite` page (0008). Which
 * panel renders is decided server-side by the page; none of them ever
 * reveals anything about an organization unless the presented token
 * resolved to a LIVE invitation.
 */

/** Unknown / expired / revoked / consumed token — one generic answer. */
export function InviteInvalidPanel() {
  const t = useTranslations("auth");
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("inviteInvalidTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert>
          <AlertTitle>{t("inviteInvalidTitle")}</AlertTitle>
          <AlertDescription>{t("inviteInvalidDescription")}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

/** Valid token, no session: choose create-account or sign-in. */
export function InviteGuestPanel({
  locale,
  organizationName,
  token,
}: {
  locale: SupportedLocale;
  organizationName: string;
  token: string;
}) {
  const t = useTranslations("auth");
  const returnPath = `/${locale}/invite?token=${encodeURIComponent(token)}`;
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("inviteTitle")}</CardTitle>
        <CardDescription>
          {t("inviteGuestDescription", { organization: organizationName })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button asChild className="w-full">
          <LocaleLink locale={locale} href={`/sign-up?invite=${encodeURIComponent(token)}`}>
            {t("createAccount")}
          </LocaleLink>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <LocaleLink locale={locale} href={`/sign-in?returnTo=${encodeURIComponent(returnPath)}`}>
            {t("inviteSignIn")}
          </LocaleLink>
        </Button>
      </CardContent>
    </Card>
  );
}

/** Valid token but the session belongs to a DIFFERENT email address. */
export function InviteMismatchPanel({ locale, token }: { locale: SupportedLocale; token: string }) {
  const t = useTranslations("auth");
  // Resume the invite after signing out: land back on this invite page (no
  // session → the guest panel), so the user can sign in or register with the
  // invited address instead of dead-ending on /logged-out.
  const resumeHref = `/${locale}/invite?token=${encodeURIComponent(token)}`;
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("inviteMismatchTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTitle>{t("inviteMismatchTitle")}</AlertTitle>
          <AlertDescription>{t("inviteMismatchDescription")}</AlertDescription>
        </Alert>
        <SignOutButton locale={locale} redirectTo={resumeHref} />
      </CardContent>
    </Card>
  );
}

/** Valid token, matching session: explicit accept. */
export function InviteAcceptPanel({
  locale,
  organizationName,
  email,
  token,
}: {
  locale: SupportedLocale;
  organizationName: string;
  email: string;
  token: string;
}) {
  const t = useTranslations("auth");
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{t("inviteTitle")}</CardTitle>
        <CardDescription>
          {t("inviteAcceptDescription", { organization: organizationName, email })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <InviteAcceptForm token={token} appHref={`/${locale}/app`} />
      </CardContent>
    </Card>
  );
}
