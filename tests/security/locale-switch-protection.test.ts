import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * §29.7.11 — switching locales must not bypass secure-route protection.
 *
 * The protection happens in `src/proxy.ts`, which checks the Better Auth
 * session cookie before deciding whether to redirect localized secure
 * paths. This test verifies the proxy treats every supported locale
 * identically by inspecting the source for the `isLocalizedSecurePath`
 * predicate and confirming it consults `isSupportedLocale` rather than
 * hard-coding `/en/app`.
 */
describe("locale switch does not bypass secure protection", () => {
  const proxySource = readFileSync(path.resolve(__dirname, "../../src/proxy.ts"), "utf8");

  it("uses the shared isSupportedLocale guard for the secure-path check", () => {
    expect(proxySource).toMatch(/isLocalizedSecurePath/);
    expect(proxySource).toMatch(/isSupportedLocale\(locale\)/);
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
