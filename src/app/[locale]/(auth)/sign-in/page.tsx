import { SignInForm } from "@/components/auth/sign-in-form";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { enabledSocialProviders } from "@/lib/auth";
import { resolveOrganizationByIdentifier } from "@/lib/org-lookup.server";
import { getSafeReturnToInLocale } from "@/lib/safe-return-to";

/**
 * Localized sign-in page.
 *
 * Sanitizes `returnTo` server-side and re-points it at this page's locale
 * (`getSafeReturnToInLocale`, F-35) before it becomes Better Auth's `callbackURL`.
 * The page belongs to the (auth) group so it never renders the secure
 * navigation shell.
 */
export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  const safeLocale: SupportedLocale = isSupportedLocale(locale) ? locale : "en";
  const rawReturn = typeof sp.returnTo === "string" ? sp.returnTo : null;
  const returnTo = getSafeReturnToInLocale(rawReturn, safeLocale);

  // Organization-scoped sign-in via `?org=<slug|id>`. Unknown → null, which
  // renders the plain shared screen (no error, no org-existence leak).
  const rawOrg = typeof sp.org === "string" ? sp.org : null;
  const organization = rawOrg ? await resolveOrganizationByIdentifier(rawOrg) : null;

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
