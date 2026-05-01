import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { defaultLocale, isSupportedLocale } from "@/config/i18n-config";
import { isLocalizedSecurePath } from "@/config/route-regions";

const intlMiddleware = createIntlMiddleware(routing);

function getLocaleFromPath(pathname: string): string {
  const locale = pathname.split("/")[1] ?? "";
  return isSupportedLocale(locale) ? locale : defaultLocale;
}

/**
 * proxy
 *
 * Combines two concerns:
 *   1. next-intl locale routing (rewrites `/` to `/<defaultLocale>` and
 *      validates the locale segment).
 *   2. Early redirect for localized secure browser paths
 *      (`isLocalizedSecurePath`, classified by `route-regions.ts`) when
 *      no Better Auth session cookie is present, so unauthenticated
 *      users never see the secure layout shell flash.
 *
 * This is NOT the authorization boundary — it intentionally avoids any
 * database calls. The real check happens in `requireSecureSession`.
 *
 * Note: the file is named `proxy.ts` per Next.js 16. Only `proxy` is
 * exported — defining a `middleware` alias in the same file is
 * forbidden by Next.js 16 and would fail the build.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  // API routes are excluded by the matcher, but defend in depth.
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (isLocalizedSecurePath(pathname)) {
    const sessionCookie = getSessionCookie(request);
    if (!sessionCookie) {
      const locale = getLocaleFromPath(pathname);
      const url = new URL(`/${locale}/sign-in`, request.url);
      url.searchParams.set("returnTo", `${pathname}${search}`);
      return NextResponse.redirect(url);
    }
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
