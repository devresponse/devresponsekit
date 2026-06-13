import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isSupportedLocale, locales, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { getAccountPreferences } from "../_data.server";
import { PreferencesForm } from "./_preferences-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/account/preferences
 *
 * Edit the caller's locale and formatting preferences (locale, time
 * zone, date format, number-format locale). Scoped to `access.appUserId`.
 */
export default async function AccountPreferencesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { access } = await requireSecureSession(locale, `/${locale}/app/account/preferences`);

  if (!access.appUserId) notFound();
  const prefs = await getAccountPreferences(access.appUserId);

  const t = await getTranslations({ locale, namespace: "account" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sections.preferences.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sections.preferences.description")}</p>
      </div>

      <PreferencesForm
        locales={[...locales]}
        initial={{
          preferredLocale: prefs.preferredLocale,
          timeZone: prefs.timeZone ?? "",
          dateFormat: prefs.dateFormat ?? "system",
          numberFormatLocale: prefs.numberFormatLocale ?? "system",
        }}
      />
    </section>
  );
}
