import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";

/**
 * The SSO confirm page's failure states (F-85).
 *
 * `/api/sso/consume` used to answer a failed handoff with bare JSON even when
 * the caller was a person's browser, so someone who read this page for longer
 * than the token lives and then clicked Continue landed on
 * `{"error":"token_already_used"}` with no way back. The route now redirects a
 * browser here with `?error=<code>&requestId=<id>`, and this page names the
 * failure in the visitor's language and shows the id support can trace.
 */
const getTranslations = vi.fn();
vi.mock("next-intl/server", () => ({
  getTranslations: (...a: unknown[]) => getTranslations(...a),
}));
const verifyMock = vi.fn();
vi.mock("@/lib/jwt-handoff.server", () => ({
  verifySsoHandoff: (...a: unknown[]) => verifyMock(...a),
}));
vi.mock("@/components/i18n/locale-link", () => ({
  LocaleLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const REQUEST_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

async function render(query: Record<string, string>, locale = "uk"): Promise<string> {
  const { default: SsoConfirmPage } = await import("@/app/[locale]/(auth)/sso/confirm/page");
  return renderToStaticMarkup(
    await SsoConfirmPage({
      params: Promise.resolve({ locale }),
      searchParams: Promise.resolve(query),
    }),
  );
}

beforeEach(() => {
  getTranslations.mockReset();
  getTranslations.mockImplementation(({ namespace }: { namespace: string }) =>
    Promise.resolve((key: string) => `${namespace}.${key}`),
  );
  verifyMock.mockReset();
  vi.stubEnv("SSO_HANDOFF_AUDIENCE_PREFIX", "devresponse-app");
  vi.stubEnv("SSO_HANDOFF_APPLICATION_ID", "portal");
});
afterEach(() => vi.unstubAllEnvs());

describe("SSO confirm page — failure states (F-85)", () => {
  it.each([
    ["token_expired", "expired"],
    ["token_already_used", "used"],
    ["session_establishment_failed", "failed"],
    ["rate_limited", "rateLimited"],
  ])("?error=%s renders the %s state with the request id, and no form", async (error, state) => {
    const html = await render({ error, requestId: REQUEST_ID });
    expect(getTranslations).toHaveBeenCalledWith({ locale: "uk", namespace: "sso.confirm" });
    expect(html).toContain(`sso.confirm.${state}Title`);
    expect(html).toContain(`sso.confirm.${state}Body`);
    expect(html).toContain("sso.confirm.requestId");
    expect(html).toContain(REQUEST_ID);
    expect(html).toContain("sso.confirm.backToSignIn");
    expect(html).not.toContain("<form");
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it.each(["invalid_token", "missing_token", "forbidden", "constructor", "toString"])(
    "?error=%s falls back to the generic invalid state",
    async (error) => {
      const html = await render({ error });
      expect(html).toContain("sso.confirm.invalidTitle");
      expect(html).toContain("sso.confirm.invalidBody");
      expect(html).not.toContain("<form");
    },
  );

  it("an error wins over a token that still verifies: no form, nothing verified", async () => {
    verifyMock.mockResolvedValue({ payload: { email: "u@x.com" } });
    const html = await render({ error: "token_already_used", token: "abc" });
    expect(html).toContain("sso.confirm.usedTitle");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("u@x.com");
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("shows the request id only when it is well-formed", async () => {
    const html = await render({
      error: "token_expired",
      requestId: "Call 555-0100 to restore access",
    });
    expect(html).toContain("sso.confirm.expiredTitle");
    expect(html).not.toContain("555-0100");
    expect(html).not.toContain("sso.confirm.requestId");
  });

  it("a token that no longer verifies here still gets the generic invalid state", async () => {
    verifyMock.mockRejectedValue(new Error('"exp" claim timestamp check failed'));
    const html = await render({ token: "abc" });
    expect(html).toContain("sso.confirm.invalidTitle");
    expect(html).not.toContain("<form");
  });

  it("the confirm form posts with its locale, so a failure comes back in that language", async () => {
    verifyMock.mockResolvedValue({ payload: { email: "u@x.com" } });
    const html = await render({ token: "abc" }, "uk");
    expect(html).toContain('action="/api/sso/consume?locale=uk"');
    expect(html).toContain('name="token" value="abc"');
  });

  it("every state the page can render has its title and body in the catalog", () => {
    // The page builds `${state}Title` / `${state}Body`; the parity test then
    // carries these keys to the other seven locales.
    for (const state of ["invalid", "expired", "used", "failed", "rateLimited"]) {
      expect(en.sso.confirm).toHaveProperty(`${state}Title`);
      expect(en.sso.confirm).toHaveProperty(`${state}Body`);
    }
    expect(en.sso.confirm).toHaveProperty("requestId");
  });
});
