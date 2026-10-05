import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { locales } from "@/config/i18n-config";
import { isLocalizedSecurePath } from "@/config/route-regions";

/**
 * §29.7.11 — switching locales must not bypass secure-route protection.
 *
 * The protection happens in `src/proxy.ts`, which checks the Better Auth
 * session cookie before deciding whether to redirect localized secure
 * paths. Which paths are secure is decided by `isLocalizedSecurePath`
 * (`src/config/route-regions.ts`). This test runs that predicate for every
 * supported locale, so a locale it stops classifying as secure fails here,
 * and checks that the proxy actually calls it with no hard-coded `/en/app`
 * comparison of its own.
 */
describe("locale switch does not bypass secure protection", () => {
  const proxySource = readFileSync(path.resolve(__dirname, "../../src/proxy.ts"), "utf8");

  it.each(locales)("classifies /%s/app/** as secure", (locale) => {
    expect(isLocalizedSecurePath(`/${locale}/app`)).toBe(true);
    expect(isLocalizedSecurePath(`/${locale}/app/dashboard`)).toBe(true);
    expect(isLocalizedSecurePath(`/${locale}/app/administrator/users`)).toBe(true);
  });

  it("does not classify non-app or unsupported-locale paths as secure", () => {
    expect(isLocalizedSecurePath("/en/sign-in")).toBe(false);
    expect(isLocalizedSecurePath("/zz/app/dashboard")).toBe(false);
  });

  it("the proxy decides secure pages with that predicate, not a hard-coded locale", () => {
    expect(proxySource).toMatch(/=\s*isLocalizedSecurePath\(pathname\)/);
    // Hard-coded "/en/app" or "/fr/app" comparisons would be a smell
    // because they could miss other locales after the next-intl rewrite.
    expect(proxySource).not.toMatch(/===\s*"\/en\/app/);
    expect(proxySource).not.toMatch(/===\s*"\/fr\/app/);
  });

  it("reads the Better Auth session cookie before allowing secure access", () => {
    expect(proxySource).toMatch(/getSessionCookie\(request\)/);
    expect(proxySource).toMatch(/if\s*\(!sessionCookie\)/);
  });

  it("preserves the original pathname+search in the returnTo parameter", () => {
    expect(proxySource).toMatch(/returnTo.*pathname.*search/s);
  });
});
