import { SignInForm } from "@/components/auth/sign-in-form";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { enabledSocialProviders } from "@/lib/auth";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Organization-scoped sign-in: `/sign-in/<org>` where `<org>` is a slug or id.
 *
 * A shared login screen pinned to one organization — it brands the screen and,
 * after login, pins the active org for an existing member (and carries the
 * scope onto sign-up). Mirrors `/sign-in?org=<slug>`; both resolve through the
 * same helper. An unknown identifier renders the plain sign-in screen (no
 * error, no org-existence leak), so the segment is always safe.
 */
export default async function ScopedSignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, org } = await params;
  const sp = await searchParams;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  const rawReturn = typeof sp.returnTo === "string" ? sp.returnTo : null;
  const returnTo = getSafeReturnTo(rawReturn, safeLocale);
  const organization = await resolveOrganizationByIdentifier(org);

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-4 p-8">
      <div className="self-end">
        <LocaleSwitcher current={safeLocale} />
      </div>
      <SignInForm
        locale={safeLocale}
        returnTo={returnTo}
        socialProviders={enabledSocialProviders}
        organization={organization}
      />
    </main>
  );
}
