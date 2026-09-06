// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { PreferencesForm } from "@/app/[locale]/(secure)/app/account/preferences/_preferences-form";
import { DATE_FORMAT_OPTIONS } from "@/lib/account/preferences";
import { renderWithIntl } from "../helpers/render-with-intl";
import { TEST_MESSAGES } from "../helpers/test-data-factories";

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

const render = (timeZone = "") =>
  renderWithIntl(
    <PreferencesForm
      locales={["en", "fr"]}
      initial={{
        preferredLocale: "en",
        timeZone,
        dateFormat: DATE_FORMAT_OPTIONS[0]!,
        numberFormatLocale: "system",
      }}
    />,
  );

/**
 * The option list the component would render on the SERVER: React Hook
 * Form and `useHydrated` both report their server snapshot, so this is the
 * markup the browser receives before hydration.
 */
function serverRenderedTimeZoneOptions(timeZone: string): string[] {
  const html = renderToString(
    <NextIntlClientProvider locale="en" messages={TEST_MESSAGES} timeZone="UTC">
      <PreferencesForm
        locales={["en", "fr"]}
        initial={{
          preferredLocale: "en",
          timeZone,
          dateFormat: DATE_FORMAT_OPTIONS[0]!,
          numberFormatLocale: "system",
        }}
      />
    </NextIntlClientProvider>,
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const select = [...doc.querySelectorAll("select")].find((s) => s.name === "timeZone")!;
  return [...select.options].map((o) => o.value);
}

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

  /**
   * Review #108 — the zone list came from `Intl.supportedValuesOf` on BOTH
   * sides. The Node server and the browser routinely carry different tzdata
   * revisions, so the two renders disagreed on the option list under
   * identical markup. The server render must now be deterministic: the
   * "system" option plus the STORED zone, which arrived as a prop.
   */
  it("renders a deterministic, prop-derived time-zone list on the server", () => {
    expect(serverRenderedTimeZoneOptions("")).toEqual([""]);
    expect(serverRenderedTimeZoneOptions("Europe/Kyiv")).toEqual(["", "Europe/Kyiv"]);
    // A zone the runtime no longer enumerates (a renamed alias) survives as
    // itself rather than collapsing to "System".
    expect(serverRenderedTimeZoneOptions("Asia/Calcutta")).toEqual(["", "Asia/Calcutta"]);
  });

  it("adds the runtime's full zone list only after hydration, keeping the stored value selected", () => {
    render("Europe/Kyiv");
    const select = screen.getByRole("combobox", { name: "Time zone" }) as HTMLSelectElement;
    // Client render (post-hydration): the full list is present...
    expect(select.options.length).toBeGreaterThan(2);
    // ...with no duplicate of the stored value, which stays selected.
    const values = [...select.options].map((o) => o.value);
    expect(values.filter((v) => v === "Europe/Kyiv")).toHaveLength(1);
    expect(select.value).toBe("Europe/Kyiv");
  });

  /** Review #103 — "Cancel" was `router.refresh()`, a no-op for RHF state. */
  it("Cancel restores the server-supplied values", async () => {
    const user = userEvent.setup();
    render();
    const dateFormat = screen.getByRole("combobox", { name: "Date format" }) as HTMLSelectElement;
    await user.selectOptions(dateFormat, "iso8601");
    expect(dateFormat.value).toBe("iso8601");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(dateFormat.value).toBe(DATE_FORMAT_OPTIONS[0]);
    expect(refresh).toHaveBeenCalled();
  });

  it("Cancel clears the sticky saved notice", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    render();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
