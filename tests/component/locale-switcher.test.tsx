// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { renderWithIntl } from "../helpers/render-with-intl";

const replace = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/en/app/dashboard",
  useRouter: () => ({ replace }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  replace.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    for (const label of ["English", "Français", "Español", "Українська", "Português", "简体中文"]) {
      expect(within(listbox).getByText(label)).toBeInTheDocument();
    }
  });

  it("does not call the persistence API when persistAuthenticated is false", async () => {
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher current="en" />);
    await user.click(screen.getByRole("combobox", { name: /language/i }));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("Français"));

    expect(replace).toHaveBeenCalledWith("/en/app/dashboard", { locale: "fr" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the locale preference API when persistAuthenticated is true", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderWithIntl(<LocaleSwitcher current="en" persistAuthenticated />);
    await user.click(screen.getByRole("combobox", { name: /language/i }));
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByText("Українська"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/preferences/locale",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
  });
});
