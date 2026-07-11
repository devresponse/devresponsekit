// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailTemplateFilters } from "@/app/[locale]/(secure)/app/administrator/email/templates/_template-filters";
import { renderWithIntl } from "../helpers/render-with-intl";

/**
 * The Email Templates page filters write the chosen template type (`key`)
 * and `locale` to the URL query (the page reads them and narrows the DB
 * query). These tests pin that contract: both selects always offer "All",
 * changing one navigates with the param set while preserving the other,
 * and picking "All" clears the param — never dropping sibling params.
 */
const replace = vi.fn();
const PATHNAME = "/en/app/administrator/email/templates";
let currentParams = new URLSearchParams("");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => PATHNAME,
  useSearchParams: () => currentParams,
}));

const KEYS = ["email_verification", "organization_invitation", "password_reset"];
const LOCALES = ["en", "es", "fr"];

function renderFilters(props?: { activeKey?: string | null; activeLocale?: string | null }) {
  return renderWithIntl(
    <EmailTemplateFilters
      keyOptions={KEYS}
      localeOptions={LOCALES}
      activeKey={props?.activeKey ?? null}
      activeLocale={props?.activeLocale ?? null}
    />,
  );
}

const keySelect = () => screen.getByRole("combobox", { name: /Filter by Template type/i });
const localeSelect = () => screen.getByRole("combobox", { name: /Filter by Locale/i });

beforeEach(() => {
  replace.mockReset();
  currentParams = new URLSearchParams("");
});
afterEach(() => vi.clearAllMocks());

describe("EmailTemplateFilters", () => {
  it("renders both selects, each with an 'All' option first, defaulting to All", () => {
    renderFilters();
    const keyOpts = Array.from(keySelect().querySelectorAll("option")).map((o) => o.textContent);
    const localeOpts = Array.from(localeSelect().querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(keyOpts).toEqual(["All", ...KEYS]);
    // Locale codes are shown uppercased, matching the grid's Locale column.
    expect(localeOpts).toEqual(["All", "EN", "ES", "FR"]);
    expect((keySelect() as HTMLSelectElement).value).toBe("__all__");
    expect((localeSelect() as HTMLSelectElement).value).toBe("__all__");
  });

  it("reflects the active filter values selected in the URL", () => {
    renderFilters({ activeKey: "password_reset", activeLocale: "es" });
    expect((keySelect() as HTMLSelectElement).value).toBe("password_reset");
    expect((localeSelect() as HTMLSelectElement).value).toBe("es");
  });

  it("navigates with ?key set when a template type is chosen", async () => {
    const user = userEvent.setup();
    renderFilters();
    await user.selectOptions(keySelect(), "organization_invitation");
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?key=organization_invitation`);
  });

  it("navigates with ?locale set (lowercase code) when a locale is chosen", async () => {
    const user = userEvent.setup();
    renderFilters();
    await user.selectOptions(localeSelect(), "FR");
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?locale=fr`);
  });

  it("preserves an existing param when the other filter changes", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("locale=en");
    renderFilters({ activeLocale: "en" });
    await user.selectOptions(keySelect(), "password_reset");
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?locale=en&key=password_reset`);
  });

  it("clears only its own param when 'All' is chosen", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("key=password_reset&locale=en");
    renderFilters({ activeKey: "password_reset", activeLocale: "en" });
    await user.selectOptions(keySelect(), "__all__");
    expect(replace).toHaveBeenCalledWith(`${PATHNAME}?locale=en`);
  });

  it("navigates to a bare pathname when the last filter is cleared", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("locale=en");
    renderFilters({ activeLocale: "en" });
    await user.selectOptions(localeSelect(), "__all__");
    expect(replace).toHaveBeenCalledWith(PATHNAME);
  });
});
