import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * LoggedOutPanel
 *
 * Server Component panel shown after the user completes a local sign-out
 * and is redirected to `/[locale]/logged-out`. Rendered by
 * `(public)/logged-out/page.tsx`.
 *
 * Per §2 (post-logout redirect), the user lands on the localized branded
 * logged-out page. This panel provides a sign-in link to return to the app.
 *
 * i18n: all copy comes from the `auth` and `common` message namespaces.
 */
export function LoggedOutPanel({ locale }: { locale: string }) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md items-center p-8">
      <Alert>
        <AlertTitle>{t("loggedOutTitle")}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{t("loggedOutDescription")}</p>
          {/* Link back to sign-in after logout */}
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
