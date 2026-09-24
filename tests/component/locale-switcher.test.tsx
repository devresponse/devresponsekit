// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { renderWithIntl } from "../helpers/render-with-intl";

// next-intl's `usePathname` reports the path WITHOUT the locale prefix; the
// query string and fragment come from the browser's own location.
let mockPathname = "/app/dashboard";
const replace = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  mockPathname = "/app/dashboard";
  window.history.replaceState(null, "", "/en/app/dashboard");
  replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function chooseLocale(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: /language/i }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByText(label));
}

describe("LocaleSwitcher", () => {
  it("renders an accessible select labelled 'Language'", () => {
    renderWithIntl(<LocaleSwitcher current="en" />);
    expect(screen.getByRole("combobox", { name: /language/i })).toBeInTheDocument();
  });

  it("offers every supported locale label", async () => {
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher current="en" />);
    await user.click(screen.getByRole("combobox", { name: /language/i }));

    const listbox = await screen.findByRole("listbox");
    for (const label of [
      "English",
      "Français",
      "Español",
      "Українська",
      "Português",
      "简体中文",
      "हिन्दी",
      "日本語",
    ]) {
      expect(within(listbox).getByText(label)).toBeInTheDocument();
    }
  });

  it("does not call the persistence API when persistAuthenticated is false", async () => {
    renderWithIntl(<LocaleSwitcher current="en" />);
    await chooseLocale("Français");

    expect(replace).toHaveBeenCalledWith("/app/dashboard", { locale: "fr" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the locale preference API when persistAuthenticated is true", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    renderWithIntl(<LocaleSwitcher current="en" persistAuthenticated />);
    await chooseLocale("Українська");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preferences/locale",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
  });

  // F-35: the switch used to replace with the bare pathname, so every one of
  // these lost its query. Each case asserts the replace target byte-for-byte:
  // a parse + re-serialize (URLSearchParams / next-intl's `query` object)
  // would encode brackets, turn `%20` into `+`, or escape a raw returnTo.
  describe("keeps the query string and fragment (F-35)", () => {
    it.each([
      {
        name: "an invitation accept link's token",
        pathname: "/invite",
        url: "/en/invite?token=example-invite-token",
      },
      {
        name: "an invited sign-up's token and an org scope",
        pathname: "/sign-up",
        url: "/en/sign-up?invite=example-invite-token&org=acme",
      },
      {
        name: "an encoded returnTo carrying the SSO launch continuation",
        pathname: "/sign-in",
        url: "/en/sign-in?returnTo=%2Fen%2Fsso%2Flaunch%3FapplicationId%3Dportal%26locale%3Den",
      },
      {
        name: "a raw returnTo whose slashes and '?' stay unescaped",
        pathname: "/sign-in",
        url: "/en/sign-in?returnTo=/en/sso/launch?applicationId=portal&locale=en",
      },
      {
        name: "repeated filter keys with literal brackets (F-34)",
        pathname: "/app/administrator/users",
        url: "/en/app/administrator/users?page=3&filter[status]=blocked&filter[status]=active",
      },
      {
        name: "percent-encoded and plus-encoded spaces as written",
        pathname: "/app/administrator/users",
        url: "/en/app/administrator/users?q=jane%20doe+smith&sort=-createdAt",
      },
      {
        name: "a query and a fragment",
        pathname: "/app/docs/getting-started",
        url: "/en/app/docs/getting-started?tab=api#install",
      },
    ])("$name", async ({ pathname, url }) => {
      mockPathname = pathname;
      window.history.replaceState(null, "", url);
      renderWithIntl(<LocaleSwitcher current="en" />);
      await chooseLocale("Français");

      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith(url.replace(/^\/en/, ""), { locale: "fr" });
    });

    it("reads the query when the user switches, not when the switcher rendered", async () => {
      mockPathname = "/app/administrator/users";
      window.history.replaceState(null, "", "/en/app/administrator/users?page=1");
      renderWithIntl(<LocaleSwitcher current="en" />);

      // The grid rewrites its own query in place after the shell rendered.
      window.history.replaceState(null, "", "/en/app/administrator/users?page=4&q=ops");
      await chooseLocale("Español");

      expect(replace).toHaveBeenCalledWith("/app/administrator/users?page=4&q=ops", {
        locale: "es",
      });
    });
  });
});
