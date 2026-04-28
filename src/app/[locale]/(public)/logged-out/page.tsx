import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isSupportedLocale } from "@/config/i18n-config";

/**
 * Localized logged-out page.
 *
 * Reached by `SignOutButton` after the local-only sign-out completes.
 * Lives under the (public) group so it never re-engages the secure
 * shell or hits secure menu APIs.
 */
export default async function LoggedOutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const safeLocale = isSupportedLocale(locale) ? locale : "en";
  return <Body locale={safeLocale} />;
}

function Body({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Alert>
        <AlertTitle>{t("loggedOutTitle")}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{t("loggedOutDescription")}</p>
          <LocaleLink
            href="/sign-in"
            locale={locale}
            className="border-shell-border hover:bg-shell-muted inline-block rounded-md border px-3 py-1.5 text-sm"
          >
            {tCommon("signIn")}
          </LocaleLink>
        </AlertDescription>
      </Alert>
    </main>
  );
}
