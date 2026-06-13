import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { requireSecureSession } from "@/lib/auth-guard";
import { getAccountProfile } from "../_data.server";
import { ProfileForm } from "./_profile-form";

export const dynamic = "force-dynamic";

/**
 * /[locale]/app/account/profile
 *
 * Edit the caller's profile (display name + Better Auth name). Email is
 * shown read-only — changing it is a verified Better Auth flow reserved
 * for a future iteration. Scoped to `access.appUserId` / the session
 * user; no id ever comes from the client.
 */
export default async function AccountProfilePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale: SupportedLocale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { session, access } = await requireSecureSession(locale, `/${locale}/app/account/profile`);

  if (!access.appUserId) notFound();
  const profile = await getAccountProfile(access.appUserId, session.user.id);
  if (!profile) notFound();

  const t = await getTranslations({ locale, namespace: "account" });

  return (
    <section className="space-y-4 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("sections.profile.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("sections.profile.description")}</p>
      </div>

      <ProfileForm
        initial={{
          displayName: profile.displayName ?? "",
          name: profile.name ?? "",
          email: profile.primaryEmail,
        }}
      />
    </section>
  );
}
