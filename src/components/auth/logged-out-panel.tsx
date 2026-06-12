import { useTranslations } from "next-intl";
import { LocaleLink } from "@/components/i18n/locale-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export interface LoggedOutPanelProps {
  /** Locale used to build the localized "sign in" link. */
  locale: string;
  className?: string;
}

/**
 * LoggedOutPanel
 *
 * Server-compatible panel rendered by the localized `/logged-out` page
 * after `SignOutButton` completes the local-only sign-out. Lives under
 * the `(public)` route group so it never re-engages the secure shell or
 * hits secure menu APIs (spec §10).
 */
export function LoggedOutPanel({ locale, className }: LoggedOutPanelProps) {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  return (
    <Alert className={className}>
      <AlertTitle>{t("loggedOutTitle")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t("loggedOutDescription")}</p>
        <LocaleLink
          href="/sign-in"
          locale={locale}
          className="border-border hover:bg-muted inline-block rounded-md border px-3 py-1.5 text-sm"
        >
          {tCommon("signIn")}
        </LocaleLink>
      </AlertDescription>
    </Alert>
  );
}
