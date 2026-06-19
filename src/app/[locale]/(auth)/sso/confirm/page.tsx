import { getTranslations } from "next-intl/server";
import { isSupportedLocale } from "@/config/i18n-config";
import { verifySsoHandoff } from "@/lib/jwt-handoff.server";
import { LocaleLink } from "@/components/i18n/locale-link";

export const dynamic = "force-dynamic";

/**
 * SSO consume confirmation interstitial (P2-2).
 *
 * The SSO handoff is IdP-initiated and consumed on a (possibly different)
 * origin, so establishing the session silently on the GET would let an
 * attacker launch for their OWN account and deliver the consume URL to a
 * victim (login-CSRF / session fixation). Instead `GET /api/sso/consume`
 * verifies the token (no nonce burn) and redirects here; this page shows the
 * account being signed into and requires an explicit, same-origin POST back to
 * `/api/sso/consume` to proceed — which is trusted-origin-guarded, so a
 * cross-site page cannot auto-submit it.
 *
 * The displayed email comes from RE-VERIFYING the signed token (never a query
 * param), so it cannot be spoofed to make a foreign account look familiar.
 */
async function resolveEmail(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const audiencePrefix = process.env.SSO_HANDOFF_AUDIENCE_PREFIX;
  const applicationId = process.env.SSO_HANDOFF_APPLICATION_ID;
  if (!audiencePrefix || !applicationId) return null;
  try {
    const verified = await verifySsoHandoff({
      token,
      expectedAudience: `${audiencePrefix}:${applicationId}`,
    });
    return typeof verified.payload.email === "string" ? verified.payload.email : null;
  } catch {
    return null;
  }
}

export default async function SsoConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const { token } = await searchParams;
  const t = await getTranslations({ locale, namespace: "sso.confirm" });

  const email = await resolveEmail(token);

  if (!token || !email) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold">{t("invalidTitle")}</h1>
        <p className="text-muted-foreground text-sm">{t("invalidBody")}</p>
        <LocaleLink
          href="/sign-in"
          className="text-sm underline-offset-4 hover:underline"
          locale={locale}
        >
          {t("backToSignIn")}
        </LocaleLink>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-sm">{t("body", { email })}</p>
      </div>
      {/* Plain same-origin form POST: the browser sends the consumer's Origin,
          which the POST handler's trusted-origin check requires — a cross-site
          page cannot auto-submit this on a victim's behalf. */}
      <form
        method="post"
        action="/api/sso/consume"
        className="flex w-full flex-col items-center gap-3"
      >
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors"
        >
          {t("continue")}
        </button>
      </form>
      <LocaleLink
        href="/sign-in"
        className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        locale={locale}
      >
        {t("cancel")}
      </LocaleLink>
    </main>
  );
}
