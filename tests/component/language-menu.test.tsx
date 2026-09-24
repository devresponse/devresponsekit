// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageMenu } from "@/components/i18n/language-menu";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * `LanguageMenu` is not mounted by the app, but it ships as a ready-made
 * picker and used to carry its own copy of the switch logic — with the same
 * query-dropping bug as `LocaleSwitcher` (F-35). These pin that it goes
 * through the shared `useSwitchLocale` behaviour.
 */

let mockPathname = "/invite";
const replace = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  mockPathname = "/invite";
  window.history.replaceState(null, "", "/en/invite?token=example-invite-token");
  replace.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

async function pick(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /language: english/i }));
  await user.click(await screen.findByRole("menuitemradio", { name: label }));
}

describe("LanguageMenu", () => {
  it("keeps the query string when switching locale (F-35)", async () => {
    renderWithIntl(<LanguageMenu current="en" />);
    await pick("Français");

    expect(replace).toHaveBeenCalledWith("/invite?token=example-invite-token", { locale: "fr" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the current locale is picked again", async () => {
    renderWithIntl(<LanguageMenu current="en" persistAuthenticated />);
    await pick("English");

    expect(replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists the choice when persistAuthenticated is set", async () => {
    renderWithIntl(<LanguageMenu current="en" persistAuthenticated />);
    await pick("Українська");

    expect(replace).toHaveBeenCalledWith("/invite?token=example-invite-token", { locale: "uk" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preferences/locale",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ locale: "uk" }) }),
    );
  });
});
