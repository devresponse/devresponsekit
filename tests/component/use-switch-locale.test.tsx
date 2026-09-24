// @vitest-environment jsdom
import type * as NextNavigation from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { localeSwitchHref, useSwitchLocale } from "@/components/i18n/use-switch-locale";

/**
 * `useSwitchLocale` (F-35) — the one locale-switch implementation behind
 * `LocaleSwitcher` and `LanguageMenu`.
 *
 * Only Next's own router is faked here: `@/i18n/navigation` is the REAL
 * next-intl `createNavigation(routing)`, so every assertion is on the final
 * href Next receives, after next-intl has prefixed the new locale onto the
 * unprefixed href the hook builds. The invariant: that href is the browser's
 * current URL with ONLY the locale segment changed. Before F-35 the query and
 * fragment were dropped, so `/en/invite?token=…` became `/fr/invite`.
 */

let mockNextPathname = "/en";
const nextReplace = vi.fn();
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  // Next reports the pathname WITH the locale prefix; next-intl strips it.
  usePathname: () => mockNextPathname,
  useRouter: () => ({
    replace: nextReplace,
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

/** Puts the browser on `url` and renders the hook there. */
function renderAt(url: string, options?: Parameters<typeof useSwitchLocale>[0]) {
  window.history.replaceState(null, "", url);
  mockNextPathname = window.location.pathname;
  return renderHook(() => useSwitchLocale(options), { wrapper });
}

beforeEach(() => {
  nextReplace.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("useSwitchLocale — the href Next receives (F-35)", () => {
  it.each([
    ["/en/invite?token=example-invite-token", "/fr/invite?token=example-invite-token"],
    [
      "/en/sign-up?invite=example-invite-token&org=acme",
      "/fr/sign-up?invite=example-invite-token&org=acme",
    ],
    [
      "/en/sign-in?returnTo=%2Fen%2Fsso%2Flaunch%3FapplicationId%3Dportal%26locale%3Den",
      "/fr/sign-in?returnTo=%2Fen%2Fsso%2Flaunch%3FapplicationId%3Dportal%26locale%3Den",
    ],
    [
      "/en/sign-in?returnTo=/en/sso/launch?applicationId=portal&locale=en",
      "/fr/sign-in?returnTo=/en/sso/launch?applicationId=portal&locale=en",
    ],
    [
      "/en/app/administrator/users?page=3&filter[status]=blocked&filter[status]=active",
      "/fr/app/administrator/users?page=3&filter[status]=blocked&filter[status]=active",
    ],
    [
      "/en/app/docs/getting-started?tab=api#install",
      "/fr/app/docs/getting-started?tab=api#install",
    ],
    ["/en/app/dashboard#main", "/fr/app/dashboard#main"],
    ["/en/app/dashboard", "/fr/app/dashboard"],
    // The locale root: next-intl folds "/" into the prefix, so none of these
    // may come out with a trailing slash ("/fr/", "/fr/#main").
    ["/en", "/fr"],
    ["/en?returnTo=%2Fen%2Fapp", "/fr?returnTo=%2Fen%2Fapp"],
    ["/en#main", "/fr#main"],
    ["/en?x=1#main", "/fr?x=1#main"],
  ])("%s → %s", (from, to) => {
    const { result } = renderAt(from);
    act(() => result.current.switchLocale("fr"));
    expect(nextReplace).toHaveBeenCalledTimes(1);
    expect(nextReplace).toHaveBeenCalledWith(to);
  });

  it("keeps a lookalike off-site value inside the query: the destination stays the same page", () => {
    const { result } = renderAt("/en/sign-in?returnTo=//evil.example/x&next=https://evil.example");
    act(() => result.current.switchLocale("uk"));
    expect(nextReplace).toHaveBeenCalledWith(
      "/uk/sign-in?returnTo=//evil.example/x&next=https://evil.example",
    );
  });

  it("property: only the locale segment of the current URL changes", () => {
    const paths = fc.constantFrom(
      "/en",
      "/en/invite",
      "/en/sign-in",
      "/en/app/administrator/users",
    );
    // Arbitrary text — the URL parser decides how it serializes; the hook
    // must hand over whatever `location` says, unchanged.
    const piece = fc.string({ maxLength: 24 });
    fc.assert(
      fc.property(paths, piece, piece, (path, query, fragment) => {
        const { result, unmount } = renderAt(`${path}?${query}#${fragment}`);
        nextReplace.mockReset();
        act(() => result.current.switchLocale("ja"));
        const { pathname, search, hash } = window.location;
        expect(nextReplace).toHaveBeenCalledWith(
          `${pathname.replace(/^\/en(?=\/|$)/, "/ja")}${search}${hash}`,
        );
        unmount();
      }),
      { numRuns: 200 },
    );
  });
});

describe("useSwitchLocale — guard and persistence", () => {
  it("ignores a value that is not a supported locale", () => {
    const { result } = renderAt("/en/invite?token=abc", { persistAuthenticated: true });
    act(() => result.current.switchLocale("xx"));
    expect(nextReplace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not persist the choice by default", () => {
    const { result } = renderAt("/en/sign-in");
    act(() => result.current.switchLocale("es"));
    expect(nextReplace).toHaveBeenCalledWith("/es/sign-in");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the choice to the locale preference API when persistAuthenticated is set", () => {
    const { result } = renderAt("/en/app/dashboard", { persistAuthenticated: true });
    act(() => result.current.switchLocale("uk"));
    expect(fetchMock).toHaveBeenCalledWith("/api/preferences/locale", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale: "uk" }),
    });
  });
});

describe("localeSwitchHref", () => {
  it.each([
    ["/invite", "?token=a", "", "/invite?token=a"],
    ["/app/docs/x", "", "#install", "/app/docs/x#install"],
    ["/app/docs/x", "?tab=1", "#install", "/app/docs/x?tab=1#install"],
    ["/", "", "", "/"],
    ["/", "?q=1", "", "/?q=1"],
    ["/", "", "#main", "#main"],
    ["/", "?q=1", "#main", "/?q=1#main"],
  ])("(%s, %s, %s) → %s", (pathname, search, hash, expected) => {
    expect(localeSwitchHref(pathname, search, hash)).toBe(expected);
  });
});
