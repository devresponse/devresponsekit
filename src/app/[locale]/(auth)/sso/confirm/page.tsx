import { getTranslations } from "next-intl/server";
import { isSupportedLocale } from "@/config/i18n-config";
import { verifySsoHandoff } from "@/lib/jwt-handoff.server";
import { isValidRequestId } from "@/lib/request-id";
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

/**
 * The failure state for the `error` code `/api/sso/consume` redirects a
 * browser here with (F-85). Every other value gets the generic invalid state:
 * `invalid_token`, `missing_token`, a refused or misconfigured request, a
 * hand-edited URL, or no code at all (a token that no longer verifies here).
 */
function failureState(error: unknown): "invalid" | "expired" | "used" | "failed" | "rateLimited" {
  switch (error) {
    case "token_expired":
      return "expired";
    case "token_already_used":
      return "used";
    case "session_establishment_failed":
      return "failed";
    case "rate_limited":
      return "rateLimited";
    default:
      return "invalid";
  }
}

export default async function SsoConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const locale = isSupportedLocale(rawLocale) ? rawLocale : "en";
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : undefined;
  const t = await getTranslations({ locale, namespace: "sso.confirm" });

  // F-85: a failed consume arrives with `?error=` and no token. It shows its
  // failure state even if a token is present too, and nothing is verified.
  const email = sp.error === undefined ? await resolveEmail(token) : null;

  if (!token || !email) {
    const state = failureState(sp.error);
    // The id rides the URL, so it is shown only when it is well-formed: a
    // crafted link must not be able to put arbitrary text on this page.
    const requestId = isValidRequestId(sp.requestId) ? sp.requestId : null;
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold">{t(`${state}Title`)}</h1>
        <p className="text-muted-foreground text-sm">{t(`${state}Body`)}</p>
        {requestId ? (
          <p className="text-muted-foreground text-xs">
            {t("requestId")}: <code className="select-all">{requestId}</code>
          </p>
        ) : null}
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
          page cannot auto-submit this on a victim's behalf. The locale rides
          the action so a failure that happens before the token verifies (an
          expired one, F-85) comes back to this page in this language. */}
      <form
        method="post"
        action={`/api/sso/consume?locale=${locale}`}
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
