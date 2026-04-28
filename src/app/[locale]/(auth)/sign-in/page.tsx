import { SignInForm } from "@/components/auth/sign-in-form";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { isSupportedLocale, type SupportedLocale } from "@/config/i18n-config";
import { getSafeReturnTo } from "@/lib/safe-return-to";

/**
 * Localized sign-in page.
 *
 * Sanitizes `returnTo` server-side via `getSafeReturnTo` so the value
 * passed to Better Auth's `callbackURL` cannot trigger an open redirect.
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
  const returnTo = getSafeReturnTo(rawReturn, safeLocale);

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-4 p-8">
      <div className="self-end">
        <LocaleSwitcher current={safeLocale} />
      </div>
      <SignInForm locale={safeLocale} returnTo={returnTo} />
    </main>
  );
}
