// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesForm } from "@/app/[locale]/(secure)/app/account/preferences/_preferences-form";
import { DATE_FORMAT_OPTIONS } from "@/lib/account/preferences";
import { renderWithIntl } from "../helpers/render-with-intl";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh, prefetch: vi.fn() }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const render = () =>
  renderWithIntl(
    <PreferencesForm
      locales={["en", "fr"]}
      initial={{
        preferredLocale: "en",
        timeZone: "",
        dateFormat: DATE_FORMAT_OPTIONS[0]!,
        numberFormatLocale: "system",
      }}
    />,
  );

describe("PreferencesForm", () => {
  it("marks the constrained choices required (not the optional time zone)", () => {
    render();
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Date format" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Number format" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Time zone" })).not.toHaveAttribute(
      "aria-required",
    );
  });

  it("PUTs the preferences and shows the saved confirmation", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    render();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/account/preferences",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({
      preferredLocale: "en",
      timeZone: null,
      numberFormatLocale: "system",
    });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});
