import { getTranslations } from "next-intl/server";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { API_SCOPE_CATALOG, isAccountScope } from "@/lib/api-auth/scopes";
import { AccountApiKeysPanel } from "./_api-keys-panel";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/account/api-keys
 *
 * Self-service API-key management. A user creates, rotates, and revokes
 * their OWN keys through the `/api/v1/me/api-keys` surface, which is
 * inherently self-scoped to the session principal — there is no user id
 * and no way to reach another account's keys.
 *
 * The grantable scope list is computed HERE from the caller's own
 * authority: account scopes are always self-grantable, plus any admin
 * permission the caller happens to hold. The `me` create endpoint
 * re-validates every requested scope against the same rule
 * (`ungrantableScopesForCaller`), so the picker is a convenience, not a
 * trust boundary.
 */
export default async function AccountApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/account/api-keys`);

  const grantableScopes = API_SCOPE_CATALOG.filter(
    (scope) => isAccountScope(scope) || access.permissions.includes(scope),
  );

  const t = await getTranslations({ locale, namespace: "account" });

  return (
    <section className="space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sections.apiKeys.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sections.apiKeys.description")}</p>
      </div>

      <AccountApiKeysPanel grantableScopes={grantableScopes} />
    </section>
  );
}
