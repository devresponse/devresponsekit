import { redirect } from "next/navigation";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { buildSsoLaunchApiPath } from "@/lib/sso-launch-return";

export const dynamic = "force-dynamic";

/**
 * SSO launch trampoline — the signed-out continuation target.
 *
 * `/api/sso/launch` sends an unauthenticated visitor to sign-in with
 * `?returnTo=/{locale}/sso/launch?applicationId=…`, and Better Auth navigates
 * here once they authenticate. This page exists only because that return target
 * cannot be the API route itself: `getSafeReturnTo` deliberately refuses
 * `/api/` values, a rule its security tests pin, so the continuation goes
 * through a page the sanitizer already accepts and this page forwards to the
 * real endpoint. See `@/lib/sso-launch-return` for the full reasoning.
 *
 * Three invariants, each load-bearing:
 *
 *   1. It renders NOTHING and only redirects. No markup means no message keys,
 *      so it cannot drift out of parity across the eight locale catalogs, and
 *      the visitor sees no flash of an interstitial they did not ask for.
 *   2. It reads NO session and makes NO authorization decision. Every check —
 *      session, impersonation, signing key, application status, organization
 *      scope — belongs to `/api/sso/launch` and `createSsoHandoffRedirect`. A
 *      gate here could only re-implement a weaker copy of that ladder, and a
 *      partial check that reads like a gate is worse than no gate. Arriving
 *      here signed out is not an error: the forward bounces off the API route
 *      back to sign-in, which is the deep-link path working as intended.
 *   3. It must never gain a `loading.tsx` or `template.tsx` sibling. Streaming
 *      downgrades a server `redirect()` into a client-side meta refresh, which
 *      would add a visible flash and a spurious history entry to a hop the user
 *      should never notice.
 *
 * Invalid or missing parameters degrade to the dashboard rather than raising:
 * this path is publicly reachable (`/{locale}/sso/*` is classified public), so
 * a hand-crafted URL must not produce an error page or a stack trace. Nothing
 * from the query string reaches the destination path — the builder
 * reconstructs it from validated parts.
 */
export default async function SsoLaunchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  const safeLocale = isSupportedLocale(locale) ? locale : defaultLocale;

  // The query locale wins when valid (it is what the launch route round-trips),
  // falling back to the path locale so a hand-trimmed URL still lands somewhere
  // sensible.
  const target = buildSsoLaunchApiPath(sp.applicationId, sp.locale ?? safeLocale);
  redirect(target ?? `/${safeLocale}/app/dashboard`);
}
