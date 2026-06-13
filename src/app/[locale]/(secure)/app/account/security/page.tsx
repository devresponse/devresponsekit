import { getTranslations } from "next-intl/server";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { PasswordForm } from "./_password-form";
import { AccountSessionsPanel } from "./_sessions-panel";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/account/security
 *
 * Self-service security: change password and manage the caller's own
 * active sessions. Both operate through Better Auth's client, which is
 * inherently self-scoped to the current session user — there is no way
 * to act on another account.
 */
export default async function AccountSecurityPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  // Enforce the secure boundary (redirects if not an active member).
  await requireSecureSession(locale, `/${locale}/app/account/security`);

  const t = await getTranslations({ locale, namespace: "account" });

  return (
    <section className="space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sections.security.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sections.security.description")}</p>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">{t("security.passwordTitle")}</h2>
        <PasswordForm />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">{t("security.sessionsTitle")}</h2>
        <AccountSessionsPanel />
      </div>
    </section>
  );
}
